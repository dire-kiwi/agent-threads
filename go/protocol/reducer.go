package protocol

import (
	"bytes"
	"encoding/json"
	"slices"
)

// A thread's state, folded from its events, by the rules in spec/PROTOCOL.md ("Applying events"):
// the same as applyEvent in @dire-kiwi/agent-threads-protocol.
//
// ApplyEvent never changes the state it's given: an event that changes an item or request puts a
// new one in a new slice, and leaves the others as they were. An event that changes nothing
// returns the state as it was.

// deltaItemType is the type of item a delta of each kind streams into.
var deltaItemType = map[DeltaEventKind]string{DeltaEventKindText: "assistant_message", DeltaEventKindReasoning: "reasoning"}

// InitialState is a thread's state before any of its events.
func InitialState(thread Thread) Snapshot {
	return Snapshot{Thread: thread, Items: []Item{}, Requests: []ThreadRequest{}}
}

// ApplyEvent is the state after event. Events for another thread, and saved events the state
// already has (their seq is at or below the state's, e.g. replayed after a reconnect), change
// nothing.
func ApplyEvent(state Snapshot, event ThreadEvent) Snapshot {
	if event.ThreadID() != state.Thread.ID {
		return state
	}
	if d, ok := event.Value.(*DeltaEvent); ok {
		// A delta from before the last saved event the state has is already in it.
		if d.Seq < state.Seq || d.Text == "" {
			return state
		}
		return withItem(state, d.ItemID, func(item Item) (Item, bool) {
			text, ok := item.Text()
			if !ok || item.Type() != deltaItemType[d.Kind] {
				return item, false
			}
			// The text from offset on. Some of it may be in already (a snapshot taken after the
			// delta was sent has it), and the rest is appended. Past the end of the text means
			// deltas were missed: it's skipped, and the item's final text puts it right.
			have := TextLen(text) - d.Offset
			if have < 0 || have >= TextLen(d.Text) {
				return item, false
			}
			return withText(item, text+textFrom(d.Text, have)), true
		})
	}
	if event.Seq() <= state.Seq {
		return state
	}
	next := apply(state, event)
	next.Seq = event.Seq()
	return next
}

// ApplyEvents is the state after each of events in turn.
func ApplyEvents(state Snapshot, events []ThreadEvent) Snapshot {
	for _, e := range events {
		state = ApplyEvent(state, e)
	}
	return state
}

// OpenRequests is the state's requests that are open: those not resolved yet, oldest first.
func OpenRequests(state Snapshot) []ThreadRequest {
	out := []ThreadRequest{}
	for _, r := range state.Requests {
		if r.Resolution() == nil {
			out = append(out, r)
		}
	}
	return out
}

// IsGap says whether event shows that saved events before it were missed: it's saved, and its seq
// is more than one past the state's. A client that sees one should catch up from state.Seq, or
// take a fresh snapshot, rather than apply it.
func IsGap(state Snapshot, event ThreadEvent) bool {
	return event.Saved() && event.ThreadID() == state.Thread.ID && event.Seq() > state.Seq+1
}

func apply(state Snapshot, event ThreadEvent) Snapshot {
	switch e := event.Value.(type) {
	case *ThreadUpdatedEvent:
		state.Thread = e.Thread
	case *ItemAddedEvent:
		if at := indexOfItem(state.Items, e.Item.ID()); at >= 0 {
			state.Items = replaced(state.Items, at, e.Item)
		} else {
			state.Items = append(slices.Clip(state.Items), e.Item)
		}
	case *ItemUpdatedEvent:
		return withItem(state, e.ItemID, func(item Item) (Item, bool) { return Patched(item, e.Patch) })
	case *ItemsRemovedEvent:
		gone := make(map[string]bool, len(e.ItemIDs))
		for _, id := range e.ItemIDs {
			gone[id] = true
		}
		if slices.ContainsFunc(state.Items, func(i Item) bool { return gone[i.ID()] }) {
			state.Items = slices.DeleteFunc(slices.Clone(state.Items), func(i Item) bool { return gone[i.ID()] })
		}
	case *RequestOpenedEvent:
		if at := indexOfRequest(state.Requests, e.Request.ID()); at >= 0 {
			state.Requests = replaced(state.Requests, at, e.Request)
		} else {
			state.Requests = append(slices.Clip(state.Requests), e.Request)
		}
	case *RequestResolvedEvent:
		// It stays, with its resolution, so a UI can show how it was answered.
		if at := indexOfRequest(state.Requests, e.RequestID); at >= 0 {
			state.Requests = replaced(state.Requests, at, withResolution(state.Requests[at], e.Resolution))
		}
	}
	// turn.* events change nothing but seq.
	return state
}

// withItem is the state with the item id changed by change, if there is one and it changes it.
func withItem(state Snapshot, id string, change func(Item) (Item, bool)) Snapshot {
	at := indexOfItem(state.Items, id)
	if at < 0 {
		return state
	}
	next, changed := change(state.Items[at])
	if !changed {
		return state
	}
	state.Items = replaced(state.Items, at, next)
	return state
}

// Patched is the item with patch's fields set, and those set to null removed; id and type stay.
// It returns the item as it was, and false, if the patch changes nothing (or can't be applied: a
// value of the wrong type, say).
func Patched(item Item, patch map[string]json.RawMessage) (Item, bool) {
	data, err := json.Marshal(item)
	if err != nil {
		return item, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return item, false
	}
	changed := false
	for k, v := range patch {
		if k == "id" || k == "type" {
			continue
		}
		old, has := fields[k]
		if isNull(v) {
			if has {
				delete(fields, k)
				changed = true
			}
			continue
		}
		if !has || !sameJSON(old, v) {
			fields[k] = v
			changed = true
		}
	}
	if !changed {
		return item, false
	}
	data, err = json.Marshal(fields)
	if err != nil {
		return item, false
	}
	var next Item
	if err := json.Unmarshal(data, &next); err != nil {
		return item, false
	}
	return next, true
}

func sameJSON(a, b json.RawMessage) bool {
	var x, y bytes.Buffer
	if json.Compact(&x, a) != nil || json.Compact(&y, b) != nil {
		return bytes.Equal(a, b)
	}
	return bytes.Equal(x.Bytes(), y.Bytes())
}

func withText(item Item, text string) Item {
	switch i := item.Value.(type) {
	case *AssistantMessage:
		c := *i
		c.Text = text
		return Item{Value: &c}
	case *Reasoning:
		c := *i
		c.Text = text
		return Item{Value: &c}
	}
	return item
}

// withResolution is a copy of the request with its resolution set.
func withResolution(request ThreadRequest, res Resolution) ThreadRequest {
	switch r := request.Value.(type) {
	case *PermissionRequest:
		c := *r
		c.Resolution = &res
		return ThreadRequest{Value: &c}
	case *QuestionRequest:
		c := *r
		c.Resolution = &res
		return ThreadRequest{Value: &c}
	}
	return request
}

// Updates are nearly always to recent items and requests, so look from the end.
func indexOfItem(items []Item, id string) int {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].ID() == id {
			return i
		}
	}
	return -1
}

func indexOfRequest(requests []ThreadRequest, id string) int {
	for i := len(requests) - 1; i >= 0; i-- {
		if requests[i].ID() == id {
			return i
		}
	}
	return -1
}

func replaced[T any](list []T, at int, v T) []T {
	next := slices.Clone(list)
	next[at] = v
	return next
}

package protocol

import "slices"

// Windows of a thread's state, and pages of the items before them (spec/PROTOCOL.md, "Windows"): a
// thread can run to thousands of items, so a client starts from its last ones and loads earlier
// ones a page at a time. Items are only ever added at the end of the list, so an item's index in it
// never changes, and windows and pages say where they are by index. The same as snapshotWindow,
// itemPage, withPage and requestAnchor in @dire-kiwi/agent-threads-protocol.
//
// Like ApplyEvent, these never change the state they're given, and share its items and requests.

// SnapshotWindow is the window of state with its last limit items, and what they need from before
// them: the subagent calls they and the open requests belong to, and the open requests' tool calls.
// With a negative limit (no limit), or one it's within, it's the state itself. state must be whole
// (not a window).
func SnapshotWindow(state Snapshot, limit int) Snapshot {
	items := state.Items
	if limit < 0 || len(items) <= limit {
		return state
	}
	start := len(items) - limit
	at := indices(items)
	var need []string
	for _, item := range items[start:] {
		need = append(need, item.ParentID())
	}
	for _, r := range state.Requests {
		if r.Resolution() == nil {
			need = append(need, r.ParentID(), r.ToolCallID())
		}
	}
	context := contextOf(items, at, need, start)
	w := Snapshot{
		Thread:   state.Thread,
		Items:    append(itemsAt(items, context), items[start:]...),
		Requests: []ThreadRequest{},
		Seq:      state.Seq,
	}
	// The open requests, and the resolved ones anchored in it (or nowhere).
	for _, r := range state.Requests {
		if r.Resolution() == nil {
			w.Requests = append(w.Requests, r)
		} else if a := anchor(items, at, r); a < 0 || a >= start {
			w.Requests = append(w.Requests, r)
		}
	}
	if start > 0 {
		s := int64(start)
		w.Start = &s
	}
	if len(context) > 0 {
		w.Context = context
	}
	return w
}

// ItemsBefore is the page of state's items before index before (a window's start), at most limit
// of them, with what they need from before them (the subagent calls they belong to) and the
// requests they have. state must be whole.
func ItemsBefore(state Snapshot, before int64, limit int) ItemPage {
	items := state.Items
	end := int(max(0, min(before, int64(len(items)))))
	start := max(0, end-max(0, limit))
	at := indices(items)
	var need []string
	for _, item := range items[start:end] {
		need = append(need, item.ParentID())
	}
	context := contextOf(items, at, need, start)
	page := ItemPage{
		ThreadID: state.Thread.ID,
		Items:    append(itemsAt(items, context), items[start:end]...),
		Requests: []ThreadRequest{},
		Start:    int64(start),
		Context:  context,
		Seq:      state.Seq,
	}
	for _, r := range state.Requests {
		if a := anchor(items, at, r); a >= start && a < end {
			page.Requests = append(page.Requests, r)
		}
	}
	return page
}

// WithPage is state (a window) with page, the page before its start, put in front of its items:
// the context items of both in order (the page's version of one they share), less those the page's
// own items have, then the page's items, then its own. The page's requests go in front of its own,
// the page's version of one it has replacing it in place. A page for another thread, or that
// doesn't end at its start, changes nothing.
func WithPage(state Snapshot, page ItemPage) Snapshot {
	before := int64(0)
	if state.Start != nil {
		before = *state.Start
	}
	own, theirs := state.Context, page.Context
	body := page.Items[min(len(theirs), len(page.Items)):]
	if page.ThreadID != state.Thread.ID || before == 0 || page.Start+int64(len(body)) != before || page.Start >= before {
		return state
	}
	fresh := map[string]bool{}
	for _, item := range body {
		fresh[item.ID()] = true
	}
	ctx := map[int64]Item{}
	take := func(indices []int64, items []Item) {
		for i, index := range indices {
			if i < len(items) && index < page.Start && !fresh[items[i].ID()] {
				ctx[index] = items[i]
			}
		}
	}
	take(own, state.Items)
	take(theirs, page.Items)
	var context []int64
	for index := range ctx {
		context = append(context, index)
	}
	slices.Sort(context)
	next := state
	next.Items = make([]Item, 0, len(context)+len(body)+len(state.Items))
	for _, index := range context {
		next.Items = append(next.Items, ctx[index])
	}
	next.Items = append(next.Items, body...)
	for _, item := range state.Items[min(len(own), len(state.Items)):] {
		if !fresh[item.ID()] {
			next.Items = append(next.Items, item)
		}
	}
	theirsByID := map[string]ThreadRequest{}
	for _, r := range page.Requests {
		theirsByID[r.ID()] = r
	}
	next.Requests = []ThreadRequest{}
	for _, r := range page.Requests {
		if indexOfRequest(state.Requests, r.ID()) < 0 {
			next.Requests = append(next.Requests, r)
		}
	}
	for _, r := range state.Requests {
		if p, ok := theirsByID[r.ID()]; ok {
			r = p
		}
		next.Requests = append(next.Requests, r)
	}
	next.Start, next.Context = nil, nil
	if page.Start > 0 {
		s := page.Start
		next.Start = &s
		if len(context) > 0 {
			next.Context = context
		}
	}
	return next
}

// RequestAnchor is where a request is in the thread's items: the index of its tool call, or else of
// the last item of its turn; -1 if it has neither. A window or page has the requests whose anchor is
// in it.
func RequestAnchor(items []Item, r ThreadRequest) int {
	return anchor(items, indices(items), r)
}

func anchor(items []Item, at map[string]int, r ThreadRequest) int {
	if id := r.ToolCallID(); id != "" {
		if i, ok := at[id]; ok {
			return i
		}
	}
	if turn := r.TurnID(); turn != "" {
		for i := len(items) - 1; i >= 0; i-- {
			if items[i].TurnID() == turn {
				return i
			}
		}
	}
	return -1
}

// indices is each item's index by its id (the last, should one be there twice).
func indices(items []Item) map[string]int {
	at := make(map[string]int, len(items))
	for i, item := range items {
		at[item.ID()] = i
	}
	return at
}

// contextOf is the indices before start of the items with an id in need, and of their parents,
// however nested; ascending.
func contextOf(items []Item, at map[string]int, need []string, start int) []int64 {
	out := []int64{}
	seen := map[string]bool{}
	for _, id := range need {
		for id != "" && !seen[id] {
			seen[id] = true
			i, ok := at[id]
			if !ok {
				break
			}
			if i < start {
				out = append(out, int64(i))
			}
			id = items[i].ParentID()
		}
	}
	slices.Sort(out)
	return out
}

func itemsAt(items []Item, indices []int64) []Item {
	out := make([]Item, 0, len(indices))
	for _, i := range indices {
		out = append(out, items[i])
	}
	return out
}

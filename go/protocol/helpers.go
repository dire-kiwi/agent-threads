package protocol

import "encoding/json"

// Accessors for the fields every variant of a union has.

// ThreadID is the event's thread_id.
func (u ThreadEvent) ThreadID() string {
	switch e := u.Value.(type) {
	case *ThreadUpdatedEvent:
		return e.ThreadID
	case *TurnStartedEvent:
		return e.ThreadID
	case *TurnCompletedEvent:
		return e.ThreadID
	case *ItemAddedEvent:
		return e.ThreadID
	case *ItemUpdatedEvent:
		return e.ThreadID
	case *DeltaEvent:
		return e.ThreadID
	case *RequestOpenedEvent:
		return e.ThreadID
	case *RequestResolvedEvent:
		return e.ThreadID
	}
	return ""
}

// Seq is the event's seq.
func (u ThreadEvent) Seq() int64 {
	switch e := u.Value.(type) {
	case *ThreadUpdatedEvent:
		return e.Seq
	case *TurnStartedEvent:
		return e.Seq
	case *TurnCompletedEvent:
		return e.Seq
	case *ItemAddedEvent:
		return e.Seq
	case *ItemUpdatedEvent:
		return e.Seq
	case *DeltaEvent:
		return e.Seq
	case *RequestOpenedEvent:
		return e.Seq
	case *RequestResolvedEvent:
		return e.Seq
	}
	return 0
}

// Type is the event's type, or "" if it has no Value.
func (u ThreadEvent) Type() string {
	if u.Value == nil {
		return ""
	}
	return u.Value.Type()
}

// Saved says whether the event is saved (numbered, and stored): every event but a delta.
func (u ThreadEvent) Saved() bool {
	_, delta := u.Value.(*DeltaEvent)
	return u.Value != nil && !delta
}

// Number sets the event's thread_id and seq.
func (u ThreadEvent) Number(threadID string, seq int64) {
	switch e := u.Value.(type) {
	case *ThreadUpdatedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *TurnStartedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *TurnCompletedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *ItemAddedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *ItemUpdatedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *DeltaEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *RequestOpenedEvent:
		e.ThreadID, e.Seq = threadID, seq
	case *RequestResolvedEvent:
		e.ThreadID, e.Seq = threadID, seq
	}
}

// ID is the item's id.
func (u Item) ID() string {
	switch i := u.Value.(type) {
	case *UserMessage:
		return i.ID
	case *AssistantMessage:
		return i.ID
	case *Reasoning:
		return i.ID
	case *ToolCall:
		return i.ID
	case *Compaction:
		return i.ID
	case *Notice:
		return i.ID
	case *TurnResult:
		return i.ID
	}
	return ""
}

// Type is the item's type, or "" if it has no Value.
func (u Item) Type() string {
	if u.Value == nil {
		return ""
	}
	return u.Value.Type()
}

// TurnID is the item's turn_id.
func (u Item) TurnID() string {
	switch i := u.Value.(type) {
	case *UserMessage:
		return i.TurnID
	case *AssistantMessage:
		return i.TurnID
	case *Reasoning:
		return i.TurnID
	case *ToolCall:
		return i.TurnID
	case *Compaction:
		return i.TurnID
	case *Notice:
		return i.TurnID
	case *TurnResult:
		return i.TurnID
	}
	return ""
}

// SetTurnID sets the item's turn_id.
func (u Item) SetTurnID(id string) {
	switch i := u.Value.(type) {
	case *UserMessage:
		i.TurnID = id
	case *AssistantMessage:
		i.TurnID = id
	case *Reasoning:
		i.TurnID = id
	case *ToolCall:
		i.TurnID = id
	case *Compaction:
		i.TurnID = id
	case *Notice:
		i.TurnID = id
	case *TurnResult:
		i.TurnID = id
	}
}

// ParentID is the item's parent_id: the subagent call it's part of.
func (u Item) ParentID() string {
	switch i := u.Value.(type) {
	case *UserMessage:
		return i.ParentID
	case *AssistantMessage:
		return i.ParentID
	case *Reasoning:
		return i.ParentID
	case *ToolCall:
		return i.ParentID
	case *Compaction:
		return i.ParentID
	case *Notice:
		return i.ParentID
	case *TurnResult:
		return i.ParentID
	}
	return ""
}

// Text is an assistant_message's or reasoning item's text, and whether it's one of those.
func (u Item) Text() (string, bool) {
	switch i := u.Value.(type) {
	case *AssistantMessage:
		return i.Text, true
	case *Reasoning:
		return i.Text, true
	}
	return "", false
}

// ID is the request's id.
func (u ThreadRequest) ID() string {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.ID
	case *QuestionRequest:
		return r.ID
	case *PlanRequest:
		return r.ID
	}
	return ""
}

// TurnID is the request's turn_id.
func (u ThreadRequest) TurnID() string {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.TurnID
	case *QuestionRequest:
		return r.TurnID
	case *PlanRequest:
		return r.TurnID
	}
	return ""
}

// ParentID is the request's parent_id: the subagent call that's asking, if one is.
func (u ThreadRequest) ParentID() string {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.ParentID
	case *QuestionRequest:
		return r.ParentID
	case *PlanRequest:
		return r.ParentID
	}
	return ""
}

// ToolCallID is the request's tool_call_id: the tool call it's about, if there is one.
func (u ThreadRequest) ToolCallID() string {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.ToolCallID
	case *QuestionRequest:
		return r.ToolCallID
	case *PlanRequest:
		return r.ToolCallID
	}
	return ""
}

// Resolution is how the request was resolved, or nil while it's open.
func (u ThreadRequest) Resolution() *Resolution {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.Resolution
	case *QuestionRequest:
		return r.Resolution
	case *PlanRequest:
		return r.Resolution
	}
	return nil
}

// ThreadID is the command's thread_id.
func (u Command) ThreadID() string {
	switch c := u.Value.(type) {
	case *SendCommand:
		return c.ThreadID
	case *InterruptCommand:
		return c.ThreadID
	case *RespondCommand:
		return c.ThreadID
	case *SetOptionsCommand:
		return c.ThreadID
	}
	return ""
}

// TextLen is the length of s as the protocol counts it (a delta's offset): in UTF-16 code units, as
// JavaScript counts a string's length.
func TextLen(s string) int64 {
	n := int64(0)
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// textFrom is s from UTF-16 offset at on.
func textFrom(s string, at int64) string {
	if at <= 0 {
		return s
	}
	n := int64(0)
	for i, r := range s {
		if n >= at {
			return s[i:]
		}
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return ""
}

// SetRaw sets the event's raw: the harness payload it came from.
func (u ThreadEvent) SetRaw(raw json.RawMessage) {
	switch e := u.Value.(type) {
	case *ThreadUpdatedEvent:
		e.Raw = raw
	case *TurnStartedEvent:
		e.Raw = raw
	case *TurnCompletedEvent:
		e.Raw = raw
	case *ItemAddedEvent:
		e.Raw = raw
	case *ItemUpdatedEvent:
		e.Raw = raw
	case *DeltaEvent:
		e.Raw = raw
	case *RequestOpenedEvent:
		e.Raw = raw
	case *RequestResolvedEvent:
		e.Raw = raw
	}
}

// Raw is the event's raw, if it has one.
func (u ThreadEvent) Raw() json.RawMessage {
	switch e := u.Value.(type) {
	case *ThreadUpdatedEvent:
		return e.Raw
	case *TurnStartedEvent:
		return e.Raw
	case *TurnCompletedEvent:
		return e.Raw
	case *ItemAddedEvent:
		return e.Raw
	case *ItemUpdatedEvent:
		return e.Raw
	case *DeltaEvent:
		return e.Raw
	case *RequestOpenedEvent:
		return e.Raw
	case *RequestResolvedEvent:
		return e.Raw
	}
	return nil
}

// SetRaw sets the item's raw: the harness payload it came from.
func (u Item) SetRaw(raw json.RawMessage) {
	switch i := u.Value.(type) {
	case *UserMessage:
		i.Raw = raw
	case *AssistantMessage:
		i.Raw = raw
	case *Reasoning:
		i.Raw = raw
	case *ToolCall:
		i.Raw = raw
	case *Compaction:
		i.Raw = raw
	case *Notice:
		i.Raw = raw
	case *TurnResult:
		i.Raw = raw
	}
}

// Raw is the item's raw, if it has one.
func (u Item) Raw() json.RawMessage {
	switch i := u.Value.(type) {
	case *UserMessage:
		return i.Raw
	case *AssistantMessage:
		return i.Raw
	case *Reasoning:
		return i.Raw
	case *ToolCall:
		return i.Raw
	case *Compaction:
		return i.Raw
	case *Notice:
		return i.Raw
	case *TurnResult:
		return i.Raw
	}
	return nil
}

// SetRaw sets the request's raw: the harness payload it came from.
func (u ThreadRequest) SetRaw(raw json.RawMessage) {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		r.Raw = raw
	case *QuestionRequest:
		r.Raw = raw
	case *PlanRequest:
		r.Raw = raw
	}
}

// Raw is the request's raw, if it has one.
func (u ThreadRequest) Raw() json.RawMessage {
	switch r := u.Value.(type) {
	case *PermissionRequest:
		return r.Raw
	case *QuestionRequest:
		return r.Raw
	case *PlanRequest:
		return r.Raw
	}
	return nil
}

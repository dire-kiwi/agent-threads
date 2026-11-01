// Package protocol has the types of agent-threads' shared spec (spec/ in the repository): the
// items, requests, events, commands and snapshots that every backend sends and accepts.
//
// The types are generated from spec/schema by internal/gen; run `make gen` at the repo root after
// changing the schemas. A union (Item, ThreadRequest, ThreadEvent, Command) is a struct holding one
// of its variants in Value, and marshals as that variant with its "type":
//
//	var ev protocol.ThreadEvent
//	_ = json.Unmarshal(data, &ev)
//	switch e := ev.Value.(type) {
//	case *protocol.ItemAddedEvent:
//		...
//	}
//
// Optional strings and booleans are left out when empty or false (the spec gives them no other
// meaning); optional numbers and objects are pointers. Values the spec doesn't describe (a tool's
// input, an item.updated's patch, a thread's metadata) are json.RawMessage, or maps of them, so
// they pass through unchanged: decode them into the type you expect (with json.Decoder.UseNumber
// for large integers, if into any).
package protocol

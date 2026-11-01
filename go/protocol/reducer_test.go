package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func event(t *testing.T, s string) protocol.ThreadEvent {
	t.Helper()
	var e protocol.ThreadEvent
	if err := json.Unmarshal([]byte(s), &e); err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return e
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var x any
	json.Unmarshal(data, &x)
	out, _ := json.Marshal(x)
	return string(out)
}

// started is a state with a user message, a tool call and an empty reply, at seq 3.
func started(t *testing.T) protocol.Snapshot {
	s := protocol.InitialState(protocol.Thread{ID: "th", Harness: "claude", Status: protocol.ThreadStatusIdle, CreatedAt: "2026-11-01T00:00:00Z"})
	return protocol.ApplyEvents(s, []protocol.ThreadEvent{
		event(t, `{"type":"item.added","thread_id":"th","seq":1,"item":{"id":"u1","type":"user_message","text":"hi"}}`),
		event(t, `{"type":"item.added","thread_id":"th","seq":2,"item":{"id":"tc1","type":"tool_call","name":"Bash","kind":"shell","input":{"command":"ls"},"status":"pending"}}`),
		event(t, `{"type":"item.added","thread_id":"th","seq":3,"item":{"id":"a1","type":"assistant_message","text":""}}`),
	})
}

func TestApplyEventItems(t *testing.T) {
	s := started(t)
	if s.Seq != 3 || len(s.Items) != 3 {
		t.Fatalf("got seq %d, %d items", s.Seq, len(s.Items))
	}
	// Replaced in place when the id is there already.
	next := protocol.ApplyEvent(s, event(t, `{"type":"item.added","thread_id":"th","seq":4,"item":{"id":"tc1","type":"tool_call","name":"Bash","kind":"shell","input":{},"status":"running"}}`))
	if len(next.Items) != 3 || next.Items[1].Value.(*protocol.ToolCall).Status != "running" || s.Items[1].Value.(*protocol.ToolCall).Status != "pending" {
		t.Fatalf("got %s", asJSON(t, next.Items))
	}
	// Patched: fields set, nulls removed, id and type left.
	p := protocol.ApplyEvent(s, event(t, `{"type":"item.updated","thread_id":"th","seq":4,"item_id":"tc1","patch":{"status":"completed","result":{"content":"a\nb"},"command":"ls","id":"other","type":"notice"}}`))
	want := `{"command":"ls","id":"tc1","input":{"command":"ls"},"kind":"shell","name":"Bash","result":{"content":"a\nb"},"status":"completed","type":"tool_call"}`
	if got := asJSON(t, p.Items[1]); got != want {
		t.Fatalf("got %s", got)
	}
	p2 := protocol.ApplyEvent(p, event(t, `{"type":"item.updated","thread_id":"th","seq":5,"item_id":"tc1","patch":{"command":null,"future":{"x":1}}}`))
	if got := asJSON(t, p2.Items[1]); p2.Items[1].Value.(*protocol.ToolCall).Command != "" || !strings.Contains(got, `"future":{"x":1}`) {
		t.Fatalf("got %s", got)
	}
	if p2.Seq != 5 || asJSON(t, p.Items[1]) != want {
		t.Fatal("the state before changed")
	}
	// An update to an item it doesn't have only counts.
	if n := protocol.ApplyEvent(s, event(t, `{"type":"item.updated","thread_id":"th","seq":4,"item_id":"nope","patch":{"text":"x"}}`)); n.Seq != 4 || len(n.Items) != 3 {
		t.Fatal("an update to an unknown item")
	}
	// Events it has, and other threads', change nothing.
	if n := protocol.ApplyEvent(s, event(t, `{"type":"item.added","thread_id":"th","seq":3,"item":{"id":"x","type":"notice","level":"info","text":"x"}}`)); len(n.Items) != 3 || n.Seq != 3 {
		t.Fatal("an event it has")
	}
	if n := protocol.ApplyEvent(s, event(t, `{"type":"item.added","thread_id":"other","seq":4,"item":{"id":"x","type":"notice","level":"info","text":"x"}}`)); len(n.Items) != 3 || n.Seq != 3 {
		t.Fatal("another thread's event")
	}
}

func TestApplyEventDeltas(t *testing.T) {
	delta := func(text string, offset int, item string, seq int) protocol.ThreadEvent {
		data, _ := json.Marshal(map[string]any{"type": "delta", "thread_id": "th", "seq": seq, "item_id": item, "kind": "text", "offset": offset, "text": text})
		return event(t, string(data))
	}
	text := func(s protocol.Snapshot) string { x, _ := s.Items[2].Text(); return x }
	s := protocol.ApplyEvents(started(t), []protocol.ThreadEvent{delta("Hel", 0, "a1", 3), delta("lo", 3, "a1", 3)})
	if text(s) != "Hello" || s.Seq != 3 {
		t.Fatalf("got %q", text(s))
	}
	for _, d := range []protocol.ThreadEvent{delta("x", 0, "nope", 3), delta("x", 0, "tc1", 3), delta("x", 0, "a1", 2), delta("Hel", 0, "a1", 3), delta("el", 1, "a1", 3), delta("p", 9, "a1", 3), delta("", 0, "a1", 3)} {
		if text(protocol.ApplyEvent(s, d)) != "Hello" {
			t.Fatalf("%s changed it", asJSON(t, d))
		}
	}
	if got := text(protocol.ApplyEvent(s, delta("lo, world", 3, "a1", 3))); got != "Hello, world" {
		t.Fatalf("got %q", got)
	}
	if got := text(protocol.ApplyEvent(s, delta("x", 5, "a1", 9))); got != "Hellox" {
		t.Fatalf("got %q", got)
	}
	// Offsets count UTF-16 code units, as JavaScript does.
	u := protocol.ApplyEvents(started(t), []protocol.ThreadEvent{delta("a😀", 0, "a1", 3), delta("😀é", 1, "a1", 3), delta("éz", 3, "a1", 3)})
	if got := text(u); got != "a😀éz" {
		t.Fatalf("got %q", got)
	}
	if protocol.TextLen("a😀é") != 4 {
		t.Fatal("TextLen")
	}
}

func TestApplyEventRequests(t *testing.T) {
	s := protocol.ApplyEvents(started(t), []protocol.ThreadEvent{
		event(t, `{"type":"request.opened","thread_id":"th","seq":4,"request":{"id":"p1","type":"permission","name":"Bash","kind":"shell","input":{}}}`),
		event(t, `{"type":"request.opened","thread_id":"th","seq":5,"request":{"id":"q1","type":"question","questions":[{"id":"a","question":"?"}]}}`),
	})
	if len(s.Requests) != 2 {
		t.Fatal("not opened")
	}
	r := protocol.ApplyEvent(s, event(t, `{"type":"request.resolved","thread_id":"th","seq":6,"request_id":"p1","resolution":{"outcome":"allow"}}`))
	if len(r.Requests) != 1 || r.Requests[0].ID() != "q1" || len(s.Requests) != 2 {
		t.Fatal("not resolved")
	}
	if !protocol.IsGap(r, event(t, `{"type":"turn.started","thread_id":"th","seq":8,"turn_id":"t"}`)) || protocol.IsGap(r, event(t, `{"type":"turn.started","thread_id":"th","seq":7,"turn_id":"t"}`)) {
		t.Fatal("IsGap")
	}
}

// spec/examples' events fold into its snapshot, even with each delivered twice.
func TestExampleFolds(t *testing.T) {
	var events []protocol.ThreadEvent
	for _, line := range lines(t, "../../spec/examples/thread.events.jsonl") {
		e := event(t, string(line))
		events = append(events, e, e)
	}
	got := protocol.ApplyEvents(protocol.InitialState(events[0].Value.(*protocol.ThreadUpdatedEvent).Thread), events)
	want, err := os.ReadFile("../../spec/examples/thread.snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	var w any
	json.Unmarshal(want, &w)
	wj, _ := json.Marshal(w)
	if asJSON(t, got) != string(wj) {
		t.Fatalf("got  %s\nwant %s", asJSON(t, got), wj)
	}
}

func TestValidate(t *testing.T) {
	for _, line := range lines(t, "../../spec/examples/commands.jsonl") {
		if p := protocol.Validate(line, "Command"); len(p) > 0 {
			t.Errorf("%s: %v", line, p)
		}
	}
	fixtures, _ := filepath.Glob("../../spec/fixtures/*/*/expected.jsonl")
	for _, f := range append(fixtures, "../../spec/examples/thread.events.jsonl") {
		for _, line := range lines(t, f) {
			if strings.Contains(string(line), "{{") {
				continue // placeholders aren't always where a string goes
			}
			if p := protocol.Validate(line, "ThreadEvent"); len(p) > 0 {
				t.Errorf("%s: %s: %v", f, line, p)
			}
		}
	}
	bad := []string{
		`"send"`,
		`{"type":"dance","thread_id":"t"}`,
		`{"type":"interrupt"}`,
		`{"type":"interrupt","thread_id":7}`,
		`{"type":"send","thread_id":"t"}`,
		`{"type":"send","thread_id":"t","text":["hi"]}`,
		`{"type":"send","thread_id":"t","text":"hi","attachments":{}}`,
		`{"type":"send","thread_id":"t","text":"hi","attachments":[{"name":"a"}]}`,
		`{"type":"send","thread_id":"t","text":"hi","attachments":[{"kind":"video"}]}`,
		`{"type":"send","thread_id":"t","text":"hi","attachments":[{"kind":"file","path":1}]}`,
		`{"type":"send","thread_id":"t","text":"hi","client_id":3}`,
		`{"type":"respond","thread_id":"t","request_id":"r"}`,
		`{"type":"respond","thread_id":"t","request_id":"r","resolution":{"outcome":"maybe"}}`,
		`{"type":"respond","thread_id":"t","request_id":"r","resolution":{"outcome":"allow","always":"yes"}}`,
		`{"type":"respond","thread_id":"t","request_id":"r","resolution":{"outcome":"answer","answers":{"q":"Blue"}}}`,
		`{"type":"respond","thread_id":"t","request_id":"r","resolution":{"outcome":"answer","answers":{"q":[1]}}}`,
		`{"type":"set_options","thread_id":"t","model":4}`,
		`{"type":"set_options","thread_id":"t","permission_mode":"yolo"}`,
	}
	for _, b := range bad {
		if len(protocol.Validate([]byte(b), "Command")) == 0 {
			t.Errorf("%s should be invalid", b)
		}
	}
	if got := protocol.Validate([]byte(`{"type":"send","thread_id":"t","text":"hi","attachments":[{"kind":"file","data":"not base64!"}]}`), "Command"); !reflect.DeepEqual(got, []string{".attachments[0].data: should be base64"}) {
		t.Errorf("got %v", got)
	}
	if got := protocol.Validate([]byte(`{"type":"interrupt","thread_id":"t","from":"a newer client"}`), "Command"); len(got) > 0 {
		t.Errorf("got %v", got)
	}
}

// Fields the spec doesn't name are kept, at any depth, and written again.
func TestUnknownFieldsAreKept(t *testing.T) {
	in := `{"type":"item.added","thread_id":"th","seq":1,"future":[1,2],"item":{"id":"tc","type":"tool_call","name":"x","kind":"other","input":{},"status":"completed","result":{"content":"","later":true},"newer":"yes"}}`
	e := event(t, in)
	if asJSON(t, e) != asJSON(t, json.RawMessage(in)) {
		t.Fatalf("got %s", asJSON(t, e))
	}
}

package protocol_test

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// windowState is 0 m0, 1 sa (a subagent), 2 m2, 3 sb (sa's subagent), 4 m4, 5 b1 (sb's), 6 m6, 7 tc
// (sa's call), 8 m8, 9 m9 (turn t2); requests: p-old answered at m2, p-sa open from sa for tc, p-new
// answered at m8, p-turn answered with no call (turn t2: anchored at m9), p-none answered with
// neither.
func windowState(t *testing.T) protocol.Snapshot {
	t.Helper()
	var s protocol.Snapshot
	data := `{"thread":{"id":"th","harness":"claude","status":"waiting","created_at":"2026-11-01T00:00:00Z"},"seq":20,"items":[
		{"id":"m0","type":"assistant_message","text":"m0","turn_id":"t1"},
		{"id":"sa","type":"tool_call","name":"Agent","kind":"subagent","input":{},"status":"completed","turn_id":"t1"},
		{"id":"m2","type":"assistant_message","text":"m2","turn_id":"t1"},
		{"id":"sb","type":"tool_call","name":"Agent","kind":"subagent","input":{},"status":"completed","turn_id":"t1","parent_id":"sa"},
		{"id":"m4","type":"assistant_message","text":"m4","turn_id":"t1"},
		{"id":"b1","type":"assistant_message","text":"b1","turn_id":"t1","parent_id":"sb"},
		{"id":"m6","type":"assistant_message","text":"m6","turn_id":"t1"},
		{"id":"tc","type":"tool_call","name":"Bash","kind":"shell","input":{},"status":"pending","parent_id":"sa","turn_id":"t1"},
		{"id":"m8","type":"assistant_message","text":"m8","turn_id":"t1"},
		{"id":"m9","type":"assistant_message","text":"m9","turn_id":"t2"}
	],"requests":[
		{"id":"p-old","type":"permission","name":"Bash","kind":"shell","input":{},"turn_id":"t1","tool_call_id":"m2","resolution":{"outcome":"allow"}},
		{"id":"p-sa","type":"permission","name":"Bash","kind":"shell","input":{},"turn_id":"t1","tool_call_id":"tc","parent_id":"sa"},
		{"id":"p-new","type":"permission","name":"Bash","kind":"shell","input":{},"turn_id":"t1","tool_call_id":"m8","resolution":{"outcome":"deny"}},
		{"id":"p-turn","type":"permission","name":"Bash","kind":"shell","input":{},"turn_id":"t2","resolution":{"outcome":"cancel"}},
		{"id":"p-none","type":"permission","name":"Bash","kind":"shell","input":{},"turn_id":"t9","resolution":{"outcome":"cancel"}}
	]}`
	if err := json.Unmarshal([]byte(data), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func ids[T interface{ ID() string }](list []T) []string {
	out := []string{}
	for _, x := range list {
		out = append(out, x.ID())
	}
	return out
}

func same(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func start(s protocol.Snapshot) int64 {
	if s.Start == nil {
		return -1
	}
	return *s.Start
}

func TestSnapshotWindowWhole(t *testing.T) {
	// The state itself with no limit, or one it's within.
	s := windowState(t)
	for _, limit := range []int{-1, 10, 50} {
		if w := protocol.SnapshotWindow(s, limit); &w.Items[0] != &s.Items[0] || w.Start != nil {
			t.Fatalf("limit %d: got %s", limit, asJSON(t, w))
		}
	}
}

func TestSnapshotWindow(t *testing.T) {
	// The last items, the parents they and open requests need, and the requests anchored in it.
	s := windowState(t)
	w := protocol.SnapshotWindow(s, 2)
	same(t, start(w), int64(8))
	// p-sa is open: its call (tc) and its subagent (sa) come too.
	same(t, w.Context, []int64{1, 7})
	same(t, ids(w.Items), []string{"sa", "tc", "m8", "m9"})
	same(t, ids(w.Requests), []string{"p-sa", "p-new", "p-turn", "p-none"})
	same(t, w.Seq, int64(20))
	same(t, w.Thread, s.Thread)

	// It brings the subagents its items belong to, however nested.
	s.Requests = nil
	w = protocol.SnapshotWindow(s, 5)
	same(t, start(w), int64(5))
	same(t, w.Context, []int64{1, 3})
	same(t, ids(w.Items), []string{"sa", "sb", "b1", "m6", "tc", "m8", "m9"})

	// And leaves context out when it needs nothing from before it.
	w = protocol.SnapshotWindow(s, 1)
	same(t, asJSON(t, w), `{"items":[{"id":"m9","text":"m9","turn_id":"t2","type":"assistant_message"}],"requests":[],"seq":20,"start":9,"thread":{"created_at":"2026-11-01T00:00:00Z","harness":"claude","id":"th","status":"waiting"}}`)
}

func TestItemsBefore(t *testing.T) {
	// The items before an index, the parents they need, and the requests anchored in them.
	s := windowState(t)
	p := protocol.ItemsBefore(s, 6, 2)
	same(t, []any{p.ThreadID, p.Start, p.Context, p.Seq}, []any{"th", int64(4), []int64{1, 3}, int64(20)})
	same(t, ids(p.Items), []string{"sa", "sb", "m4", "b1"})
	same(t, ids(p.Requests), []string{})
	q := protocol.ItemsBefore(s, 4, 4)
	same(t, q.Start, int64(0))
	same(t, asJSON(t, q.Context), `[]`)
	same(t, ids(q.Items), []string{"m0", "sa", "m2", "sb"})
	same(t, ids(q.Requests), []string{"p-old"})

	// It keeps within the list.
	same(t, protocol.ItemsBefore(s, 50, 1).Start, int64(9))
	r := protocol.ItemsBefore(s, -3, 5)
	same(t, []any{r.Start, len(r.Items), len(r.Context)}, []any{int64(0), 0, 0})
}

func TestWithPageUntilWhole(t *testing.T) {
	// Pages put in front of a window until it's whole.
	whole := windowState(t)
	w := protocol.SnapshotWindow(whole, 2)
	for _, limit := range []int{3, 2} {
		page := protocol.ItemsBefore(whole, *w.Start, limit)
		w = protocol.WithPage(w, page)
		// The same as a window that had that many to begin with.
		same(t, asJSON(t, w), asJSON(t, protocol.SnapshotWindow(whole, len(whole.Items)-int(page.Start))))
	}
	same(t, start(w), int64(3))
	w = protocol.WithPage(w, protocol.ItemsBefore(whole, 3, 10))
	same(t, asJSON(t, w), asJSON(t, whole))
	if w.Start != nil || w.Context != nil {
		t.Fatalf("got %s", asJSON(t, w))
	}
}

func TestWithPageOrdersContext(t *testing.T) {
	// A window whose context is sa (1); a page from 4 whose context is sa and sb (1, 3).
	whole := windowState(t)
	bare := whole
	bare.Requests = nil
	w := protocol.SnapshotWindow(bare, 4)
	same(t, w.Context, []int64{1})
	next := protocol.WithPage(w, protocol.ItemsBefore(whole, 6, 2))
	same(t, start(next), int64(4))
	same(t, next.Context, []int64{1, 3})
	same(t, ids(next.Items), []string{"sa", "sb", "m4", "b1", "m6", "tc", "m8", "m9"})
}

func TestSnapshotWindowBringsRunningSubagents(t *testing.T) {
	// sb (sa's) is running but quiet: none of its items, nor a request of its, is in the window.
	quiet := func(status protocol.ToolStatus) protocol.Snapshot {
		s := windowState(t)
		s.Requests = nil
		items := slices.Clone(s.Items)
		c := *items[3].Value.(*protocol.ToolCall)
		c.Status = status
		items[3] = protocol.Item{Value: &c}
		s.Items = items
		return s
	}
	w := protocol.SnapshotWindow(quiet(protocol.ToolStatusRunning), 2)
	same(t, w.Context, []int64{1, 3})
	same(t, ids(w.Items), []string{"sa", "sb", "m8", "m9"})
	same(t, protocol.SnapshotWindow(quiet(protocol.ToolStatusPending), 2).Context, []int64{1, 3})
	if c := protocol.SnapshotWindow(quiet(protocol.ToolStatusCancelled), 2).Context; c != nil {
		t.Fatalf("an ended subagent in context: %v", c)
	}
	// Where the call has its subagent's own status, that says: a background subagent runs on after
	// its call has completed, and one that ended with its call still running doesn't.
	withSubagent := func(status protocol.SubagentStatus) protocol.Snapshot {
		s := quiet(protocol.ToolStatusCompleted)
		c := *s.Items[3].Value.(*protocol.ToolCall)
		c.Subagent = &protocol.SubagentState{Status: status, Background: true}
		s.Items[3] = protocol.Item{Value: &c}
		return s
	}
	same(t, protocol.SnapshotWindow(withSubagent(protocol.SubagentStatusRunning), 2).Context, []int64{1, 3})
	if c := protocol.SnapshotWindow(withSubagent(protocol.SubagentStatusCompleted), 2).Context; c != nil {
		t.Fatalf("an ended background subagent in context: %v", c)
	}
}

func TestWithPageTakesThePagesVersion(t *testing.T) {
	whole := windowState(t)
	w := protocol.SnapshotWindow(whole, 2)
	later := protocol.ApplyEvent(whole, event(t, `{"type":"item.updated","thread_id":"th","seq":21,"item_id":"sa","patch":{"status":"failed"}}`))
	next := protocol.WithPage(w, protocol.ItemsBefore(later, 8, 1))
	if next.Items[0].ID() != "sa" || next.Items[0].Value.(*protocol.ToolCall).Status != protocol.ToolStatusFailed || next.Seq != 20 {
		t.Fatalf("got %s", asJSON(t, next))
	}
	if w.Items[0].Value.(*protocol.ToolCall).Status != protocol.ToolStatusCompleted {
		t.Fatal("the window before changed")
	}
}

func TestWithPageIgnoresOthers(t *testing.T) {
	// A page for another thread, or that doesn't end at its start.
	whole := windowState(t)
	w := protocol.SnapshotWindow(whole, 2)
	unchanged := func(s, next protocol.Snapshot) bool { return &s.Items[0] == &next.Items[0] }
	if !unchanged(w, protocol.WithPage(w, protocol.ItemsBefore(whole, 7, 2))) {
		t.Fatal("a page that doesn't end at its start")
	}
	other := protocol.ItemsBefore(whole, 8, 2)
	other.ThreadID = "other"
	if !unchanged(w, protocol.WithPage(w, other)) {
		t.Fatal("another thread's page")
	}
	if !unchanged(whole, protocol.WithPage(whole, protocol.ItemsBefore(whole, 0, 2))) {
		t.Fatal("a whole state")
	}
}

func TestWindowTakesEvents(t *testing.T) {
	// Events apply to a window as to any state.
	w := protocol.SnapshotWindow(windowState(t), 2)
	next := protocol.ApplyEvent(w, event(t, `{"type":"item.added","thread_id":"th","seq":21,"item":{"id":"m10","type":"assistant_message","text":"m10","turn_id":"t1"}}`))
	same(t, start(next), int64(8))
	same(t, next.Context, []int64{1, 7})
	same(t, next.Items[len(next.Items)-1].ID(), "m10")
	// An update to an item it doesn't have only advances seq.
	gone := protocol.ApplyEvent(next, event(t, `{"type":"item.updated","thread_id":"th","seq":22,"item_id":"m0","patch":{"text":"x"}}`))
	if &gone.Items[0] != &next.Items[0] || gone.Seq != 22 {
		t.Fatal("an update to an item it doesn't have")
	}
}

func TestRequestAnchor(t *testing.T) {
	// The request's tool call, else the last item of its turn, else -1.
	s := windowState(t)
	var got []int
	for _, r := range s.Requests {
		got = append(got, protocol.RequestAnchor(s.Items, r))
	}
	same(t, got, []int{2, 7, 8, 9, -1})
}

// spec/examples' window and page are thread.snapshot.json's, and the window with the page is a
// bigger window.
func TestWindowExamples(t *testing.T) {
	read := func(name string, v any) string {
		data, err := os.ReadFile("../../spec/examples/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, v); err != nil {
			t.Fatal(err)
		}
		return asJSON(t, json.RawMessage(data))
	}
	var whole, window protocol.Snapshot
	var page protocol.ItemPage
	read("thread.snapshot.json", &whole)
	wantWindow := read("thread.window.json", &window)
	wantPage := read("thread.page.json", &page)
	if got := asJSON(t, protocol.SnapshotWindow(whole, 8)); got != wantWindow {
		t.Errorf("window of 8:\n got %s\nwant %s", got, wantWindow)
	}
	if got := asJSON(t, protocol.ItemsBefore(whole, 5, 3)); got != wantPage {
		t.Errorf("page of 3 before 5:\n got %s\nwant %s", got, wantPage)
	}
	if got, want := asJSON(t, protocol.WithPage(window, page)), asJSON(t, protocol.SnapshotWindow(whole, 11)); got != want {
		t.Errorf("window with page:\n got %s\nwant %s", got, want)
	}
	for name, v := range map[string]any{"Snapshot": window, "ItemPage": page} {
		if p := protocol.ValidateValue(v, name); len(p) > 0 {
			t.Errorf("%s: %v", name, p)
		}
	}
}

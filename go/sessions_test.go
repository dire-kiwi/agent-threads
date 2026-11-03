package agentthreads_test

// Sessions: where each turn leaves the harness's session, and rewind, new_session and compact,
// against a fake harness whose turns the test ends (the recorded fixtures have the real CLIs').

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

type rewindFunc func([]*protocol.TurnSession, int) (agentthreads.RewindPoint, error)

// sessionHarness is a harness whose turns the test ends, with the session it says.
type sessionHarness struct {
	point    rewindFunc
	ctx      atomic.Pointer[agentthreads.ThreadContext]
	compacts atomic.Int32
	changes  atomic.Int32
}

func (h *sessionHarness) Name() string { return "fake" }

func (h *sessionHarness) Open(ctx agentthreads.ThreadContext) agentthreads.Session {
	h.ctx.Store(&ctx)
	return &sessionFake{h: h}
}

// on runs fn with the thread's context on its goroutine, and waits for it and for what it saved to
// be taken for the writer (so an EventsSince after it waits for that to be written). The loop takes
// a task's saves only once the task has returned, so it's the next task posted that says so.
func (h *sessionHarness) on(fn func(agentthreads.ThreadContext)) {
	ctx := *h.ctx.Load()
	done := make(chan struct{})
	ctx.Post(func() { fn(ctx) })
	ctx.Post(func() { close(done) })
	<-done
}

type sessionFake struct{ h *sessionHarness }

func (s *sessionFake) Start([]agentthreads.Message)     {}
func (s *sessionFake) Steer(agentthreads.Message)       {}
func (s *sessionFake) CarryOver([]agentthreads.Message) {}
func (s *sessionFake) Interrupt()                       {}
func (s *sessionFake) Live() bool                       { return false }
func (s *sessionFake) Release()                         {}
func (s *sessionFake) OptionsChanged()                  {}
func (s *sessionFake) ConfigChanged()                   { s.h.changes.Add(1) }
func (s *sessionFake) Close(done func())                { done() }
func (s *sessionFake) Compact()                         { s.h.compacts.Add(1) }
func (s *sessionFake) RewindPoint(sessions []*protocol.TurnSession, i int) (agentthreads.RewindPoint, error) {
	return s.h.point(sessions, i)
}

type sessionsScene struct {
	t   *testing.T
	sdk *agentthreads.AgentThreads
	h   *sessionHarness
	id  string
}

func newSessionsScene(t *testing.T, point rewindFunc, sessionID string) *sessionsScene {
	t.Helper()
	h := &sessionHarness{point: point}
	sdk := agentthreads.New(agentthreads.Options{
		Harnesses:    map[string]agentthreads.Harness{"fake": h},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	t.Cleanup(func() { sdk.Stop(context.Background()) })
	th, err := sdk.Create(context.Background(), agentthreads.CreateOptions{SessionID: sessionID})
	if err != nil {
		t.Fatal(err)
	}
	return &sessionsScene{t: t, sdk: sdk, h: h, id: th.ID}
}

// turn is a turn: it runs in session (a new one if the thread has none), and the harness marks it at.
func (s *sessionsScene) turn(text, session, at string) {
	s.t.Helper()
	if err := s.sdk.Send(context.Background(), s.id, text, agentthreads.SendOptions{}); err != nil {
		s.t.Fatal(err)
	}
	s.h.on(func(ctx agentthreads.ThreadContext) {
		if session != "" {
			ctx.SetThread(func(t *protocol.Thread) { t.SessionID = session })
		}
		ctx.AddItem(&protocol.AssistantMessage{ID: "a-" + text, Text: "re: " + text})
		ctx.EndTurn(agentthreads.TurnEnd{OK: true, SessionAt: at})
	})
}

func (s *sessionsScene) snap() protocol.Snapshot {
	s.t.Helper()
	snap, err := s.sdk.Snapshot(context.Background(), s.id)
	if err != nil {
		s.t.Fatal(err)
	}
	return snap
}

func (s *sessionsScene) events() []protocol.ThreadEvent {
	s.t.Helper()
	events, err := s.sdk.EventsSince(context.Background(), s.id, 0, 0)
	if err != nil {
		s.t.Fatal(err)
	}
	return events
}

func (s *sessionsScene) rewind(turnID string) error {
	return s.sdk.Rewind(context.Background(), s.id, turnID)
}

func turnResults(items []protocol.Item) []*protocol.TurnResult {
	var out []*protocol.TurnResult
	for _, it := range items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			out = append(out, r)
		}
	}
	return out
}

func turnIDs(items []protocol.Item) []string {
	var out []string
	for _, r := range turnResults(items) {
		out = append(out, r.TurnID)
	}
	return out
}

func turnSessions(items []protocol.Item) []*protocol.TurnSession {
	var out []*protocol.TurnSession
	for _, r := range turnResults(items) {
		out = append(out, r.Session)
	}
	return out
}

// kinds is the items' types, with a notice as its code.
func kinds(items []protocol.Item) []string {
	var out []string
	for _, it := range items {
		if n, ok := it.Value.(*protocol.Notice); ok {
			out = append(out, n.Code)
		} else {
			out = append(out, it.Type())
		}
	}
	return out
}

func expectSame(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(mustMarshal(got), mustMarshal(want)) {
		t.Fatalf("%s: got %s, want %s", what, mustMarshal(got), mustMarshal(want))
	}
}

func refused(t *testing.T, err error, want string) {
	t.Helper()
	var ce *agentthreads.CommandError
	if !errors.As(err, &ce) || !strings.Contains(err.Error(), want) {
		t.Fatalf("got %v, want a CommandError with %q", err, want)
	}
}

func TestTurnResultSession(t *testing.T) {
	ctx := context.Background()
	t.Run("has the session the turn ended in, its mark, and whether the turn started it", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		s.turn("two", "", "m2")
		s.turn("three", "", "") // no mark
		if err := s.sdk.NewSession(ctx, s.id); err != nil {
			t.Fatal(err)
		}
		s.turn("four", "S2", "m4")
		expectSame(t, "sessions", turnSessions(s.snap().Items), []*protocol.TurnSession{
			{ID: "S1", At: "m1", Started: true}, {ID: "S1", At: "m2"}, {ID: "S1"}, {ID: "S2", At: "m4", Started: true},
		})
	})
	t.Run("is left out when the turn ended with no session", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "", "")
		expectSame(t, "sessions", turnSessions(s.snap().Items), []*protocol.TurnSession{nil})
	})
}

func TestRewind(t *testing.T) {
	ctx := context.Background()
	t.Run("removes the turn's items and later turns', and resumes the session at the turn before's mark", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		s.turn("two", "", "m2")
		s.turn("three", "", "m3")
		before := s.snap()
		t2 := turnIDs(before.Items)[1]
		changes := s.h.changes.Load()
		if err := s.rewind(t2); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		expectSame(t, "items", kinds(snap.Items), []string{"user_message", "assistant_message", "turn_result", "rewind"})
		if n, ok := snap.Items[3].Value.(*protocol.Notice); !ok || n.Level != protocol.NoticeLevelInfo {
			t.Fatalf("got %s", mustMarshal(snap.Items[3]))
		}
		if snap.Thread.SessionID != "S1" || snap.Thread.ResumeAt != "m1" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		if got := s.h.changes.Load(); got != changes+1 {
			t.Fatalf("ConfigChanged %d times, not once", got-changes)
		}
		events := s.events()
		var removed []string
		for _, e := range events {
			if r, ok := e.Value.(*protocol.ItemsRemovedEvent); ok {
				removed = r.ItemIDs
			}
		}
		var want []string
		for _, it := range before.Items[3:] {
			want = append(want, it.ID())
		}
		expectSame(t, "removed", removed, want)
		first := events[0].Value.(*protocol.ThreadUpdatedEvent).Thread
		expectSame(t, "the snapshot", snap, protocol.ApplyEvents(protocol.InitialState(first), events))
	})

	t.Run("to before a session's first turn starts a new one", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		s.turn("two", "", "m2")
		if err := s.rewind(turnIDs(s.snap().Items)[0]); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		if snap.Thread.SessionID != "" || snap.Thread.ResumeAt != "" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		expectSame(t, "items", kinds(snap.Items), []string{"rewind"})
	})

	t.Run("to before the first turn after a new_session keeps the new session's notice, and starts a new one", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		if err := s.sdk.NewSession(ctx, s.id); err != nil {
			t.Fatal(err)
		}
		s.turn("two", "S2", "m2")
		if err := s.rewind(turnIDs(s.snap().Items)[1]); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		if snap.Thread.SessionID != "" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		expectSame(t, "items", kinds(snap.Items), []string{"user_message", "assistant_message", "turn_result", "session.new", "rewind"})
	})

	t.Run("goes back into the session before a new_session, taking the new session's notice with it", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		s.turn("two", "", "m2")
		if err := s.sdk.NewSession(ctx, s.id); err != nil {
			t.Fatal(err)
		}
		s.turn("three", "S2", "m3")
		ids := turnIDs(s.snap().Items)
		if err := s.rewind(ids[1]); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		if snap.Thread.SessionID != "S1" || snap.Thread.ResumeAt != "m1" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		for _, k := range kinds(snap.Items) {
			if k == "session.new" {
				t.Fatal("the new session's notice is still there")
			}
		}
		for _, id := range turnIDs(snap.Items) {
			if id == ids[2] {
				t.Fatal("the third turn is still there")
			}
		}
	})

	t.Run("is refused for a Claude session the thread adopted, to before its first turn in it", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "S0")
		s.turn("one", "", "m1")
		before := s.snap()
		refused(t, s.rewind(turnIDs(before.Items)[0]), "can't be rewound to before that turn")
		expectSame(t, "the snapshot", s.snap(), before)
	})

	t.Run("reverts a Codex session to before the first turn from there that has a mark", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.RevertPoint, "S0")
		s.turn("one", "", "c1")
		s.turn("two", "", "") // no mark
		s.turn("three", "", "c3")
		ids := turnIDs(s.snap().Items)
		if err := s.rewind(ids[1]); err != nil {
			t.Fatal(err)
		}
		if th := s.snap().Thread; th.SessionID != "S0" || th.ResumeAt != "c3" {
			t.Fatalf("got %s", mustMarshal(th))
		}
		if err := s.rewind(ids[0]); err != nil {
			t.Fatal(err)
		}
		if th := s.snap().Thread; th.SessionID != "S0" || th.ResumeAt != "c1" {
			t.Fatalf("got %s", mustMarshal(th))
		}
	})

	t.Run("keeps a Codex revert not yet made when a second rewind, to before turns with no mark, needs it", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.RevertPoint, "")
		s.turn("one", "S", "c1")
		s.turn("two", "", "") // failed before Codex marked it
		s.turn("three", "", "c3")
		ids := turnIDs(s.snap().Items)
		if err := s.rewind(ids[2]); err != nil {
			t.Fatal(err)
		}
		if th := s.snap().Thread; th.SessionID != "S" || th.ResumeAt != "c3" {
			t.Fatalf("got %s", mustMarshal(th))
		}
		// Codex still has turn three: reverting to before it is what takes it back to before turn two.
		if err := s.rewind(ids[1]); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		if snap.Thread.SessionID != "S" || snap.Thread.ResumeAt != "c3" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		if n := len(turnIDs(snap.Items)); n != 1 {
			t.Fatalf("%d turns, not 1", n)
		}
	})

	t.Run("goes by the order turns ran, though a message carried over to a later turn keeps its place", func(t *testing.T) {
		carried := func(t *testing.T) (*sessionsScene, protocol.Snapshot, string) {
			s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
			send := func(text string) {
				if err := s.sdk.Send(ctx, s.id, text, agentthreads.SendOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			// Turn one, steered with a message the harness doesn't take in; turn two (carrying it
			// over) fails without taking it in; turn three, with the user's next message, takes it in.
			send("one")
			s.h.on(func(c agentthreads.ThreadContext) { c.SetThread(func(t *protocol.Thread) { t.SessionID = "S" }) })
			send("steered")
			s.h.on(func(c agentthreads.ThreadContext) {
				c.EndTurn(agentthreads.TurnEnd{OK: true, SessionAt: "m1"})
				c.EndTurn(agentthreads.TurnEnd{OK: false, Error: "failed"})
			})
			send("three")
			var steered string
			s.h.on(func(c agentthreads.ThreadContext) {
				steered = c.Queued()[0].ID
				c.TookIn(steered)
				c.EndTurn(agentthreads.TurnEnd{OK: true, SessionAt: "m3"})
			})
			snap := s.snap()
			for _, it := range snap.Items {
				if it.ID() == steered && it.TurnID() != turnIDs(snap.Items)[2] {
					t.Fatalf("the steered message is turn %s's, not turn three's", it.TurnID())
				}
			}
			return s, snap, steered
		}
		has := func(items []protocol.Item, id string) bool {
			for _, it := range items {
				if it.ID() == id {
					return true
				}
			}
			return false
		}
		// To before turn two: turn three goes too, with the message it took in.
		s, before, steered := carried(t)
		if err := s.rewind(turnIDs(before.Items)[1]); err != nil {
			t.Fatal(err)
		}
		snap := s.snap()
		expectSame(t, "turns", turnIDs(snap.Items), turnIDs(before.Items)[:1])
		if has(snap.Items, steered) {
			t.Fatal("the steered message is still there")
		}
		expectSame(t, "items", kinds(snap.Items), []string{"user_message", "turn_result", "rewind"})
		// To before turn three: turn two stays.
		s, before, steered = carried(t)
		if err := s.rewind(turnIDs(before.Items)[2]); err != nil {
			t.Fatal(err)
		}
		snap = s.snap()
		expectSame(t, "turns", turnIDs(snap.Items), turnIDs(before.Items)[:2])
		if has(snap.Items, steered) {
			t.Fatal("the steered message is still there")
		}
	})

	t.Run("moves a client's window down, so it can still load the turns kept before it", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S", "m1")
		s.turn("two", "", "m2")
		s.turn("three", "", "m3")
		// A client with a window of the last 3 items (turn three's), from 6.
		w, err := s.sdk.SnapshotWindow(ctx, s.id, 3)
		if err != nil {
			t.Fatal(err)
		}
		if w.Start == nil || *w.Start != 6 {
			t.Fatalf("got %s", mustMarshal(w))
		}
		from := w.Seq
		if err := s.rewind(turnIDs(s.snap().Items)[1]); err != nil {
			t.Fatal(err)
		}
		for _, e := range s.events() {
			if e.Seq() > from {
				w = protocol.ApplyEvent(w, e)
			}
		}
		if w.Start == nil || *w.Start != 3 {
			t.Fatalf("got %s", mustMarshal(w))
		}
		expectSame(t, "items", kinds(w.Items), []string{"rewind"})
		// The page before it is turn one, and fits.
		page, err := s.sdk.ItemsBefore(ctx, s.id, *w.Start, 10)
		if err != nil {
			t.Fatal(err)
		}
		whole := protocol.WithPage(w, page)
		expectSame(t, "the whole", whole.Items, s.snap().Items)
	})

	t.Run("is refused while a turn runs, and for a turn the thread hasn't", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		refused(t, s.rewind("turn_nope"), "no turn turn_nope")
		if err := s.sdk.Send(ctx, s.id, "two", agentthreads.SendOptions{}); err != nil {
			t.Fatal(err)
		}
		refused(t, s.rewind(turnIDs(s.snap().Items)[0]), "a turn is running")
		refused(t, s.sdk.NewSession(ctx, s.id), "a turn is running")
		refused(t, s.sdk.Compact(ctx, s.id), "a turn is running")
	})

	t.Run("steered messages it removes leave the queue", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "S1", "m1")
		if err := s.sdk.Send(ctx, s.id, "two", agentthreads.SendOptions{}); err != nil {
			t.Fatal(err)
		}
		if err := s.sdk.Send(ctx, s.id, "steered", agentthreads.SendOptions{}); err != nil {
			t.Fatal(err)
		}
		// The turn ends without the harness taking it in, and the core gives up carrying it over.
		s.h.on(func(c agentthreads.ThreadContext) { c.EndTurn(agentthreads.TurnEnd{OK: false, Error: "no"}) })
		for i := 0; i < 5 && s.snap().Thread.Status == protocol.ThreadStatusRunning; i++ {
			s.h.on(func(c agentthreads.ThreadContext) { c.EndTurn(agentthreads.TurnEnd{OK: false, Error: "no"}) })
		}
		var queued []string
		s.h.on(func(c agentthreads.ThreadContext) {
			for _, m := range c.Queued() {
				queued = append(queued, m.ID)
			}
		})
		if len(queued) != 1 {
			t.Fatalf("%d messages queued, not 1", len(queued))
		}
		if err := s.rewind(turnIDs(s.snap().Items)[1]); err != nil {
			t.Fatal(err)
		}
		s.h.on(func(c agentthreads.ThreadContext) {
			if q := c.Queued(); len(q) != 0 {
				t.Errorf("still queued: %s", mustMarshal(q))
			}
		})
	})
}

func TestNewSession(t *testing.T) {
	ctx := context.Background()
	s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
	seq := s.snap().Seq
	if err := s.sdk.NewSession(ctx, s.id); err != nil {
		t.Fatal(err)
	}
	if s.snap().Seq != seq {
		t.Fatal("new_session with no session sent events")
	}
	s.turn("one", "S1", "m1")
	if err := s.sdk.Handle(ctx, protocol.Command{Value: &protocol.NewSessionCommand{ThreadID: s.id}}); err != nil {
		t.Fatal(err)
	}
	snap := s.snap()
	if snap.Thread.SessionID != "" {
		t.Fatalf("got %s", mustMarshal(snap.Thread))
	}
	last, ok := snap.Items[len(snap.Items)-1].Value.(*protocol.Notice)
	if !ok || last.Code != "session.new" || last.Level != protocol.NoticeLevelInfo {
		t.Fatalf("got %s", mustMarshal(snap.Items[len(snap.Items)-1]))
	}
	if s.h.changes.Load() == 0 {
		t.Fatal("ConfigChanged wasn't called")
	}
}

func TestCompact(t *testing.T) {
	ctx := context.Background()
	s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
	refused(t, s.sdk.Compact(ctx, s.id), "no conversation to compact")
	s.turn("one", "S1", "m1")
	n := len(s.snap().Items)
	if err := s.sdk.Handle(ctx, protocol.Command{Value: &protocol.CompactCommand{ThreadID: s.id}}); err != nil {
		t.Fatal(err)
	}
	if s.h.compacts.Load() != 1 {
		t.Fatalf("Compact called %d times", s.h.compacts.Load())
	}
	if st := s.snap().Thread.Status; st != protocol.ThreadStatusRunning {
		t.Fatalf("the thread is %s", st)
	}
	s.h.on(func(c agentthreads.ThreadContext) {
		c.AddItem(&protocol.Compaction{ID: "c1", Trigger: protocol.CompactionTriggerManual})
		c.EndTurn(agentthreads.TurnEnd{OK: true, SessionAt: "m2"})
	})
	snap := s.snap()
	expectSame(t, "items", kinds(snap.Items[n:]), []string{"compaction", "turn_result"})
	sessions := turnSessions(snap.Items)
	expectSame(t, "session", sessions[len(sessions)-1], &protocol.TurnSession{ID: "S1", At: "m2"})
}

func TestSessionsNeedTheHarness(t *testing.T) {
	ctx := context.Background()
	sdk := newEcho(t, nil, agentthreads.Allow)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{SessionID: "S0"})
	if err != nil {
		t.Fatal(err)
	}
	if th.SessionID != "S0" {
		t.Fatalf("got %s", mustMarshal(th))
	}
	if err := sdk.Send(ctx, th.ID, "hi", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	snap, _ := sdk.Snapshot(ctx, th.ID)
	refused(t, sdk.Rewind(ctx, th.ID, turnIDs(snap.Items)[0]), "echo threads can't be rewound")
	refused(t, sdk.Compact(ctx, th.ID), "echo threads can't be compacted")
}

func TestRewindPoints(t *testing.T) {
	s := func(id, at string, started bool) *protocol.TurnSession {
		return &protocol.TurnSession{ID: id, At: at, Started: started}
	}
	point := func(f rewindFunc, sessions []*protocol.TurnSession, i int) agentthreads.RewindPoint {
		t.Helper()
		p, err := f(sessions, i)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	type P = agentthreads.RewindPoint
	t.Run("resume at the latest mark before the turn, in its session", func(t *testing.T) {
		f := agentthreads.ResumeAtPoint
		expectSame(t, "1", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("A", "a3", false)}, 2), P{SessionID: "A", ResumeAt: "a1"})
		expectSame(t, "2", point(f, []*protocol.TurnSession{s("A", "a1", true), s("B", "b1", true)}, 1), P{})
		expectSame(t, "3", point(f, []*protocol.TurnSession{nil, s("A", "a1", true)}, 0), P{})
		var re *agentthreads.RewindError
		if _, err := f([]*protocol.TurnSession{s("A", "", true), s("A", "a2", false)}, 1); !errors.As(err, &re) {
			t.Fatalf("got %v", err)
		}
		if _, err := f([]*protocol.TurnSession{s("A", "a1", false)}, 0); !errors.As(err, &re) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("revert to before the first mark from the turn on, in its session", func(t *testing.T) {
		f := agentthreads.RevertPoint
		expectSame(t, "1", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("A", "a3", false)}, 1), P{SessionID: "A", ResumeAt: "a3"})
		expectSame(t, "2", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("B", "b1", true)}, 1), P{SessionID: "A"})
		expectSame(t, "3", point(f, []*protocol.TurnSession{s("A", "a1", true)}, 0), P{})
	})
}

// lostTurn is a thread whose turn was running when its backend went (without closing), loaded by
// another backend: created with sessionID, with before done to it first. It returns the second
// backend, the thread, and its snapshot.
func lostTurn(t *testing.T, sessionID string, before func(s *sessionsScene)) (*agentthreads.AgentThreads, string, protocol.Snapshot) {
	t.Helper()
	ctx := context.Background()
	store := agentthreads.NewMemoryStore()
	h := &sessionHarness{point: agentthreads.ResumeAtPoint}
	// Never closed: it goes as a backend that stopped would.
	first := agentthreads.New(agentthreads.Options{
		Store:        store,
		Harnesses:    map[string]agentthreads.Harness{"fake": h},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(error) {},
	})
	th, err := first.Create(ctx, agentthreads.CreateOptions{SessionID: sessionID})
	if err != nil {
		t.Fatal(err)
	}
	if before != nil {
		before(&sessionsScene{t: t, sdk: first, h: h, id: th.ID})
	}
	if err := first.Send(ctx, th.ID, "the lost one", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	// The harness says which session the turn runs in (a new one, if the thread had none), then the
	// backend goes.
	session := sessionID
	if session == "" {
		session = "S-new"
	}
	h.on(func(c agentthreads.ThreadContext) { c.SetThread(func(t *protocol.Thread) { t.SessionID = session }) })
	if _, err := first.EventsSince(ctx, th.ID, 0, 0); err != nil {
		t.Fatal(err)
	}
	next := agentthreads.New(agentthreads.Options{
		Store:        store,
		Harnesses:    map[string]agentthreads.Harness{"fake": &sessionHarness{point: agentthreads.ResumeAtPoint}},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	t.Cleanup(func() { next.Stop(context.Background()) })
	snap, err := next.Snapshot(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	return next, th.ID, snap
}

func TestLostTurnSession(t *testing.T) {
	ctx := context.Background()
	t.Run("records that it started the session it got", func(t *testing.T) {
		next, id, snap := lostTurn(t, "", nil)
		expectSame(t, "sessions", turnSessions(snap.Items), []*protocol.TurnSession{{ID: "S-new", Started: true, Lost: true}})
		if err := next.Rewind(ctx, id, turnIDs(snap.Items)[0]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, id); after.Thread.SessionID != "" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
	})
	t.Run("records that it started the one it got after a new_session", func(t *testing.T) {
		_, _, snap := lostTurn(t, "", func(s *sessionsScene) {
			s.turn("one", "S-old", "m1")
			if err := s.sdk.NewSession(ctx, s.id); err != nil {
				t.Fatal(err)
			}
		})
		expectSame(t, "sessions", turnSessions(snap.Items), []*protocol.TurnSession{{ID: "S-old", At: "m1", Started: true}, {ID: "S-new", Started: true, Lost: true}})
	})
	t.Run("is a compaction that had no items yet, not the turn before it", func(t *testing.T) {
		store := agentthreads.NewMemoryStore()
		h := &sessionHarness{point: agentthreads.ResumeAtPoint}
		// Never closed: it goes as a backend that stopped would.
		first := agentthreads.New(agentthreads.Options{
			Store:        store,
			Harnesses:    map[string]agentthreads.Harness{"fake": h},
			Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
			OnError:      func(error) {},
		})
		th, err := first.Create(ctx, agentthreads.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if err := first.Send(ctx, th.ID, "one", agentthreads.SendOptions{}); err != nil {
			t.Fatal(err)
		}
		h.on(func(c agentthreads.ThreadContext) {
			c.SetThread(func(t *protocol.Thread) { t.SessionID = "S" })
			c.EndTurn(agentthreads.TurnEnd{OK: true, SessionAt: "m1"})
		})
		if err := first.Compact(ctx, th.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := first.EventsSince(ctx, th.ID, 0, 0); err != nil {
			t.Fatal(err)
		}
		next := agentthreads.New(agentthreads.Options{
			Store:        store,
			Harnesses:    map[string]agentthreads.Harness{"fake": &sessionHarness{point: agentthreads.ResumeAtPoint}},
			Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
			OnError:      func(err error) { t.Errorf("OnError: %v", err) },
		})
		t.Cleanup(func() { next.Stop(context.Background()) })
		snap, err := next.Snapshot(ctx, th.ID)
		if err != nil {
			t.Fatal(err)
		}
		events, err := next.EventsSince(ctx, th.ID, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		var started, completed []string
		for _, e := range events {
			switch ev := e.Value.(type) {
			case *protocol.TurnStartedEvent:
				started = append(started, ev.TurnID)
			case *protocol.TurnCompletedEvent:
				completed = append(completed, ev.TurnID)
			}
		}
		expectSame(t, "turns completed", completed, started)
		expectSame(t, "turns", turnIDs(snap.Items), started)
		expectSame(t, "sessions", turnSessions(snap.Items), []*protocol.TurnSession{{ID: "S", At: "m1", Started: true}, {ID: "S", Lost: true}})
		if err := next.Rewind(ctx, th.ID, started[1]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, th.ID); after.Thread.SessionID != "S" || after.Thread.ResumeAt != "m1" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
	})
	t.Run("records that it continued a session the thread adopted", func(t *testing.T) {
		next, id, snap := lostTurn(t, "S0", nil)
		expectSame(t, "sessions", turnSessions(snap.Items), []*protocol.TurnSession{{ID: "S0", Lost: true}})
		refused(t, next.Rewind(ctx, id, turnIDs(snap.Items)[0]), "can't be rewound to before that turn")
	})
	t.Run("keeps the mark the harness gave before it was lost, for a rewind to after it", func(t *testing.T) {
		next, id, snap := lostBetween(t, agentthreads.ResumeAtPoint, "m2")
		expectSame(t, "sessions", turnSessions(snap.Items), []*protocol.TurnSession{{ID: "S", At: "m1", Started: true}, {ID: "S", At: "m2"}, {ID: "S", At: "m3"}})
		if snap.Thread.TurnAt != "" {
			t.Fatalf("turn_at: %q", snap.Thread.TurnAt)
		}
		if err := next.Rewind(ctx, id, turnIDs(snap.Items)[2]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, id); after.Thread.SessionID != "S" || after.Thread.ResumeAt != "m2" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
	})
	t.Run("refuses a rewind past a lost turn with no mark, which may have added to the session", func(t *testing.T) {
		next, id, snap := lostBetween(t, agentthreads.ResumeAtPoint, "")
		expectSame(t, "the lost one's session", turnSessions(snap.Items)[1], &protocol.TurnSession{ID: "S", Lost: true})
		turns := turnIDs(snap.Items)
		refused(t, next.Rewind(ctx, id, turns[2]), "lost")
		// To before it is still known.
		if err := next.Rewind(ctx, id, turns[1]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, id); after.Thread.SessionID != "S" || after.Thread.ResumeAt != "m1" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
	})
	t.Run("reverts to before a lost turn by its mark (Codex), and refuses to with none", func(t *testing.T) {
		next, id, snap := lostBetween(t, agentthreads.RevertPoint, "c2")
		if err := next.Rewind(ctx, id, turnIDs(snap.Items)[1]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, id); after.Thread.SessionID != "S" || after.Thread.ResumeAt != "c2" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
		next, id, snap = lostBetween(t, agentthreads.RevertPoint, "")
		turns := turnIDs(snap.Items)
		refused(t, next.Rewind(ctx, id, turns[1]), "lost")
		// To before turn one, which started S, is a new session.
		if err := next.Rewind(ctx, id, turns[0]); err != nil {
			t.Fatal(err)
		}
		if after, _ := next.Snapshot(ctx, id); after.Thread.SessionID != "" {
			t.Fatalf("got %s", mustMarshal(after.Thread))
		}
	})
}

// lostBetween is a thread with turn one in session S (marked m1), then a turn the backend lost after
// the harness gave it mark (if not ""), then turn three in S (marked m3), run by a second backend.
// It returns that backend, the thread, and its snapshot.
func lostBetween(t *testing.T, point rewindFunc, mark string) (*agentthreads.AgentThreads, string, protocol.Snapshot) {
	t.Helper()
	ctx := context.Background()
	store := agentthreads.NewMemoryStore()
	h := &sessionHarness{point: point}
	// Never closed: it goes as a backend that stopped would.
	first := agentthreads.New(agentthreads.Options{
		Store:        store,
		Harnesses:    map[string]agentthreads.Harness{"fake": h},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(error) {},
	})
	th, err := first.Create(ctx, agentthreads.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	(&sessionsScene{t: t, sdk: first, h: h, id: th.ID}).turn("one", "S", "m1")
	if err := first.Send(ctx, th.ID, "two", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	if mark != "" {
		h.on(func(c agentthreads.ThreadContext) { c.Mark(mark) })
	}
	if _, err := first.EventsSince(ctx, th.ID, 0, 0); err != nil {
		t.Fatal(err)
	}
	h2 := &sessionHarness{point: point}
	next := agentthreads.New(agentthreads.Options{
		Store:        store,
		Harnesses:    map[string]agentthreads.Harness{"fake": h2},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	t.Cleanup(func() { next.Stop(context.Background()) })
	if _, err := next.Snapshot(ctx, th.ID); err != nil {
		t.Fatal(err)
	}
	(&sessionsScene{t: t, sdk: next, h: h2, id: th.ID}).turn("three", "", "m3")
	snap, err := next.Snapshot(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	return next, th.ID, snap
}

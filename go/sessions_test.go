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

// on runs fn with the thread's context on its goroutine, and waits for it.
func (h *sessionHarness) on(fn func(agentthreads.ThreadContext)) {
	ctx := *h.ctx.Load()
	done := make(chan struct{})
	ctx.Post(func() {
		fn(ctx)
		close(done)
	})
	<-done
}

type sessionFake struct{ h *sessionHarness }

func (s *sessionFake) Start([]agentthreads.Message)     {}
func (s *sessionFake) Steer(agentthreads.Message)       {}
func (s *sessionFake) CarryOver([]agentthreads.Message) {}
func (s *sessionFake) Interrupt()                       {}
func (s *sessionFake) Live() bool                       { return false }
func (s *sessionFake) Release()                         {}
func (s *sessionFake) OptionsChanged()                  { s.h.changes.Add(1) }
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

func sameAs(t *testing.T, what string, got, want any) {
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
		sameAs(t, "sessions", turnSessions(s.snap().Items), []*protocol.TurnSession{
			{ID: "S1", At: "m1", Started: true}, {ID: "S1", At: "m2"}, {ID: "S1"}, {ID: "S2", At: "m4", Started: true},
		})
	})
	t.Run("is left out when the turn ended with no session", func(t *testing.T) {
		s := newSessionsScene(t, agentthreads.ResumeAtPoint, "")
		s.turn("one", "", "")
		sameAs(t, "sessions", turnSessions(s.snap().Items), []*protocol.TurnSession{nil})
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
		sameAs(t, "items", kinds(snap.Items), []string{"user_message", "assistant_message", "turn_result", "rewind"})
		if n, ok := snap.Items[3].Value.(*protocol.Notice); !ok || n.Level != protocol.NoticeLevelInfo {
			t.Fatalf("got %s", mustMarshal(snap.Items[3]))
		}
		if snap.Thread.SessionID != "S1" || snap.Thread.ResumeAt != "m1" {
			t.Fatalf("got %s", mustMarshal(snap.Thread))
		}
		if got := s.h.changes.Load(); got != changes+1 {
			t.Fatalf("OptionsChanged %d times, not once", got-changes)
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
		sameAs(t, "removed", removed, want)
		first := events[0].Value.(*protocol.ThreadUpdatedEvent).Thread
		sameAs(t, "the snapshot", snap, protocol.ApplyEvents(protocol.InitialState(first), events))
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
		sameAs(t, "items", kinds(snap.Items), []string{"rewind"})
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
		sameAs(t, "items", kinds(snap.Items), []string{"user_message", "assistant_message", "turn_result", "session.new", "rewind"})
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
		sameAs(t, "the snapshot", s.snap(), before)
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
		t.Fatal("OptionsChanged wasn't called")
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
	sameAs(t, "items", kinds(snap.Items[n:]), []string{"compaction", "turn_result"})
	sessions := turnSessions(snap.Items)
	sameAs(t, "session", sessions[len(sessions)-1], &protocol.TurnSession{ID: "S1", At: "m2"})
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
		sameAs(t, "1", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("A", "a3", false)}, 2), P{SessionID: "A", ResumeAt: "a1"})
		sameAs(t, "2", point(f, []*protocol.TurnSession{s("A", "a1", true), s("B", "b1", true)}, 1), P{})
		sameAs(t, "3", point(f, []*protocol.TurnSession{nil, s("A", "a1", true)}, 0), P{})
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
		sameAs(t, "1", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("A", "a3", false)}, 1), P{SessionID: "A", ResumeAt: "a3"})
		sameAs(t, "2", point(f, []*protocol.TurnSession{s("A", "a1", true), s("A", "", false), s("B", "b1", true)}, 1), P{SessionID: "A"})
		sameAs(t, "3", point(f, []*protocol.TurnSession{s("A", "a1", true)}, 0), P{})
	})
}

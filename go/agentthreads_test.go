package agentthreads_test

// The API, with a harness of the test's own (no process): commands and their errors, events by
// subscriber and channel, snapshots and catching up, deleting, closing, and a store that fails for
// a while.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// echoHarness replies to each turn with the message's text, at once, and asks permission for the
// message "ask" first.
type echoHarness struct{}

func (echoHarness) Name() string { return "echo" }

func (echoHarness) Open(ctx agentthreads.ThreadContext) agentthreads.Session {
	return &echoSession{ctx: ctx}
}

type echoSession struct {
	ctx    agentthreads.ThreadContext
	closed bool
}

func (s *echoSession) Start(ms []agentthreads.Message) {
	text := ms[len(ms)-1].Text
	reply := func() {
		s.ctx.AddItem(&protocol.AssistantMessage{ID: agentthreads.NewID("a"), Text: "you said: " + text})
		s.ctx.EndTurn(agentthreads.TurnEnd{OK: true, Usage: &protocol.Usage{InputTokens: 1, OutputTokens: 2}})
	}
	if text != "ask" {
		reply()
		return
	}
	call := agentthreads.NewID("tc")
	s.ctx.AddItem(&protocol.ToolCall{ID: call, Name: "Bash", Kind: protocol.ToolKindShell, Input: []byte(`{"command":"ls"}`), Command: "ls", Status: protocol.ToolStatusRunning})
	q := agentthreads.PermissionQuery{Name: "Bash", Kind: protocol.ToolKindShell, Input: []byte(`{"command":"ls"}`), Command: "ls", ToolCallID: call}
	switch d := s.ctx.Decide(q); {
	case d.IsAsk():
		s.ctx.Ask(&protocol.PermissionRequest{Name: "Bash", Kind: protocol.ToolKindShell, Input: q.Input, Title: "ls"}, call, func(r protocol.Resolution) {
			s.ctx.UpdateItem(call, agentthreads.Patch{"status": protocol.ToolStatusCompleted, "result": protocol.ToolResult{Content: string(r.Outcome)}})
			reply()
		}, agentthreads.PermissionKey(q))
	default:
		s.ctx.UpdateItem(call, agentthreads.Patch{"status": protocol.ToolStatusCompleted, "result": protocol.ToolResult{Content: d.String()}})
		reply()
	}
}

func (s *echoSession) Steer(agentthreads.Message)          {}
func (s *echoSession) CarryOver(ms []agentthreads.Message) { s.Start(ms) }
func (s *echoSession) Interrupt()                          { s.ctx.EndTurn(agentthreads.TurnEnd{}) }
func (s *echoSession) Live() bool                          { return false }
func (s *echoSession) Release()                            {}
func (s *echoSession) OptionsChanged()                     {}
func (s *echoSession) Close(done func())                   { s.closed = true; done() }

func newEcho(t *testing.T, store agentthreads.Store, policy agentthreads.PermissionPolicy) *agentthreads.AgentThreads {
	sdk := agentthreads.New(agentthreads.Options{
		Store:        store,
		Harnesses:    map[string]agentthreads.Harness{"echo": echoHarness{}},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
		OnError:      func(error) {},
	})
	t.Cleanup(func() { sdk.Stop(context.Background()) })
	return sdk
}

func TestCommands(t *testing.T) {
	ctx := context.Background()
	sdk := newEcho(t, nil, agentthreads.Allow)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Metadata: map[string]any{"user": "u1"}})
	if err != nil {
		t.Fatal(err)
	}
	if th.Harness != "echo" || th.Status != protocol.ThreadStatusIdle || string(th.Metadata["user"]) != `"u1"` {
		t.Fatalf("got %s", mustMarshal(th))
	}
	var ce *agentthreads.CommandError
	for _, bad := range []string{
		`{"type":"send","thread_id":"` + th.ID + `"}`,
		`{"type":"send","thread_id":"nope","text":"hi"}`,
		`{"type":"dance","thread_id":"` + th.ID + `"}`,
		`not json`,
	} {
		if err := sdk.HandleJSON(ctx, []byte(bad)); !errors.As(err, &ce) {
			t.Errorf("%s: got %v", bad, err)
		}
	}
	if _, err := sdk.Create(ctx, agentthreads.CreateOptions{Harness: "grok"}); !errors.As(err, &ce) {
		t.Errorf("an unknown harness: %v", err)
	}

	if err := sdk.HandleJSON(ctx, []byte(`{"type":"send","thread_id":"`+th.ID+`","text":"hello","client_id":"c1"}`)); err != nil {
		t.Fatal(err)
	}
	snap, err := sdk.Snapshot(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Thread.Status != protocol.ThreadStatusIdle || len(snap.Items) != 3 || snap.Thread.Usage == nil || snap.Thread.Usage.OutputTokens != 2 {
		t.Fatalf("got %s", mustMarshal(snap))
	}
	if text, _ := snap.Items[1].Text(); text != "you said: hello" {
		t.Fatalf("got %q", text)
	}
	// Catching up: the saved events after a seq.
	events, err := sdk.EventsSince(ctx, th.ID, snap.Seq-2, 0)
	if err != nil || len(events) != 2 || events[1].Seq() != snap.Seq {
		t.Fatalf("got %v, %v", events, err)
	}
	if _, err := sdk.EventsSince(ctx, "nope", 0, 0); !errors.As(err, &ce) {
		t.Errorf("an unknown thread's events: %v", err)
	}

	// Options: "" clears one.
	sdk.HandleJSON(ctx, []byte(`{"type":"set_options","thread_id":"`+th.ID+`","model":"opus","permission_mode":"plan"}`))
	got, _ := sdk.Get(ctx, th.ID)
	if got.Model != "opus" || got.PermissionMode != protocol.PermissionModePlan {
		t.Fatalf("got %s", mustMarshal(got))
	}
	sdk.HandleJSON(ctx, []byte(`{"type":"set_options","thread_id":"`+th.ID+`","model":""}`))
	if got, _ = sdk.Get(ctx, th.ID); got.Model != "" {
		t.Fatalf("got %s", mustMarshal(got))
	}

	// Deleting.
	if ok, err := sdk.Delete(ctx, th.ID); !ok || err != nil {
		t.Fatalf("delete: %v %v", ok, err)
	}
	if got, _ := sdk.Get(ctx, th.ID); got != nil {
		t.Fatal("still there")
	}
	// Closed, it refuses commands.
	sdk.Close(ctx)
	if _, err := sdk.Create(ctx, agentthreads.CreateOptions{}); !errors.As(err, &ce) {
		t.Errorf("closed: %v", err)
	}
}

func TestRequestsAndStandingAnswers(t *testing.T) {
	ctx := context.Background()
	sdk := newEcho(t, nil, agentthreads.Ask)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{})
	sdk.Send(ctx, th.ID, "ask", agentthreads.SendOptions{})
	snap, _ := sdk.Snapshot(ctx, th.ID)
	if snap.Thread.Status != protocol.ThreadStatusWaiting || len(snap.Requests) != 1 {
		t.Fatalf("got %s", mustMarshal(snap))
	}
	// Answering one that isn't open does nothing.
	if err := sdk.Respond(ctx, th.ID, "nope", protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow}); err != nil {
		t.Fatal(err)
	}
	sdk.Respond(ctx, th.ID, snap.Requests[0].ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow, Always: true})
	if snap, _ = sdk.Snapshot(ctx, th.ID); snap.Thread.Status != protocol.ThreadStatusIdle || len(snap.Requests) != 0 {
		t.Fatalf("got %s", mustMarshal(snap))
	}
	// Allowed always: the next one isn't asked.
	sdk.Send(ctx, th.ID, "ask", agentthreads.SendOptions{})
	if snap, _ = sdk.Snapshot(ctx, th.ID); snap.Thread.Status != protocol.ThreadStatusIdle {
		t.Fatalf("asked again: %s", mustMarshal(snap))
	}
}

func TestEventsInOrder(t *testing.T) {
	ctx := context.Background()
	sdk := newEcho(t, nil, agentthreads.Allow)
	chCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ch := sdk.Events(chCtx)
	var mu sync.Mutex
	var subscribed []int64
	sdk.Subscribe(func(e protocol.ThreadEvent) {
		mu.Lock()
		subscribed = append(subscribed, e.Seq())
		mu.Unlock()
	})
	var threads []protocol.Thread
	for range 3 {
		th, _ := sdk.Create(ctx, agentthreads.CreateOptions{})
		threads = append(threads, th)
	}
	var wg sync.WaitGroup
	for _, th := range threads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 5 {
				sdk.Send(ctx, th.ID, "hi", agentthreads.SendOptions{})
			}
		}()
	}
	wg.Wait()
	// Each thread's saved events come in seq order, one after the other.
	last := map[string]int64{}
	deadline := time.After(5 * time.Second)
	want := 0
	for _, th := range threads {
		snap, _ := sdk.Snapshot(ctx, th.ID)
		want += int(snap.Seq)
	}
	got := 0
	for got < want {
		select {
		case e := <-ch:
			if !e.Saved() {
				continue
			}
			if e.Seq() != last[e.ThreadID()]+1 {
				t.Fatalf("%s: seq %d after %d", e.ThreadID(), e.Seq(), last[e.ThreadID()])
			}
			last[e.ThreadID()] = e.Seq()
			got++
		case <-deadline:
			t.Fatalf("got %d of %d events", got, want)
		}
	}
	// Close returns once the subscribers have had everything.
	sdk.Close(ctx)
	mu.Lock()
	n := len(subscribed)
	mu.Unlock()
	if n != want {
		t.Fatalf("the subscriber had %d of %d", n, want)
	}
}

// flaky fails its writes while broken is set.
type flaky struct {
	*agentthreads.MemoryStore
	mu     sync.Mutex
	broken bool
}

func (f *flaky) AppendEvents(ctx context.Context, id string, events []protocol.ThreadEvent, runs []agentthreads.RunRecord) error {
	f.mu.Lock()
	broken := f.broken
	f.mu.Unlock()
	if broken {
		return errors.New("the disk is full")
	}
	return f.MemoryStore.AppendEvents(ctx, id, events, runs)
}

func TestAStoreThatFailsForAWhile(t *testing.T) {
	ctx := context.Background()
	store := &flaky{MemoryStore: agentthreads.NewMemoryStore()}
	sdk := newEcho(t, store, agentthreads.Allow)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{})
	store.mu.Lock()
	store.broken = true
	store.mu.Unlock()
	sdk.Send(ctx, th.ID, "one", agentthreads.SendOptions{})
	sdk.Send(ctx, th.ID, "two", agentthreads.SendOptions{})
	if _, err := sdk.EventsSince(ctx, th.ID, 0, 0); err == nil || !strings.Contains(err.Error(), "disk is full") {
		t.Fatalf("got %v", err)
	}
	store.mu.Lock()
	store.broken = false
	store.mu.Unlock()
	// Tried again, in order: nothing lost, nothing twice.
	deadline := time.Now().Add(5 * time.Second)
	for {
		events, err := sdk.EventsSince(ctx, th.ID, 0, 0)
		snap, _ := sdk.Snapshot(ctx, th.ID)
		if err == nil && int64(len(events)) == snap.Seq {
			for i, e := range events {
				if e.Seq() != int64(i+1) {
					t.Fatalf("event %d has seq %d", i, e.Seq())
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not saved: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// gatedStore's GetRun fails while failing is set, and waits for gate while it's set.
type gatedStore struct {
	*agentthreads.MemoryStore
	mu      sync.Mutex
	failing bool
	gate    chan struct{}
	reached chan struct{}
}

func (g *gatedStore) GetRun(ctx context.Context, id string) (*agentthreads.RunRecord, error) {
	g.mu.Lock()
	failing, gate, reached := g.failing, g.gate, g.reached
	g.mu.Unlock()
	if failing {
		return nil, errors.New("the database is busy")
	}
	if gate != nil {
		close(reached)
		<-gate
	}
	return g.MemoryStore.GetRun(ctx, id)
}

// savedRunning is a store with a thread that was running, under the shim, when its backend stopped.
func savedRunning(t *testing.T) (*gatedStore, string) {
	ctx := context.Background()
	store := &gatedStore{MemoryStore: agentthreads.NewMemoryStore()}
	th := protocol.Thread{ID: "th_saved", Harness: "echo", Status: protocol.ThreadStatusRunning, CreatedAt: "2026-11-01T00:00:00Z",
		Run: &protocol.Run{ID: "run_1", Spawner: protocol.RunSpawnerShim, StartedAt: "2026-11-01T00:00:01Z"}}
	if err := store.CreateThread(ctx, th); err != nil {
		t.Fatal(err)
	}
	evs := events(t,
		`{"type":"thread.updated","thread_id":"th_saved","seq":1,"thread":`+string(mustMarshal(th))+`}`,
		`{"type":"item.added","thread_id":"th_saved","seq":2,"item":{"id":"u1","type":"user_message","text":"hi","turn_id":"t1"}}`,
		`{"type":"turn.started","thread_id":"th_saved","seq":3,"turn_id":"t1"}`,
	)
	run := agentthreads.RunRecord{ID: "run_1", ThreadID: "th_saved", Spawner: "shim", StartedAt: "2026-11-01T00:00:01Z"}
	if err := store.AppendEvents(ctx, "th_saved", evs, []agentthreads.RunRecord{run}); err != nil {
		t.Fatal(err)
	}
	return store, "th_saved"
}

func noticeCodes(s protocol.Snapshot) []string {
	var out []string
	for _, it := range s.Items {
		if n, ok := it.Value.(*protocol.Notice); ok {
			out = append(out, n.Code)
		}
	}
	return out
}

// A store that can't say what run a thread had leaves it to be loaded again, rather than taking a
// run that may still be going for lost.
func TestLoadingWhenTheStoreFails(t *testing.T) {
	ctx := context.Background()
	store, id := savedRunning(t)
	store.failing = true
	sdk := newEcho(t, store, agentthreads.Allow)
	if _, err := sdk.Snapshot(ctx, id); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("got %v", err)
	}
	if th, _ := store.MemoryStore.GetThread(ctx, id); th.Status != protocol.ThreadStatusRunning || th.Run == nil {
		t.Fatalf("the thread changed: %s", mustMarshal(th))
	}
	store.mu.Lock()
	store.failing = false
	store.mu.Unlock()
	// Loaded again: with the direct spawner, the run can't be followed, so it's lost now.
	snap, err := sdk.Snapshot(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if codes := noticeCodes(snap); len(codes) != 1 || codes[0] != "run.lost" || snap.Thread.Run != nil {
		t.Fatalf("got %s", mustMarshal(snap))
	}
}

// A command for a thread that's being loaded waits for its recovery, so recovery doesn't take the
// turn the command starts for the one it lost.
func TestACommandWaitsForRecovery(t *testing.T) {
	ctx := context.Background()
	store, id := savedRunning(t)
	store.gate, store.reached = make(chan struct{}), make(chan struct{})
	sdk := newEcho(t, store, agentthreads.Allow)
	loaded := make(chan error, 1)
	go func() { _, err := sdk.Snapshot(ctx, id); loaded <- err }()
	<-store.reached
	sent := make(chan error, 1)
	go func() { sent <- sdk.Send(ctx, id, "again", agentthreads.SendOptions{}) }()
	select {
	case err := <-sent:
		t.Fatalf("the command went ahead of recovery: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	store.mu.Lock()
	gate := store.gate
	store.gate = nil
	store.mu.Unlock()
	close(gate)
	if err := <-loaded; err != nil {
		t.Fatal(err)
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	snap, _ := sdk.Snapshot(ctx, id)
	var results []*protocol.TurnResult
	for _, it := range snap.Items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			results = append(results, r)
		}
	}
	// The lost turn ended, then the new one ran.
	if len(results) != 2 || results[0].OK || !results[1].OK || snap.Thread.Status != protocol.ThreadStatusIdle {
		t.Fatalf("got %s", mustMarshal(snap))
	}
}

// A command's wait gives up with its context.
func TestCommandsHonourTheirContext(t *testing.T) {
	sdk := newEcho(t, nil, agentthreads.Allow)
	th, _ := sdk.Create(context.Background(), agentthreads.CreateOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sdk.Send(ctx, th.ID, "hi", agentthreads.SendOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

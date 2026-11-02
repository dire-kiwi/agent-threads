package agentthreads_test

// Background subagents, which the recordings cover only when nothing goes wrong: their calls and
// requests outlive their turn, and they're stopped when their run ends. mini-claude.mjs (the Node
// backend's test harness) plays Claude.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func miniClaude(t *testing.T, policy agentthreads.PermissionPolicy, env map[string]string, tools ...agentthreads.Tool) (*agentthreads.AgentThreads, *recorder) {
	needNode(t)
	mini := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-claude.mjs")
	rec := &recorder{}
	sdk := agentthreads.New(agentthreads.Options{
		Store:        agentthreads.NewMemoryStore(),
		Harnesses:    map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: mini, Env: env})},
		Capabilities: agentthreads.Capabilities{Permissions: policy, Tools: tools},
		Spawner:      agentthreads.Direct(),
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	sdk.Subscribe(rec.add)
	t.Cleanup(func() { sdk.Stop(context.Background()) })
	return sdk, rec
}

func toolCalls(snap protocol.Snapshot) []*protocol.ToolCall {
	var out []*protocol.ToolCall
	for _, it := range snap.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok {
			out = append(out, c)
		}
	}
	return out
}

func TestABackgroundSubagentOutlivesItsTurn(t *testing.T) {
	ctx := context.Background()
	shell := agentthreads.PolicyFunc(func(_ context.Context, q agentthreads.PermissionQuery, _ agentthreads.PermissionContext) agentthreads.Decision {
		if q.Kind == protocol.ToolKindShell {
			return agentthreads.Ask
		}
		return agentthreads.Allow
	})
	sdk, rec := miniClaude(t, shell, nil)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Model: "mini", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	sdk.Send(ctx, th.ID, "background 0 apple", agentthreads.SendOptions{})
	// The turn ends with the subagent's call waiting for the user, who's still asked.
	if rec.waitFor(0, []byte(`{"type":"turn.completed"}`), waitFor) < 0 {
		t.Fatal("the turn didn't end")
	}
	snap, _ := sdk.Snapshot(ctx, th.ID)
	calls := toolCalls(snap)
	if snap.Thread.Status != protocol.ThreadStatusWaiting || len(protocol.OpenRequests(snap)) != 1 || len(calls) != 2 {
		t.Fatalf("after the turn:\n%s", show(rec.all()))
	}
	agent, bash := calls[0], calls[1]
	if agent.Status != protocol.ToolStatusCompleted || agent.Subagent == nil || agent.Subagent.Status != protocol.SubagentStatusRunning || !agent.Subagent.Background || agent.Subagent.Model != "mini-1" {
		t.Fatalf("the Agent call: %s", mustMarshal(agent))
	}
	if bash.Status != protocol.ToolStatusPending || bash.ParentID != agent.ID {
		t.Fatalf("the subagent's call: %s", mustMarshal(bash))
	}

	sdk.Respond(ctx, th.ID, protocol.OpenRequests(snap)[0].ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow})
	until(t, func() bool {
		snap, _ = sdk.Snapshot(ctx, th.ID)
		results := 0
		for _, it := range snap.Items {
			if _, ok := it.Value.(*protocol.TurnResult); ok {
				results++
			}
		}
		return results == 2 && snap.Thread.Status == protocol.ThreadStatusIdle
	})
	calls = toolCalls(snap)
	want := `{"status":"completed","background":true,"agent_type":"general-purpose","model":"mini-1","activity":"Running true","tool_uses":1,"summary":"apple"}`
	if got := string(mustMarshal(calls[0].Subagent)); got != want {
		t.Fatalf("the subagent: %s", got)
	}
	if calls[1].Status != protocol.ToolStatusCompleted {
		t.Fatalf("the subagent's call: %s", mustMarshal(calls[1]))
	}
	// Claude's own turn has no message of the user's, and says what the subagent did.
	var second string
	for _, it := range snap.Items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			second = r.TurnID
		}
	}
	last := ""
	for _, it := range snap.Items {
		if u, ok := it.Value.(*protocol.UserMessage); ok && u.TurnID == second {
			t.Fatalf("a message in Claude's own turn: %s", mustMarshal(u))
		}
		if m, ok := it.Value.(*protocol.AssistantMessage); ok {
			last = m.Text
		}
	}
	if last != "the subagent said apple" {
		t.Fatalf("the last reply is %q", last)
	}
}

func TestARunsSubagentsStopWithIt(t *testing.T) {
	ctx := context.Background()
	sdk, rec := miniClaude(t, agentthreads.Allow, nil)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Model: "mini", Cwd: t.TempDir()})
	sdk.Send(ctx, th.ID, "background 60000 apple", agentthreads.SendOptions{})
	until(t, func() bool {
		snap, _ := sdk.Snapshot(ctx, th.ID)
		calls := toolCalls(snap)
		return snap.Thread.Status == protocol.ThreadStatusIdle && len(calls) == 2 && calls[1].Status == protocol.ToolStatusRunning
	})
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}
	var subagent, bash string
	for _, e := range rec.all() {
		if u, ok := e.Value.(*protocol.ItemUpdatedEvent); ok {
			if s, ok := u.Patch["subagent"]; ok {
				subagent = string(s)
			}
			if s, ok := u.Patch["status"]; ok && strings.Contains(string(s), "cancelled") {
				bash = u.ItemID
			}
		}
	}
	if !strings.Contains(subagent, `"status":"stopped"`) || bash == "" {
		t.Fatalf("after closing:\n%s", show(rec.all()))
	}
}

func turnResults(snap protocol.Snapshot) []*protocol.TurnResult {
	var out []*protocol.TurnResult
	for _, it := range snap.Items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			out = append(out, r)
		}
	}
	return out
}

func TestAUsersTurnOutlastsATurnClaudeMakesBeforeTakingItsMessageIn(t *testing.T) {
	ctx := context.Background()
	sdk, rec := miniClaude(t, agentthreads.Allow, map[string]string{"MINI_CLAUDE_NOTIFY_FIRST": "1"})
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Model: "mini", Cwd: t.TempDir()})
	sdk.Send(ctx, th.ID, "background 300 apple", agentthreads.SendOptions{})
	if rec.waitFor(0, []byte(`{"type":"turn.completed"}`), waitFor) < 0 {
		t.Fatal("the turn didn't end")
	}
	// Sent before the subagent is done: Claude reports the subagent first, then takes this in.
	sdk.Send(ctx, th.ID, "reply hi", agentthreads.SendOptions{})
	var snap protocol.Snapshot
	until(t, func() bool {
		snap, _ = sdk.Snapshot(ctx, th.ID)
		last := ""
		for _, it := range snap.Items {
			if m, ok := it.Value.(*protocol.AssistantMessage); ok {
				last = m.Text
			}
		}
		return last == "hi" && snap.Thread.Status == protocol.ThreadStatusIdle
	})
	results := turnResults(snap)
	if len(results) != 2 {
		t.Fatalf("turns:\n%s", show(rec.all()))
	}
	// The user's turn has its message, both replies, and both results' usage.
	var in []string
	for _, it := range snap.Items {
		if it.TurnID() != results[1].TurnID {
			continue
		}
		switch v := it.Value.(type) {
		case *protocol.UserMessage:
			in = append(in, v.Text)
		case *protocol.AssistantMessage:
			in = append(in, v.Text)
		}
	}
	if strings.Join(in, "|") != "reply hi|the subagent said apple|hi" || results[1].Usage == nil || results[1].Usage.InputTokens != 2 {
		t.Fatalf("the user's turn has %q, used %s:\n%s", in, mustMarshal(results[1].Usage), show(rec.all()))
	}
}

func TestABackgroundSubagentsAppToolKeepsItsStructuredOutputPastItsTurn(t *testing.T) {
	ctx := context.Background()
	lookup := agentthreads.ToolFunc("lookup", "Looks it up.", json.RawMessage(`{"type":"object"}`), func(context.Context, json.RawMessage, agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
		return agentthreads.ToolOutput{Text: "42", Structured: map[string]any{"answer": 42}}, nil
	})
	sdk, rec := miniClaude(t, agentthreads.Allow, map[string]string{"MINI_CLAUDE_BACKGROUND_APP": "lookup"}, lookup)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Model: "mini", Cwd: t.TempDir()})
	sdk.Send(ctx, th.ID, "background 200 apple", agentthreads.SendOptions{})
	var snap protocol.Snapshot
	until(t, func() bool {
		snap, _ = sdk.Snapshot(ctx, th.ID)
		return len(turnResults(snap)) == 2 && snap.Thread.Status == protocol.ThreadStatusIdle
	})
	for _, c := range toolCalls(snap) {
		if c.Name == "lookup" {
			if c.Result == nil || string(mustMarshal(c.Result.Structured)) != `{"answer":42}` {
				t.Fatalf("the call: %s\n%s", mustMarshal(c), show(rec.all()))
			}
			return
		}
	}
	t.Fatalf("no lookup call:\n%s", show(rec.all()))
}

func TestALostRunStopsItsBackgroundSubagents(t *testing.T) {
	for _, how := range []string{"running", "waiting"} {
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			// The direct spawner's runs go with the backend: the next can't pick them up.
			extra := []string{"SPAWNER=direct"}
			want := protocol.ThreadStatusIdle
			if how == "waiting" {
				extra = append(extra, "POLICY=ask")
				want = protocol.ThreadStatusWaiting
			}
			s := miniScene(t, extra...)
			a := s.start()
			id := s.create(a, "claude")
			a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "background 60000 apple"})
			until(t, func() bool {
				snap := snapshotOf(t, a, id)
				calls := toolCalls(snap)
				return len(turnResults(snap)) == 1 && snap.Thread.Status == want && len(calls) == 2
			})
			a.call("saved", id)
			a.crash()

			b := s.start()
			snap := snapshotOf(t, b, id)
			b.call("stop")
			<-b.exited
			calls := toolCalls(snap)
			if len(calls) != 2 || calls[0].Subagent == nil || calls[0].Subagent.Status != protocol.SubagentStatusStopped || calls[1].Status != protocol.ToolStatusCancelled {
				t.Fatalf("the calls: %s", mustMarshal(calls))
			}
			// Its one turn had ended: it isn't ended again.
			if snap.Thread.Status != protocol.ThreadStatusIdle || snap.Thread.Run != nil || len(protocol.OpenRequests(snap)) != 0 || len(turnResults(snap)) != 1 {
				t.Fatalf("after: %s", mustMarshal(snap))
			}
		})
	}
}

func TestARestartTakesUpABackgroundSubagentsRequestWithNoTurnRunning(t *testing.T) {
	t.Run("permission", func(t *testing.T) { takesUpABackgroundSubagentsRequest(t, false) })
	// With late answers on too: it's the subagent's still, not a question kept open after its turn.
	t.Run("question", func(t *testing.T) { takesUpABackgroundSubagentsRequest(t, true) })
}

// takesUpABackgroundSubagentsRequest: the request is taken up again as it was (the same one), and
// the answer goes to the subagent.
func takesUpABackgroundSubagentsRequest(t *testing.T, asks bool) {
	extra := []string{"POLICY=ask"}
	if asks {
		extra = append(extra, "MINI_CLAUDE_BACKGROUND_ASK="+question, "LATE_ANSWERS=1")
	}
	s := miniScene(t, extra...)
	a := s.start()
	id := s.create(a, "claude")
	a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "background 200 apple"})
	var before protocol.Snapshot
	until(t, func() bool {
		before = snapshotOf(t, a, id)
		return len(turnResults(before)) == 1 && before.Thread.Status == protocol.ThreadStatusWaiting
	})
	a.call("saved", id)
	a.call("close")
	<-a.exited

	b := s.start()
	expectRecovered(t, b, id)
	snap := snapshotOf(t, b, id)
	open := protocol.OpenRequests(snap)
	if snap.Thread.Status != protocol.ThreadStatusWaiting || len(open) != 1 {
		t.Fatalf("after the restart: %s", mustMarshal(snap))
	}
	_, isQuestion := open[0].Value.(*protocol.QuestionRequest)
	if open[0].ID() != protocol.OpenRequests(before)[0].ID() || isQuestion != asks {
		t.Fatalf("the request was %s, and is %s", mustMarshal(protocol.OpenRequests(before)[0]), mustMarshal(open[0]))
	}
	for _, e := range b.events.all() {
		if _, ok := e.Value.(*protocol.RequestResolvedEvent); ok {
			t.Fatalf("a request was resolved: %s", mustMarshal(e))
		}
	}
	from := len(b.events.all())
	resolution := map[string]any{"outcome": "allow"}
	if asks {
		resolution = map[string]any{"outcome": "answer", "answers": map[string]any{"Colour?": []string{"Blue"}}}
	}
	b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": open[0].ID(), "resolution": resolution})
	// Answered with no turn running, the thread is idle; then Claude's report is a turn of its own.
	completed := func() (started, done int, statuses []protocol.ThreadStatus) {
		for _, e := range b.events.all()[from:] {
			switch v := e.Value.(type) {
			case *protocol.TurnStartedEvent:
				started++
			case *protocol.TurnCompletedEvent:
				done++
			case *protocol.ThreadUpdatedEvent:
				statuses = append(statuses, v.Thread.Status)
			}
		}
		return
	}
	until(t, func() bool { _, done, _ := completed(); return done == 1 })
	snap = snapshotOf(t, b, id)
	b.call("stop")
	<-b.exited
	started, _, statuses := completed()
	results := turnResults(snap)
	if started != 1 || len(statuses) == 0 || statuses[0] != protocol.ThreadStatusIdle || len(results) != 2 || results[0].TurnID == results[1].TurnID {
		t.Fatalf("started %d, statuses %v, results %s", started, statuses, mustMarshal(results))
	}
	// Answered to the subagent, not sent as a message.
	if n := userMessages(snap); n != 1 {
		t.Fatalf("%d user messages: %s", n, mustMarshal(snap.Items))
	}
}

func userMessages(snap protocol.Snapshot) int {
	n := 0
	for _, it := range snap.Items {
		if it.Type() == "user_message" {
			n++
		}
	}
	return n
}

// A question the harness gave up when the user interrupted its turn is kept open for a late answer,
// though the backend restarted before the turn ended.
func TestARestartKeepsAQuestionItsInterruptedTurnGaveUpOpen(t *testing.T) {
	s := miniScene(t, "POLICY=ask", "LATE_ANSWERS=1", "MINI_CLAUDE_INTERRUPT_DELAY=1500")
	a := s.start()
	id := s.create(a, "claude")
	a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "asking AskUserQuestion " + question})
	var snap protocol.Snapshot
	until(t, func() bool { snap = snapshotOf(t, a, id); return len(protocol.OpenRequests(snap)) == 1 })
	q := protocol.OpenRequests(snap)[0]
	a.call("handle", map[string]any{"type": "interrupt", "thread_id": id})
	// The harness gave it up; the turn hasn't ended yet.
	until(t, func() bool {
		snap = snapshotOf(t, a, id)
		return snap.Thread.Status == protocol.ThreadStatusRunning && len(turnResults(snap)) == 0
	})
	a.call("saved", id)
	a.call("close")
	<-a.exited

	b := s.start()
	expectRecovered(t, b, id)
	until(t, func() bool { snap = snapshotOf(t, b, id); return len(turnResults(snap)) == 1 })
	open := protocol.OpenRequests(snap)
	if snap.Thread.Status != protocol.ThreadStatusIdle || len(open) != 1 || open[0].ID() != q.ID() {
		t.Fatalf("after the restart: %s", mustMarshal(snap))
	}
	b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": q.ID(),
		"resolution": map[string]any{"outcome": "answer", "answers": map[string]any{"Colour?": []string{"Red"}}}})
	until(t, func() bool { snap = snapshotOf(t, b, id); return len(turnResults(snap)) == 2 })
	b.call("stop")
	<-b.exited
	var last *protocol.UserMessage
	for _, it := range snap.Items {
		if m, ok := it.Value.(*protocol.UserMessage); ok {
			last = m
		}
	}
	if want := "My answer to the question you asked:\n\n- Colour?\n  Red"; last == nil || last.Text != want {
		t.Fatalf("the last message is %s", mustMarshal(last))
	}
}

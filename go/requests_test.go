package agentthreads_test

// Requests against the Node backend's scriptable fake claude (mini-claude.mjs): standing answers
// kept with the thread, permission modes that answer open requests, and questions answered after
// their turn ended. As the Rust backend's driver tests do.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

const question = `{"questions":[{"question":"Colour?","options":[{"label":"Blue"},{"label":"Red"}]}]}`

// newMini is an AgentThreads that runs mini-claude as Claude, on store, asking the user about
// every call.
func newMini(t *testing.T, store agentthreads.Store, late bool) *agentthreads.AgentThreads {
	t.Helper()
	bin := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-claude.mjs")
	sdk := agentthreads.New(agentthreads.Options{
		Store: store,
		Harnesses: map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{
			Bin: bin, Env: map[string]string{"MINI_CLAUDE_LOG": filepath.Join(t.TempDir(), "log.jsonl")},
		})},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Ask},
		OnError:      func(err error) { t.Logf("backend error: %v", err) },
		LateAnswers:  late,
	})
	t.Cleanup(func() { sdk.Stop(context.Background()) })
	return sdk
}

func send(t *testing.T, sdk *agentthreads.AgentThreads, id, text string) {
	t.Helper()
	if err := sdk.Send(context.Background(), id, text, agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
}

func handle(t *testing.T, sdk *agentthreads.AgentThreads, command string) {
	t.Helper()
	if err := sdk.HandleJSON(context.Background(), []byte(command)); err != nil {
		t.Fatal(err)
	}
}

// settled waits until the thread is idle (or failed), with no message queued.
func settled(t *testing.T, sdk *agentthreads.AgentThreads, id string) protocol.Snapshot {
	t.Helper()
	var s protocol.Snapshot
	until(t, func() bool {
		s, _ = sdk.Snapshot(context.Background(), id)
		if s.Thread.Status != protocol.ThreadStatusIdle && s.Thread.Status != protocol.ThreadStatusError {
			return false
		}
		for _, it := range s.Items {
			if m, ok := it.Value.(*protocol.UserMessage); ok && m.Queued {
				return false
			}
		}
		return true
	})
	return s
}

// openRequest waits for the thread's open request of type ty (permission or question), other than
// not.
func openRequest(t *testing.T, sdk *agentthreads.AgentThreads, id, ty, not string) protocol.ThreadRequest {
	t.Helper()
	var found protocol.ThreadRequest
	until(t, func() bool {
		s, _ := sdk.Snapshot(context.Background(), id)
		for _, r := range s.Requests {
			_, q := r.Value.(*protocol.QuestionRequest)
			if (ty == "question") == q && r.ID() != not {
				found = r
				return true
			}
		}
		return false
	})
	return found
}

func lastText(s protocol.Snapshot) string {
	for i := len(s.Items) - 1; i >= 0; i-- {
		if m, ok := s.Items[i].Value.(*protocol.AssistantMessage); ok {
			return m.Text
		}
	}
	return ""
}

func userTexts(s protocol.Snapshot) []string {
	var out []string
	for _, it := range s.Items {
		if m, ok := it.Value.(*protocol.UserMessage); ok {
			out = append(out, m.Text)
		}
	}
	return out
}

// resolutions is the thread's saved request.resolved events.
func resolutions(t *testing.T, sdk *agentthreads.AgentThreads, id string) []*protocol.RequestResolvedEvent {
	t.Helper()
	events, err := sdk.EventsSince(context.Background(), id, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []*protocol.RequestResolvedEvent
	for _, e := range events {
		if r, ok := e.Value.(*protocol.RequestResolvedEvent); ok {
			out = append(out, r)
		}
	}
	return out
}

func countEvents(t *testing.T, sdk *agentthreads.AgentThreads, id, ty string) int {
	t.Helper()
	events, _ := sdk.EventsSince(context.Background(), id, 0, 0)
	n := 0
	for _, e := range events {
		if e.Type() == ty {
			n++
		}
	}
	return n
}

func TestStandingAnswersAreKeptWithTheThreadAndTheAppSeedsAndClearsThem(t *testing.T) {
	ctx := context.Background()
	state := agentthreads.NewMemoryState()
	sdk := newMini(t, agentthreads.NewMemoryStoreOn(state), false)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{
		Cwd:             t.TempDir(),
		StandingAnswers: []protocol.StandingAnswer{{Kind: protocol.ToolKindWeb, Name: "WebFetch", Outcome: protocol.StandingAnswerOutcomeDeny}},
	})
	if err != nil {
		t.Fatal(err)
	}
	send(t, sdk, th.ID, `tool WebFetch {"url":"https://example.com"}`)
	if got := lastText(settled(t, sdk, th.ID)); got != "denied: The user has denied this tool for the rest of the thread." {
		t.Fatalf("got %q", got)
	}

	send(t, sdk, th.ID, `tool Bash {"command":"ls"}`)
	r := openRequest(t, sdk, th.ID, "permission", "")
	sdk.Respond(ctx, th.ID, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow, Always: true})
	s := settled(t, sdk, th.ID)
	standing := `[{"kind":"web","name":"WebFetch","outcome":"deny"},{"kind":"shell","name":"Bash","outcome":"allow"}]`
	if got := jsonOf(s.Thread.StandingAnswers); got != standing {
		t.Fatalf("got %s", got)
	}
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// Kept with the thread: a backend that starts again has them.
	sdk = newMini(t, agentthreads.NewMemoryStoreOn(state), false)
	got, _ := sdk.Get(ctx, th.ID)
	if jsonOf(got.StandingAnswers) != standing {
		t.Fatalf("got %s", jsonOf(got))
	}
	stored, _ := agentthreads.NewMemoryStoreOn(state).GetThread(ctx, th.ID)
	if jsonOf(stored.StandingAnswers) != standing {
		t.Fatalf("stored %s", jsonOf(stored))
	}
	send(t, sdk, th.ID, `tool Bash {"command":"pwd"}`)
	if s := settled(t, sdk, th.ID); lastText(s) != `ran with {"command":"pwd"}` || len(s.Requests) != 0 {
		t.Fatalf("got %s", jsonOf(s))
	}

	// Cleared, they don't stand any more; set_options leaves them as they are without them.
	handle(t, sdk, `{"type":"set_options","thread_id":"`+th.ID+`","standing_answers":[]}`)
	model := "m"
	sdk.SetOptions(ctx, th.ID, agentthreads.ThreadOptions{Model: &model})
	if s, _ := sdk.Snapshot(ctx, th.ID); s.Thread.StandingAnswers != nil {
		t.Fatalf("got %s", jsonOf(s.Thread))
	}
	send(t, sdk, th.ID, `tool Bash {"command":"pwd"}`)
	openRequest(t, sdk, th.ID, "permission", "")

	// Seeding one answers the open requests it's for.
	handle(t, sdk, `{"type":"set_options","thread_id":"`+th.ID+`","standing_answers":[{"kind":"shell","name":"Bash","outcome":"allow"}]}`)
	if got := lastText(settled(t, sdk, th.ID)); got != `ran with {"command":"pwd"}` {
		t.Fatalf("got %q", got)
	}
}

func TestAnAnswerGivenAlwaysAnswersTheOpenRequestsForTheSameTool(t *testing.T) {
	ctx := context.Background()
	sdk := newMini(t, nil, false)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	// Two at once (as from parallel subagents).
	send(t, sdk, th.ID, `twice Bash {"command":"ls"}`)
	first := openRequest(t, sdk, th.ID, "permission", "")
	openRequest(t, sdk, th.ID, "permission", first.ID())
	sdk.Respond(ctx, th.ID, first.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Always: true, Message: "No."})
	s := settled(t, sdk, th.ID)
	var got []string
	for _, r := range resolutions(t, sdk, th.ID) {
		got = append(got, jsonOf(r.Resolution))
	}
	want := []string{
		`{"outcome":"deny","always":true,"message":"No."}`,
		`{"outcome":"deny","message":"The user has denied this tool for the rest of the thread."}`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %v", got)
	}
	if jsonOf(s.Thread.StandingAnswers) != `[{"kind":"shell","name":"Bash","outcome":"deny"}]` {
		t.Fatalf("got %s", jsonOf(s.Thread))
	}
}

func TestAModeChangeAnswersOpenPermissionRequestsAndDecidesLaterOnes(t *testing.T) {
	ctx := context.Background()
	sdk := newMini(t, nil, false)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	mode := func(m protocol.PermissionMode) {
		t.Helper()
		if err := sdk.SetOptions(ctx, th.ID, agentthreads.ThreadOptions{PermissionMode: &m}); err != nil {
			t.Fatal(err)
		}
	}

	// bypass allows an open permission request, but doesn't answer a question for the user.
	send(t, sdk, th.ID, "tool AskUserQuestion "+question)
	q := openRequest(t, sdk, th.ID, "question", "")
	mode(protocol.PermissionModeBypass)
	if s, _ := sdk.Snapshot(ctx, th.ID); len(s.Requests) != 1 {
		t.Fatalf("got %s", jsonOf(s))
	}
	sdk.Respond(ctx, th.ID, q.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Blue"}}})
	settled(t, sdk, th.ID)

	mode(protocol.PermissionModeDefault)
	send(t, sdk, th.ID, `tool Bash {"command":"ls"}`)
	openRequest(t, sdk, th.ID, "permission", "")
	mode(protocol.PermissionModeBypass)
	if got := lastText(settled(t, sdk, th.ID)); got != `ran with {"command":"ls"}` {
		t.Fatalf("got %q", got)
	}

	// dont_ask denies an open permission request, and what would be asked after it.
	mode(protocol.PermissionModeDefault)
	send(t, sdk, th.ID, `tool Bash {"command":"pwd"}`)
	openRequest(t, sdk, th.ID, "permission", "")
	mode(protocol.PermissionModeDontAsk)
	if got := lastText(settled(t, sdk, th.ID)); got != "denied: "+agentthreads.DontAskDenial {
		t.Fatalf("got %q", got)
	}
	for _, text := range []string{`tool Bash {"command":"id"}`, "tool AskUserQuestion " + question} {
		send(t, sdk, th.ID, text)
		if got := lastText(settled(t, sdk, th.ID)); got != "denied: "+agentthreads.DontAskDenial {
			t.Fatalf("%s: got %q", text, got)
		}
	}
	s, _ := sdk.Snapshot(ctx, th.ID)
	var last *protocol.ToolCall
	for _, it := range s.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok {
			last = c
		}
	}
	if last == nil || last.Status != protocol.ToolStatusDenied {
		t.Fatalf("got %s", jsonOf(s.Items))
	}
	// Requests were opened for the first three calls only.
	if n := countEvents(t, sdk, th.ID, "request.opened"); n != 3 {
		t.Fatalf("%d requests opened", n)
	}
}

func TestAQuestionLeftOpenWhenItsTurnEndsIsAnsweredWithAMessage(t *testing.T) {
	ctx := context.Background()
	state := agentthreads.NewMemoryState()
	sdk := newMini(t, agentthreads.NewMemoryStoreOn(state), true)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	q := openRequest(t, sdk, th.ID, "question", "")
	sdk.Interrupt(ctx, th.ID)
	s := settled(t, sdk, th.ID)
	if s.Thread.Status != protocol.ThreadStatusIdle || len(s.Requests) != 1 || s.Requests[0].ID() != q.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// Still open after a restart; the answer goes to the agent as the next message.
	sdk = newMini(t, agentthreads.NewMemoryStoreOn(state), true)
	if s, _ := sdk.Snapshot(ctx, th.ID); len(s.Requests) != 1 || s.Requests[0].ID() != q.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	before := len(resolutions(t, sdk, th.ID))
	handle(t, sdk, `{"type":"respond","thread_id":"`+th.ID+`","request_id":"`+q.ID()+`","resolution":{"outcome":"answer","answers":{"Colour?":["Blue"]},"message":"Thanks."}}`)
	s = settled(t, sdk, th.ID)
	texts := userTexts(s)
	if got := texts[len(texts)-1]; got != "My answer to the question you asked:\n\n- Colour?\n  Blue\n\nThanks." {
		t.Fatalf("got %q", got)
	}
	if len(s.Requests) != 0 || len(resolutions(t, sdk, th.ID)) != before+1 {
		t.Fatalf("got %s", jsonOf(s))
	}
	results := 0
	for _, it := range s.Items {
		if it.Type() == "turn_result" {
			results++
		}
	}
	if results != 2 {
		t.Fatalf("%d turns", results)
	}

	// One the conversation has moved on from (a message was sent) is cancelled instead.
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	q2 := openRequest(t, sdk, th.ID, "question", "")
	sdk.Interrupt(ctx, th.ID)
	if s := settled(t, sdk, th.ID); len(s.Requests) != 1 || s.Requests[0].ID() != q2.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	send(t, sdk, th.ID, "reply hi")
	s = settled(t, sdk, th.ID)
	rs := resolutions(t, sdk, th.ID)
	if last := rs[len(rs)-1]; len(s.Requests) != 0 || last.RequestID != q2.ID() || last.Resolution.Outcome != protocol.ResolutionOutcomeCancel {
		t.Fatalf("got %s", jsonOf(rs))
	}
	// Answering it now does nothing.
	n := len(userTexts(s))
	sdk.Respond(ctx, th.ID, q2.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Red"}}})
	if s := settled(t, sdk, th.ID); len(userTexts(s)) != n {
		t.Fatalf("got %s", jsonOf(s))
	}
}

func TestWithoutLateAnswersATurnThatEndsCancelsItsQuestions(t *testing.T) {
	ctx := context.Background()
	sdk := newMini(t, nil, false)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	openRequest(t, sdk, th.ID, "question", "")
	sdk.Interrupt(ctx, th.ID)
	if s := settled(t, sdk, th.ID); len(s.Requests) != 0 {
		t.Fatalf("got %s", jsonOf(s))
	}
}

func jsonOf(v any) string { return string(mustMarshal(v)) }

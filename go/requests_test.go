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

// newAsking is an AgentThreads that runs mini-claude as Claude, on store, asking the user about
// every call.
func newAsking(t *testing.T, store agentthreads.Store, late bool) *agentthreads.AgentThreads {
	t.Helper()
	return newAskingWith(t, store, late, nil)
}

// newAskingWith is newAsking with more of mini-claude's environment.
func newAskingWith(t *testing.T, store agentthreads.Store, late bool, env map[string]string) *agentthreads.AgentThreads {
	t.Helper()
	bin := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-claude.mjs")
	e := map[string]string{"MINI_CLAUDE_LOG": filepath.Join(t.TempDir(), "log.jsonl")}
	for k, v := range env {
		e[k] = v
	}
	sdk := agentthreads.New(agentthreads.Options{
		Store: store,
		Harnesses: map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{
			Bin: bin, Env: e,
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

// settledQueue waits until the thread is idle (or failed), with no message queued.
func settledQueue(t *testing.T, sdk *agentthreads.AgentThreads, id string) protocol.Snapshot {
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
		for _, r := range protocol.OpenRequests(s) {
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
	sdk := newAsking(t, agentthreads.NewMemoryStoreOn(state), false)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{
		Cwd:             t.TempDir(),
		StandingAnswers: []protocol.StandingAnswer{{Kind: protocol.ToolKindWeb, Name: "WebFetch", Outcome: protocol.StandingAnswerOutcomeDeny}},
	})
	if err != nil {
		t.Fatal(err)
	}
	send(t, sdk, th.ID, `tool WebFetch {"url":"https://example.com"}`)
	if got := lastText(settledQueue(t, sdk, th.ID)); got != "denied: The user has denied this tool for the rest of the thread." {
		t.Fatalf("got %q", got)
	}

	send(t, sdk, th.ID, `tool Bash {"command":"ls"}`)
	r := openRequest(t, sdk, th.ID, "permission", "")
	sdk.Respond(ctx, th.ID, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow, Always: true})
	s := settledQueue(t, sdk, th.ID)
	standing := `[{"kind":"web","name":"WebFetch","outcome":"deny"},{"kind":"shell","name":"Bash","outcome":"allow"}]`
	if got := jsonOf(s.Thread.StandingAnswers); got != standing {
		t.Fatalf("got %s", got)
	}
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// Kept with the thread: a backend that starts again has them.
	sdk = newAsking(t, agentthreads.NewMemoryStoreOn(state), false)
	got, _ := sdk.Get(ctx, th.ID)
	if jsonOf(got.StandingAnswers) != standing {
		t.Fatalf("got %s", jsonOf(got))
	}
	stored, _ := agentthreads.NewMemoryStoreOn(state).GetThread(ctx, th.ID)
	if jsonOf(stored.StandingAnswers) != standing {
		t.Fatalf("stored %s", jsonOf(stored))
	}
	send(t, sdk, th.ID, `tool Bash {"command":"pwd"}`)
	if s := settledQueue(t, sdk, th.ID); lastText(s) != `ran with {"command":"pwd"}` || len(protocol.OpenRequests(s)) != 0 {
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
	if got := lastText(settledQueue(t, sdk, th.ID)); got != `ran with {"command":"pwd"}` {
		t.Fatalf("got %q", got)
	}
}

func TestAnAnswerGivenAlwaysAnswersTheOpenRequestsForTheSameTool(t *testing.T) {
	ctx := context.Background()
	sdk := newAsking(t, nil, false)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	// Two at once (as from parallel subagents).
	send(t, sdk, th.ID, `twice Bash {"command":"ls"}`)
	first := openRequest(t, sdk, th.ID, "permission", "")
	openRequest(t, sdk, th.ID, "permission", first.ID())
	sdk.Respond(ctx, th.ID, first.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Always: true, Message: "No."})
	s := settledQueue(t, sdk, th.ID)
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
	sdk := newAsking(t, nil, false)
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
	if s, _ := sdk.Snapshot(ctx, th.ID); len(protocol.OpenRequests(s)) != 1 {
		t.Fatalf("got %s", jsonOf(s))
	}
	sdk.Respond(ctx, th.ID, q.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Blue"}}})
	settledQueue(t, sdk, th.ID)

	mode(protocol.PermissionModeDefault)
	send(t, sdk, th.ID, `tool Bash {"command":"ls"}`)
	openRequest(t, sdk, th.ID, "permission", "")
	mode(protocol.PermissionModeBypass)
	if got := lastText(settledQueue(t, sdk, th.ID)); got != `ran with {"command":"ls"}` {
		t.Fatalf("got %q", got)
	}

	// dont_ask denies an open permission request, and what would be asked after it.
	mode(protocol.PermissionModeDefault)
	send(t, sdk, th.ID, `tool Bash {"command":"pwd"}`)
	openRequest(t, sdk, th.ID, "permission", "")
	mode(protocol.PermissionModeDontAsk)
	if got := lastText(settledQueue(t, sdk, th.ID)); got != "denied: "+agentthreads.DontAskDenial {
		t.Fatalf("got %q", got)
	}
	for _, text := range []string{`tool Bash {"command":"id"}`, "tool AskUserQuestion " + question} {
		send(t, sdk, th.ID, text)
		if got := lastText(settledQueue(t, sdk, th.ID)); got != "denied: "+agentthreads.DontAskDenial {
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
	sdk := newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	q := openRequest(t, sdk, th.ID, "question", "")
	sdk.Interrupt(ctx, th.ID)
	s := settledQueue(t, sdk, th.ID)
	if s.Thread.Status != protocol.ThreadStatusIdle || len(protocol.OpenRequests(s)) != 1 || protocol.OpenRequests(s)[0].ID() != q.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}

	// Still open after a restart; the answer goes to the agent as the next message.
	sdk = newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
	if s, _ := sdk.Snapshot(ctx, th.ID); len(protocol.OpenRequests(s)) != 1 || protocol.OpenRequests(s)[0].ID() != q.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	before := len(resolutions(t, sdk, th.ID))
	handle(t, sdk, `{"type":"respond","thread_id":"`+th.ID+`","request_id":"`+q.ID()+`","resolution":{"outcome":"answer","answers":{"Colour?":["Blue"]},"message":"Thanks."}}`)
	s = settledQueue(t, sdk, th.ID)
	texts := userTexts(s)
	if got := texts[len(texts)-1]; got != "My answer to the question you asked:\n\n- Colour?\n  Blue\n\nThanks." {
		t.Fatalf("got %q", got)
	}
	if len(protocol.OpenRequests(s)) != 0 || len(resolutions(t, sdk, th.ID)) != before+1 {
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
	if s := settledQueue(t, sdk, th.ID); len(protocol.OpenRequests(s)) != 1 || protocol.OpenRequests(s)[0].ID() != q2.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	send(t, sdk, th.ID, "reply hi")
	s = settledQueue(t, sdk, th.ID)
	rs := resolutions(t, sdk, th.ID)
	if last := rs[len(rs)-1]; len(protocol.OpenRequests(s)) != 0 || last.RequestID != q2.ID() || last.Resolution.Outcome != protocol.ResolutionOutcomeCancel {
		t.Fatalf("got %s", jsonOf(rs))
	}
	// Answering it now does nothing.
	n := len(userTexts(s))
	sdk.Respond(ctx, th.ID, q2.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Red"}}})
	if s := settledQueue(t, sdk, th.ID); len(userTexts(s)) != n {
		t.Fatalf("got %s", jsonOf(s))
	}
}

// interruptedQuestion asks a question and interrupts its turn: the harness cancels the question,
// which is kept open. It doesn't wait for the turn to end.
func interruptedQuestion(t *testing.T, sdk *agentthreads.AgentThreads, id string) protocol.ThreadRequest {
	t.Helper()
	send(t, sdk, id, "asking AskUserQuestion "+question)
	q := openRequest(t, sdk, id, "question", "")
	sdk.Interrupt(context.Background(), id)
	// No longer waiting on it, though it's open.
	until(t, func() bool {
		s, _ := sdk.Snapshot(context.Background(), id)
		return s.Thread.Status != protocol.ThreadStatusWaiting
	})
	return q
}

// resolutionOf is the resolution the thread's request got, if it has one.
func resolutionOf(t *testing.T, sdk *agentthreads.AgentThreads, id string, q protocol.ThreadRequest) *protocol.Resolution {
	t.Helper()
	s, _ := sdk.Snapshot(context.Background(), id)
	for _, r := range s.Requests {
		if r.ID() == q.ID() {
			return r.Resolution()
		}
	}
	return nil
}

func TestAQuestionIsntKeptOpenOnceTheUserSendsAMessageDuringItsTurn(t *testing.T) {
	ctx := context.Background()
	sdk := newAskingWith(t, nil, true, map[string]string{"MINI_CLAUDE_INTERRUPT_DELAY": "300"})
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	cancelled := protocol.Resolution{Outcome: protocol.ResolutionOutcomeCancel}

	// The message comes after the harness gave the question up, before the turn ends.
	q := interruptedQuestion(t, sdk, th.ID)
	if r := resolutionOf(t, sdk, th.ID, q); r != nil {
		t.Fatalf("got %s", jsonOf(r))
	}
	send(t, sdk, th.ID, "reply hi")
	s := settledQueue(t, sdk, th.ID)
	if r := resolutionOf(t, sdk, th.ID, q); len(protocol.OpenRequests(s)) != 0 || r == nil || jsonOf(r) != jsonOf(cancelled) {
		t.Fatalf("got %s", jsonOf(s))
	}
	n := len(userTexts(s))
	sdk.Respond(ctx, th.ID, q.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Red"}}})
	if s := settledQueue(t, sdk, th.ID); len(userTexts(s)) != n {
		t.Fatalf("got %s", jsonOf(s))
	}

	// And before it.
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	q = openRequest(t, sdk, th.ID, "question", "")
	send(t, sdk, th.ID, "reply later")
	sdk.Interrupt(ctx, th.ID)
	s = settledQueue(t, sdk, th.ID)
	if r := resolutionOf(t, sdk, th.ID, q); len(protocol.OpenRequests(s)) != 0 || r == nil || jsonOf(r) != jsonOf(cancelled) {
		t.Fatalf("got %s", jsonOf(s))
	}
}

func TestDontAskDismissesQuestionsKeptOpenAfterTheirTurnsBeforeAndAfterARestart(t *testing.T) {
	ctx := context.Background()
	state := agentthreads.NewMemoryState()
	sdk := newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	sdk.Close(ctx)
	mode := func(sdk *agentthreads.AgentThreads, m protocol.PermissionMode) {
		t.Helper()
		if err := sdk.SetOptions(ctx, th.ID, agentthreads.ThreadOptions{PermissionMode: &m}); err != nil {
			t.Fatal(err)
		}
	}
	for _, restart := range []bool{false, true} {
		sdk := newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
		mode(sdk, protocol.PermissionModeDefault)
		q := interruptedQuestion(t, sdk, th.ID)
		if s := settledQueue(t, sdk, th.ID); len(protocol.OpenRequests(s)) != 1 || protocol.OpenRequests(s)[0].ID() != q.ID() {
			t.Fatalf("got %s", jsonOf(s))
		}
		if restart {
			if err := sdk.Close(ctx); err != nil {
				t.Fatal(err)
			}
			sdk = newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
		}
		results := len(func() []string {
			s, _ := sdk.Snapshot(ctx, th.ID)
			var out []string
			for _, it := range s.Items {
				if it.Type() == "turn_result" {
					out = append(out, it.ID())
				}
			}
			return out
		}())
		mode(sdk, protocol.PermissionModeDontAsk)
		s := settledQueue(t, sdk, th.ID)
		want := protocol.Resolution{Outcome: protocol.ResolutionOutcomeCancel, Message: agentthreads.DontAskDenial}
		if r := resolutionOf(t, sdk, th.ID, q); len(protocol.OpenRequests(s)) != 0 || r == nil || jsonOf(r) != jsonOf(want) {
			t.Fatalf("restart %v: got %s", restart, jsonOf(s))
		}
		// Dismissed, it sent nothing.
		after := 0
		for _, it := range s.Items {
			if it.Type() == "turn_result" {
				after++
			}
		}
		if after != results {
			t.Fatalf("restart %v: %d turns, then %d", restart, results, after)
		}
		if err := sdk.Close(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestATypedSetOptionsCommandCanClearStandingAnswers(t *testing.T) {
	ctx := context.Background()
	empty := []protocol.StandingAnswer{}
	if got := jsonOf(protocol.SetOptionsCommand{ThreadID: "t", StandingAnswers: &empty}); !strings.Contains(got, `"standing_answers":[]`) {
		t.Fatalf("got %s", got)
	}
	if got := jsonOf(protocol.SetOptionsCommand{ThreadID: "t"}); strings.Contains(got, "standing_answers") {
		t.Fatalf("got %s", got)
	}
	sdk := newAsking(t, nil, false)
	seeded := []protocol.StandingAnswer{{Kind: protocol.ToolKindShell, Name: "Bash", Outcome: protocol.StandingAnswerOutcomeAllow}}
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir(), StandingAnswers: seeded})
	roundTrip := func(c protocol.SetOptionsCommand) []protocol.StandingAnswer {
		t.Helper()
		c.ThreadID = th.ID
		handle(t, sdk, jsonOf(protocol.Command{Value: &c}))
		s, _ := sdk.Snapshot(ctx, th.ID)
		return s.Thread.StandingAnswers
	}
	// Left out, they stay; given empty, they're cleared.
	if got := roundTrip(protocol.SetOptionsCommand{Model: "m"}); jsonOf(got) != jsonOf(seeded) {
		t.Fatalf("got %s", jsonOf(got))
	}
	if got := roundTrip(protocol.SetOptionsCommand{StandingAnswers: &empty}); len(got) != 0 {
		t.Fatalf("got %s", jsonOf(got))
	}
}

func TestWithoutLateAnswersATurnThatEndsCancelsItsQuestions(t *testing.T) {
	ctx := context.Background()
	sdk := newAsking(t, nil, false)
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	openRequest(t, sdk, th.ID, "question", "")
	sdk.Interrupt(ctx, th.ID)
	if s := settledQueue(t, sdk, th.ID); len(protocol.OpenRequests(s)) != 0 {
		t.Fatalf("got %s", jsonOf(s))
	}
}

func jsonOf(v any) string { return string(mustMarshal(v)) }

// The conversation moved on from a question (the user sent a message, which the harness took in)
// before the backend stopped with its run: the question isn't kept open when the lost turn ends,
// whether or not it has a tool_call item.
func TestAQuestionIsntKeptOpenAfterALostRunOnceTheUserSentAMessage(t *testing.T) {
	for _, unlinked := range []bool{false, true} {
		t.Run(map[bool]string{false: "linked", true: "unlinked"}[unlinked], func(t *testing.T) {
			lostRunAfterAMessage(t, unlinked)
		})
	}
}

func lostRunAfterAMessage(t *testing.T, unlinked bool) {
	ctx := context.Background()
	state := agentthreads.NewMemoryState()
	var env map[string]string
	if unlinked {
		env = map[string]string{"MINI_CLAUDE_UNLINKED": "1"}
	}
	sdk := newAskingWith(t, agentthreads.NewMemoryStoreOn(state), true, env)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	q := openRequest(t, sdk, th.ID, "question", "")
	if (q.ToolCallID() == "") != unlinked {
		t.Fatalf("got %s", jsonOf(q))
	}
	send(t, sdk, th.ID, "reply hi")
	// Taken in: nothing's queued.
	until(t, func() bool {
		s, _ := sdk.Snapshot(ctx, th.ID)
		n := 0
		for _, it := range s.Items {
			if m, ok := it.Value.(*protocol.UserMessage); ok {
				if m.Queued {
					return false
				}
				n++
			}
		}
		return n == 2
	})
	if _, err := sdk.EventsSince(ctx, th.ID, 0, 0); err != nil { // saved
		t.Fatal(err)
	}
	// As if the backend died with the run: a copy of what was saved.
	from := agentthreads.NewMemoryStoreOn(state)
	crashed := agentthreads.NewMemoryStore()
	saved, _ := from.GetThread(ctx, th.ID)
	events, _ := from.ReadEvents(ctx, th.ID, 0, 0)
	if err := crashed.CreateThread(ctx, *saved); err != nil {
		t.Fatal(err)
	}
	if err := crashed.AppendEvents(ctx, th.ID, events, nil); err != nil {
		t.Fatal(err)
	}
	sdk.Stop(ctx)

	again := newAskingWith(t, crashed, true, env)
	s, err := again.Snapshot(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if open := protocol.OpenRequests(s); len(open) != 0 {
		t.Fatalf("still open: %s", mustMarshal(open))
	}
	if r := resolutionOf(t, again, th.ID, q); r == nil || r.Outcome != protocol.ResolutionOutcomeCancel {
		t.Fatalf("resolved with %s", mustMarshal(r))
	}
}

// A message the harness took in between a tool call and the question it asks for it came before
// the question: the conversation hasn't moved on from it.
func TestKeepsAQuestionOpenAfterAMessageTakenInBeforeItWasAsked(t *testing.T) {
	ctx := context.Background()
	sdk := newAskingWith(t, nil, true, map[string]string{"MINI_CLAUDE_ASK_DELAY": "500"})
	th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
	send(t, sdk, th.ID, "asking AskUserQuestion "+question)
	until(t, func() bool {
		s, _ := sdk.Snapshot(ctx, th.ID)
		for _, it := range s.Items {
			if it.Type() == "tool_call" {
				return true
			}
		}
		return false
	})
	send(t, sdk, th.ID, "reply hi")
	q := openRequest(t, sdk, th.ID, "question", "")
	s, _ := sdk.Snapshot(ctx, th.ID)
	n := 0
	for _, it := range s.Items {
		if m, ok := it.Value.(*protocol.UserMessage); ok {
			if m.Queued {
				t.Fatalf("queued: %s", jsonOf(s))
			}
			n++
		}
	}
	if users := q.Value.(*protocol.QuestionRequest).UserMessages; n != 2 || users == nil || *users != 2 {
		t.Fatalf("got %s", jsonOf(s))
	}
	sdk.Interrupt(ctx, th.ID)
	s = settledQueue(t, sdk, th.ID)
	if open := protocol.OpenRequests(s); len(open) != 1 || open[0].ID() != q.ID() {
		t.Fatalf("got %s", jsonOf(s))
	}
	sdk.Respond(ctx, th.ID, q.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAnswer, Answers: map[string][]string{"Colour?": {"Red"}}})
	until(t, func() bool {
		s, _ := sdk.Snapshot(ctx, th.ID)
		texts := userTexts(s)
		return texts[len(texts)-1] == "My answer to the question you asked:\n\n- Colour?\n  Red"
	})
	settledQueue(t, sdk, th.ID)
}

// A question kept open after its turn belongs to the conversation that asked it: a rewind or a new
// session cancels it, and answering it then starts nothing, before a restart or after.
func TestASessionChangeCancelsAQuestionKeptOpenAfterItsTurn(t *testing.T) {
	for _, change := range []string{"rewind", "new_session"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			state := agentthreads.NewMemoryState()
			sdk := newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
			th, _ := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir()})
			send(t, sdk, th.ID, "reply one")
			settledQueue(t, sdk, th.ID)
			send(t, sdk, th.ID, "asking AskUserQuestion "+question)
			q := openRequest(t, sdk, th.ID, "question", "")
			sdk.Interrupt(ctx, th.ID)
			s := settledQueue(t, sdk, th.ID)
			if len(protocol.OpenRequests(s)) != 1 {
				t.Fatalf("got %s", jsonOf(s))
			}
			var err error
			if change == "rewind" {
				err = sdk.Rewind(ctx, th.ID, turnResults(s.Items)[1].TurnID)
			} else {
				err = sdk.NewSession(ctx, th.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			s, _ = sdk.Snapshot(ctx, th.ID)
			if len(protocol.OpenRequests(s)) != 0 {
				t.Fatalf("still open: %s", jsonOf(s))
			}
			rs := resolutions(t, sdk, th.ID)
			if last := rs[len(rs)-1]; last.RequestID != q.ID() || last.Resolution.Outcome != protocol.ResolutionOutcomeCancel {
				t.Fatalf("got %s", jsonOf(last))
			}
			answer := `{"type":"respond","thread_id":"` + th.ID + `","request_id":"` + q.ID() + `","resolution":{"outcome":"answer","answers":{"Colour?":["Blue"]}}}`
			messages := len(userTexts(s))
			sdk.HandleJSON(ctx, []byte(answer))
			if s := settledQueue(t, sdk, th.ID); len(userTexts(s)) != messages {
				t.Fatalf("an answer started a turn: %s", jsonOf(s))
			}
			if err := sdk.Close(ctx); err != nil {
				t.Fatal(err)
			}
			sdk = newAsking(t, agentthreads.NewMemoryStoreOn(state), true)
			if s, _ := sdk.Snapshot(ctx, th.ID); len(protocol.OpenRequests(s)) != 0 {
				t.Fatalf("open after a restart: %s", jsonOf(s))
			}
			sdk.HandleJSON(ctx, []byte(answer))
			if s := settledQueue(t, sdk, th.ID); len(userTexts(s)) != messages {
				t.Fatalf("an answer after a restart started a turn: %s", jsonOf(s))
			}
		})
	}
}

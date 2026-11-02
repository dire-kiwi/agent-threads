//go:build unix

package agentthreads_test

// Option changes and plan mode, against the scriptable fake `claude` and `codex` the Node backend's
// tests use (mini-claude.mjs, mini-codex.mjs), for what the recorded fixtures don't cover: a new
// model and permission mode in the running process, bypass mode, an effort that needs a new
// process, and plans sent back, approved, interrupted or talked over.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

var miniDir = filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test")

// mini is an AgentThreads with Claude Code played by mini-claude.mjs and Codex by mini-codex.mjs,
// each logging what its runs were started with and sent.
type mini struct {
	t      *testing.T
	sdk    *agentthreads.AgentThreads
	events recorder
	log    string
	cwd    string
}

// miniRun is a run's argv and the messages it was sent.
type miniRun struct {
	argv []string
	sent []map[string]any
}

func newMini(t *testing.T, policy agentthreads.PermissionPolicy, env map[string]string) *mini {
	t.Helper()
	needNode(t)
	m := &mini{t: t, log: filepath.Join(t.TempDir(), "log.jsonl"), cwd: t.TempDir()}
	all := map[string]string{"MINI_CLAUDE_LOG": m.log, "MINI_CODEX_LOG": m.log, "HOME": t.TempDir()}
	for k, v := range env {
		all[k] = v
	}
	m.sdk = agentthreads.New(agentthreads.Options{
		Harnesses: map[string]agentthreads.Harness{
			"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: filepath.Join(miniDir, "mini-claude.mjs"), Env: all}),
			"codex":  agentthreads.Codex(agentthreads.CodexOptions{Bin: filepath.Join(miniDir, "mini-codex.mjs"), Env: all, Home: t.TempDir(), NoLogin: true, CloseGrace: time.Second}),
		},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	m.sdk.Subscribe(m.events.add)
	t.Cleanup(func() { m.sdk.Stop(context.Background()) })
	return m
}

func (m *mini) create(o agentthreads.CreateOptions) string {
	m.t.Helper()
	if o.Cwd == "" {
		o.Cwd = m.cwd
	}
	th, err := m.sdk.Create(context.Background(), o)
	if err != nil {
		m.t.Fatal(err)
	}
	return th.ID
}

func (m *mini) send(id, text string, o ...agentthreads.SendOptions) {
	m.t.Helper()
	var so agentthreads.SendOptions
	if len(o) > 0 {
		so = o[0]
	}
	if err := m.sdk.Send(context.Background(), id, text, so); err != nil {
		m.t.Fatal(err)
	}
}

func (m *mini) respond(id, requestID string, res protocol.Resolution) {
	m.t.Helper()
	if err := m.sdk.Respond(context.Background(), id, requestID, res); err != nil {
		m.t.Fatal(err)
	}
}

func (m *mini) setOptions(id string, o agentthreads.ThreadOptions) {
	m.t.Helper()
	if err := m.sdk.SetOptions(context.Background(), id, o); err != nil {
		m.t.Fatal(err)
	}
}

func (m *mini) snapshot(id string) protocol.Snapshot {
	m.t.Helper()
	s, err := m.sdk.Snapshot(context.Background(), id)
	if err != nil {
		m.t.Fatal(err)
	}
	return s
}

// settle waits until the thread is idle (or failed), and is its snapshot.
func (m *mini) settle(id string) protocol.Snapshot {
	m.t.Helper()
	var s protocol.Snapshot
	until(m.t, func() bool {
		s = m.snapshot(id)
		return s.Thread.Status == protocol.ThreadStatusIdle || s.Thread.Status == protocol.ThreadStatusError
	})
	return s
}

// request waits for an open request other than those not, and is it.
func (m *mini) request(id string, not ...string) protocol.ThreadRequest {
	m.t.Helper()
	var r protocol.ThreadRequest
	until(m.t, func() bool {
		for _, x := range m.snapshot(id).Requests {
			if !slices.Contains(not, x.ID()) {
				r = x
				return true
			}
		}
		return false
	})
	return r
}

// runs is what each run was started with and sent.
func (m *mini) runs() []miniRun {
	data, _ := os.ReadFile(m.log)
	var out []miniRun
	for _, line := range strings.Split(string(data), "\n") {
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		if argv, ok := v["argv"].([]any); ok {
			r := miniRun{argv: []string{}}
			for _, a := range argv {
				r.argv = append(r.argv, a.(string))
			}
			out = append(out, r)
		} else if len(out) > 0 {
			out[len(out)-1].sent = append(out[len(out)-1].sent, v)
		}
	}
	return out
}

// controls is the control requests a Claude run was sent.
func (r miniRun) controls() []any {
	var out []any
	for _, m := range r.sent {
		if m["type"] == "control_request" {
			out = append(out, m["request"])
		}
	}
	return out
}

// answers is the responses a Claude run was sent to its control requests.
func (r miniRun) answers() []any {
	var out []any
	for _, m := range r.sent {
		if m["type"] == "control_response" {
			out = append(out, m["response"].(map[string]any)["response"])
		}
	}
	return out
}

// params is the params of each request a Codex run was sent with the method.
func (r miniRun) params(method string) []map[string]any {
	var out []map[string]any
	for _, m := range r.sent {
		if m["method"] == method {
			p, _ := m["params"].(map[string]any)
			out = append(out, p)
		}
	}
	return out
}

func texts(items []protocol.Item) []string {
	out := []string{}
	for _, it := range items {
		if a, ok := it.Value.(*protocol.AssistantMessage); ok {
			out = append(out, a.Text)
		}
	}
	return out
}

func results(items []protocol.Item) []*protocol.TurnResult {
	var out []*protocol.TurnResult
	for _, it := range items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			out = append(out, r)
		}
	}
	return out
}

// has says whether v has everything pattern (JSON) has: objects field by field, arrays element by
// element, everything else exactly.
func has(v any, pattern string) bool {
	var x, p any
	json.Unmarshal(mustMarshal(v), &x)
	json.Unmarshal([]byte(pattern), &p)
	return like(x, p)
}

func like(v, pattern any) bool {
	switch p := pattern.(type) {
	case map[string]any:
		o, ok := v.(map[string]any)
		if !ok {
			return false
		}
		for k, x := range p {
			if !like(o[k], x) {
				return false
			}
		}
		return true
	case []any:
		a, ok := v.([]any)
		if !ok || len(a) != len(p) {
			return false
		}
		for i := range p {
			if !like(a[i], p[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(v, pattern)
}

// contains says whether list has a value equal (as JSON) to want.
func contains(list []any, want string) bool {
	var w any
	json.Unmarshal([]byte(want), &w)
	for _, v := range list {
		if reflect.DeepEqual(v, w) {
			return true
		}
	}
	return false
}

func ptr[T any](v T) *T { return &v }

// ---------- Claude Code ----------

func TestClaudeGivesARunningProcessANewModelAndPermissionMode(t *testing.T) {
	m := newMini(t, agentthreads.Allow, nil)
	id := m.create(agentthreads.CreateOptions{Harness: "claude", Model: "a"})
	m.send(id, "reply one")
	m.settle(id)
	m.setOptions(id, agentthreads.ThreadOptions{Model: ptr("b"), PermissionMode: ptr(protocol.PermissionModeAcceptEdits)})
	m.send(id, "reply two")
	s := m.settle(id)
	if got := texts(s.Items); !reflect.DeepEqual(got, []string{"one", "two"}) {
		t.Fatalf("texts %v", got)
	}
	runs := m.runs()
	if len(runs) != 1 {
		t.Fatalf("%d runs", len(runs))
	}
	controls := runs[0].controls()
	if !contains(controls, `{"subtype":"set_model","model":"b"}`) || !contains(controls, `{"subtype":"set_permission_mode","mode":"acceptEdits"}`) {
		t.Fatalf("controls %s", mustMarshal(controls))
	}
}

func TestClaudeStartsANewProcessForANewEffort(t *testing.T) {
	// A carried-over turn, with the effort changed during the turn before: a new effort needs a new
	// process (a model or permission mode doesn't).
	m := newMini(t, agentthreads.Allow, map[string]string{"MINI_CLAUDE_STEER": "late"})
	id := m.create(agentthreads.CreateOptions{Harness: "claude", Effort: "low"})
	m.send(id, "slow")
	until(t, func() bool { return m.snapshot(id).Thread.SessionID != "" })
	m.send(id, "reply steered")
	m.setOptions(id, agentthreads.ThreadOptions{Effort: ptr("high")})
	if err := m.sdk.Interrupt(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	var s protocol.Snapshot
	until(t, func() bool {
		s = m.snapshot(id)
		return len(results(s.Items)) == 2 && s.Thread.Status == protocol.ThreadStatusIdle
	})
	if got := texts(s.Items); !reflect.DeepEqual(got, []string{"steered"}) {
		t.Fatalf("texts %v", got)
	}
	runs := m.runs()
	if len(runs) != 2 {
		t.Fatalf("%d runs", len(runs))
	}
	first, second := strings.Join(runs[0].argv, " "), strings.Join(runs[1].argv, " ")
	if !strings.Contains(first, "--effort low") || !strings.Contains(second, "--effort high") || !strings.Contains(second, "--resume "+s.Thread.SessionID) {
		t.Fatalf("argvs %q, %q", first, second)
	}
}

func TestClaudeAsksAboutAPlan(t *testing.T) {
	// Approving it leaves plan mode for the mode the user picks.
	m := newMini(t, agentthreads.Ask, nil)
	id := m.create(agentthreads.CreateOptions{Harness: "claude", PermissionMode: protocol.PermissionModePlan})
	m.send(id, `tool ExitPlanMode {"plan":"#Plan\n-one"}`)
	r := m.request(id)
	if !has(r, `{"type":"plan","plan":"#Plan\n-one"}`) {
		t.Fatalf("request %s", mustMarshal(r))
	}
	m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow, PermissionMode: protocol.PermissionModeAcceptEdits})
	s := m.settle(id)
	if s.Thread.PermissionMode != protocol.PermissionModeAcceptEdits {
		t.Fatalf("mode %s", s.Thread.PermissionMode)
	}
	answers := m.runs()[0].answers()
	if len(answers) == 0 || !has(answers[0], `{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}`) {
		t.Fatalf("answers %s", mustMarshal(answers))
	}
	// The process has the mode: the next turn runs in it, and isn't told it again.
	m.send(id, "reply next")
	m.settle(id)
	runs := m.runs()
	if len(runs) != 1 {
		t.Fatalf("%d runs", len(runs))
	}
	for _, c := range runs[0].controls() {
		if has(c, `{"subtype":"set_permission_mode"}`) {
			t.Fatalf("told the mode again: %s", mustMarshal(c))
		}
	}
}

func TestClaudeSendsAPlanBackWithTheUsersFeedback(t *testing.T) {
	m := newMini(t, agentthreads.Allow, nil)
	id := m.create(agentthreads.CreateOptions{Harness: "claude", PermissionMode: protocol.PermissionModePlan})
	m.send(id, `tool ExitPlanMode {"plan":"p"}`)
	r := m.request(id)
	m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Message: "Not yet."})
	s := m.settle(id)
	if s.Thread.PermissionMode != protocol.PermissionModePlan {
		t.Fatalf("mode %s", s.Thread.PermissionMode)
	}
	var call *protocol.ToolCall
	for _, it := range s.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok {
			call = c
		}
	}
	if call == nil || !has(call, `{"name":"ExitPlanMode","status":"denied","result":{"content":"Not yet."}}`) {
		t.Fatalf("call %s", mustMarshal(call))
	}
	answers := m.runs()[0].answers()
	if len(answers) == 0 || !reflect.DeepEqual(answers[0], map[string]any{"behavior": "deny", "message": "Not yet."}) {
		t.Fatalf("answers %s", mustMarshal(answers))
	}
}

func TestClaudeAllowsWhatAProcessThatCantBeSwitchedToBypassAsks(t *testing.T) {
	// Until a new one starts in bypass mode.
	m := newMini(t, agentthreads.Ask, map[string]string{"MINI_CLAUDE_ASK_DELAY": "300"})
	id := m.create(agentthreads.CreateOptions{Harness: "claude"})
	m.send(id, `tool Bash {"command":"ls"}`)
	m.setOptions(id, agentthreads.ThreadOptions{PermissionMode: ptr(protocol.PermissionModeBypass)})
	s := m.settle(id)
	for _, e := range m.events.all() {
		if e.Type() == "request.opened" {
			t.Fatalf("asked: %s", mustMarshal(e))
		}
	}
	var calls []string
	for _, it := range s.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok {
			calls = append(calls, c.Name+" "+string(c.Status))
		}
	}
	if !reflect.DeepEqual(calls, []string{"Bash completed"}) {
		t.Fatalf("calls %v", calls)
	}
	// It was put in acceptEdits mode, the nearest it could be.
	if controls := m.runs()[0].controls(); !contains(controls, `{"subtype":"set_permission_mode","mode":"acceptEdits"}`) {
		t.Fatalf("controls %s", mustMarshal(controls))
	}
	// The next turn has a process started in bypass mode.
	m.send(id, "reply next")
	m.settle(id)
	runs := m.runs()
	if len(runs) != 2 || !strings.Contains(strings.Join(runs[1].argv, " "), "--permission-mode bypassPermissions") {
		t.Fatalf("runs %+v", runs)
	}
}

// ---------- Codex ----------

func TestCodexGivesTheProcessNewOptionsWithItsNextTurn(t *testing.T) {
	m := newMini(t, agentthreads.Allow, nil)
	id := m.create(agentthreads.CreateOptions{Harness: "codex", Model: "a", Effort: "low"})
	m.send(id, "reply one")
	m.settle(id)
	m.setOptions(id, agentthreads.ThreadOptions{Model: ptr("b"), Effort: ptr("high"), PermissionMode: ptr(protocol.PermissionModeBypass)})
	m.send(id, "reply two")
	m.settle(id)
	m.send(id, "reply three")
	m.settle(id)
	runs := m.runs()
	if len(runs) != 1 {
		t.Fatalf("%d runs", len(runs))
	}
	turns := runs[0].params("turn/start")
	if len(turns) != 3 {
		t.Fatalf("turns %s", mustMarshal(turns))
	}
	// Codex keeps them: they're sent once.
	for _, i := range []int{0, 2} {
		if _, ok := turns[i]["model"]; ok {
			t.Fatalf("turn %d: %s", i, mustMarshal(turns[i]))
		}
		if _, ok := turns[i]["approvalPolicy"]; ok {
			t.Fatalf("turn %d: %s", i, mustMarshal(turns[i]))
		}
	}
	if !has(turns[1], `{"model":"b","effort":"high","approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"}}`) {
		t.Fatalf("turn 1: %s", mustMarshal(turns[1]))
	}
	for i, p := range turns {
		if _, ok := p["collaborationMode"]; ok {
			t.Fatalf("turn %d: %s", i, mustMarshal(p))
		}
	}
}

func TestCodexStartsANewProcessWhenTheModelOrEffortIsCleared(t *testing.T) {
	// With Codex's own: turn/start can't clear one.
	for _, option := range []string{"model", "effort"} {
		t.Run(option, func(t *testing.T) {
			t.Parallel()
			m := newMini(t, agentthreads.Allow, nil)
			id := m.create(agentthreads.CreateOptions{Harness: "codex", Model: "a", Effort: "high"})
			m.send(id, "reply one")
			m.settle(id)
			cleared := agentthreads.ThreadOptions{Model: ptr("")}
			if option == "effort" {
				cleared = agentthreads.ThreadOptions{Effort: ptr("")}
			}
			m.setOptions(id, cleared)
			m.send(id, "reply two")
			m.settle(id)
			runs := m.runs()
			if len(runs) != 2 {
				t.Fatalf("%d runs", len(runs))
			}
			if option == "model" {
				if _, ok := runs[1].params("thread/resume")[0]["model"]; ok {
					t.Fatalf("thread/resume %s", mustMarshal(runs[1].params("thread/resume")))
				}
			}
			if turn := runs[1].params("turn/start")[0]; turn[option] != nil {
				t.Fatalf("turn/start %s", mustMarshal(turn))
			}
		})
	}
}

func TestCodexStartsANewProcessWhenTheConfigChanges(t *testing.T) {
	// Resuming the session.
	m := newMini(t, agentthreads.Allow, nil)
	id := m.create(agentthreads.CreateOptions{Harness: "codex", Model: "a"})
	m.send(id, "reply one")
	m.settle(id)
	m.setOptions(id, agentthreads.ThreadOptions{Model: ptr("b"), PermissionMode: ptr(protocol.PermissionModeBypass)})
	if err := m.sdk.Configure(context.Background(), id, agentthreads.Capabilities{SystemPrompt: "Be brief."}); err != nil {
		t.Fatal(err)
	}
	m.send(id, "reply two")
	m.settle(id)
	runs := m.runs()
	if len(runs) != 2 {
		t.Fatalf("%d runs", len(runs))
	}
	resumed := runs[1].params("thread/resume")
	if len(resumed) != 1 || !has(resumed[0], `{"model":"b","approvalPolicy":"never","sandbox":"danger-full-access"}`) {
		t.Fatalf("thread/resume %s", mustMarshal(resumed))
	}
	// The new process has them: its turn doesn't override them.
	turn := runs[1].params("turn/start")[0]
	if _, ok := turn["model"]; ok {
		t.Fatalf("turn/start %s", mustMarshal(turn))
	}
	if _, ok := turn["approvalPolicy"]; ok {
		t.Fatalf("turn/start %s", mustMarshal(turn))
	}
}

func TestCodexInPlanMode(t *testing.T) {
	plan := ptr(protocol.PermissionModePlan)
	cancelled := func(m *mini, requestID string) bool {
		for _, e := range m.events.all() {
			if r, ok := e.Value.(*protocol.RequestResolvedEvent); ok && r.RequestID == requestID && r.Resolution.Outcome == protocol.ResolutionOutcomeCancel {
				return true
			}
		}
		return false
	}

	t.Run("asks about a proposed plan, and implements it in the same turn once it's approved", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Ask, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", Model: "m", PermissionMode: *plan})
		m.send(id, "propose Change apple to apricot.")
		r := m.request(id)
		if !has(r, `{"type":"plan","plan":"Change apple to apricot."}`) {
			t.Fatalf("request %s", mustMarshal(r))
		}
		if s := m.snapshot(id); s.Thread.Status != protocol.ThreadStatusWaiting || len(results(s.Items)) != 0 {
			t.Fatalf("got %s", mustMarshal(s))
		}
		m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow})
		s := m.settle(id)
		if s.Thread.PermissionMode != protocol.PermissionModeDefault {
			t.Fatalf("mode %s", s.Thread.PermissionMode)
		}
		runs := m.runs()
		if len(runs) != 1 {
			t.Fatalf("%d runs", len(runs))
		}
		turns := runs[0].params("turn/start")
		if !has(turns[0], `{"collaborationMode":{"mode":"plan","settings":{"model":"m"}}}`) {
			t.Fatalf("turn 0: %s", mustMarshal(turns[0]))
		}
		if !has(turns[1], `{"input":[{"type":"text","text":"Implement the plan."}],"collaborationMode":{"mode":"default"},"approvalPolicy":"untrusted","sandboxPolicy":{"type":"workspaceWrite"}}`) {
			t.Fatalf("turn 1: %s", mustMarshal(turns[1]))
		}
		// One turn, of both Codex turns.
		rs := results(s.Items)
		if len(rs) != 1 || !has(rs[0], `{"ok":true,"duration_ms":14,"usage":{"input_tokens":120,"cache_read_tokens":80,"output_tokens":20}}`) {
			t.Fatalf("results %s", mustMarshal(rs))
		}
		if got := texts(s.Items); !reflect.DeepEqual(got, []string{"Change apple to apricot."}) {
			t.Fatalf("texts %v", got)
		}
		// Codex stays in its default mode, which isn't sent again.
		m.send(id, "reply done")
		m.settle(id)
		if turn := m.runs()[0].params("turn/start")[2]; turn["collaborationMode"] != nil {
			t.Fatalf("turn 2: %s", mustMarshal(turn))
		}
	})

	t.Run("sends the user's feedback, and plans again; denied without any, the turn ends", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", PermissionMode: *plan})
		m.send(id, "propose One.")
		r := m.request(id)
		m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Message: "propose Two."})
		r = m.request(id, r.ID())
		if !has(r, `{"type":"plan","plan":"Two."}`) {
			t.Fatalf("request %s", mustMarshal(r))
		}
		m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny})
		s := m.settle(id)
		if s.Thread.PermissionMode != protocol.PermissionModePlan {
			t.Fatalf("mode %s", s.Thread.PermissionMode)
		}
		if rs := results(s.Items); len(rs) != 1 || !rs[0].OK {
			t.Fatalf("results %s", mustMarshal(rs))
		}
		turns := m.runs()[0].params("turn/start")
		if len(turns) != 2 || !has(turns[1], `{"input":[{"type":"text","text":"propose Two."}],"collaborationMode":{"mode":"plan"}}`) || turns[1]["approvalPolicy"] != nil {
			t.Fatalf("turns %s", mustMarshal(turns))
		}
	})

	t.Run("carries on in the mode the user approves the plan in", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", PermissionMode: *plan})
		m.send(id, "propose One.")
		r := m.request(id)
		m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow, PermissionMode: protocol.PermissionModeAcceptEdits})
		s := m.settle(id)
		if s.Thread.PermissionMode != protocol.PermissionModeAcceptEdits {
			t.Fatalf("mode %s", s.Thread.PermissionMode)
		}
		if turn := m.runs()[0].params("turn/start")[1]; !has(turn, `{"approvalPolicy":"on-request","sandboxPolicy":{"type":"workspaceWrite"},"collaborationMode":{"mode":"default"}}`) {
			t.Fatalf("turn 1: %s", mustMarshal(turn))
		}
	})

	t.Run("takes a message sent while a plan waits as more to plan with", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", PermissionMode: *plan})
		m.send(id, "propose One.")
		r := m.request(id)
		m.send(id, "reply And two.", agentthreads.SendOptions{ClientID: "more"})
		s := m.settle(id)
		// Its event may reach the recorder after the thread's idle.
		until(t, func() bool { return cancelled(m, r.ID()) })
		var more *protocol.UserMessage
		for _, it := range s.Items {
			if u, ok := it.Value.(*protocol.UserMessage); ok && u.ClientID == "more" {
				more = u
			}
		}
		if more == nil || !more.Steered {
			t.Fatalf("message %s", mustMarshal(more))
		}
		if got := texts(s.Items); !reflect.DeepEqual(got, []string{"One.", "And two."}) {
			t.Fatalf("texts %v", got)
		}
		if len(results(s.Items)) != 1 {
			t.Fatalf("results %s", mustMarshal(results(s.Items)))
		}
		if turn := m.runs()[0].params("turn/start")[1]; !has(turn, `{"input":[{"type":"text","text":"reply And two."}],"collaborationMode":{"mode":"plan"}}`) {
			t.Fatalf("turn 1: %s", mustMarshal(turn))
		}
	})

	t.Run("ends the turn when it's interrupted while a plan waits", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", PermissionMode: *plan})
		m.send(id, "propose One.")
		r := m.request(id)
		if err := m.sdk.Interrupt(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		s := m.settle(id)
		if rs := results(s.Items); len(rs) != 1 || rs[0].OK || !rs[0].Interrupted {
			t.Fatalf("results %s", mustMarshal(rs))
		}
		if len(s.Requests) != 0 {
			t.Fatalf("the plan wasn't cancelled: %s", mustMarshal(s.Requests))
		}
		until(t, func() bool { return cancelled(m, r.ID()) })
	})

	t.Run("keeps what the plans used when the turn fails after them", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex", PermissionMode: *plan})
		m.send(id, "propose One.")
		r := m.request(id)
		m.respond(id, r.ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Message: "crash"})
		s := m.settle(id)
		used := `{"input_tokens":60,"cache_read_tokens":40,"output_tokens":10}`
		if rs := results(s.Items); len(rs) != 1 || rs[0].OK || !has(rs[0], `{"duration_ms":7,"usage":`+used+`}`) {
			t.Fatalf("results %s", mustMarshal(rs))
		}
		if !has(s.Thread, `{"usage":`+used+`}`) {
			t.Fatalf("thread %s", mustMarshal(s.Thread))
		}
	})

	t.Run("doesn't ask about a plan outside plan mode", func(t *testing.T) {
		t.Parallel()
		m := newMini(t, agentthreads.Allow, nil)
		id := m.create(agentthreads.CreateOptions{Harness: "codex"})
		m.send(id, "propose One.")
		s := m.settle(id)
		if rs := results(s.Items); len(rs) != 1 || !rs[0].OK || len(s.Requests) != 0 {
			t.Fatalf("got %s", mustMarshal(s))
		}
	})
}

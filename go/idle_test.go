//go:build unix

package agentthreads_test

// Letting a thread's idle harness process go (Options.IdleClose, AgentThreads.Release), keeping its
// session for the next turn, which resumes it in a new process. mini-claude.mjs and mini-codex.mjs
// (the Node backend's test harnesses) play Claude and Codex, and log their runs' starts and exits.

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// idleEnv is an AgentThreads with Claude Code played by mini-claude.mjs and Codex by mini-codex.mjs,
// whose runs are logged to log.
type idleEnv struct {
	t   *testing.T
	sdk *agentthreads.AgentThreads
	log string
}

// newIdleEnv is one with Options.IdleClose idle (nil: none), the policy (Allow if nil) and more
// environment for the mini CLIs.
func newIdleEnv(t *testing.T, idle *time.Duration, policy agentthreads.PermissionPolicy, env map[string]string) *idleEnv {
	t.Helper()
	needNode(t)
	e := &idleEnv{t: t, log: filepath.Join(t.TempDir(), "log.jsonl")}
	all := map[string]string{"MINI_CLAUDE_LOG": e.log, "MINI_CODEX_LOG": e.log, "MINI_CLAUDE_STEER": "now", "HOME": t.TempDir()}
	for k, v := range env {
		all[k] = v
	}
	if policy == nil {
		policy = agentthreads.Allow
	}
	e.sdk = agentthreads.New(agentthreads.Options{
		Store: agentthreads.NewMemoryStore(),
		Harnesses: map[string]agentthreads.Harness{
			"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: mini("claude"), Env: all, CloseGrace: time.Second}),
			"codex":  agentthreads.Codex(agentthreads.CodexOptions{Bin: mini("codex"), Env: all, Home: t.TempDir(), NoLogin: true, CloseGrace: time.Second}),
		},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
		Spawner:      agentthreads.Direct(),
		IdleClose:    idle,
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	t.Cleanup(func() { e.sdk.Stop(context.Background()) })
	return e
}

func (e *idleEnv) create(harness string) string {
	e.t.Helper()
	th, err := e.sdk.Create(context.Background(), agentthreads.CreateOptions{Harness: harness, Cwd: e.t.TempDir()})
	if err != nil {
		e.t.Fatal(err)
	}
	return th.ID
}

func (e *idleEnv) send(id, text string) {
	e.t.Helper()
	if err := e.sdk.Send(context.Background(), id, text, agentthreads.SendOptions{}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *idleEnv) snap(id string) protocol.Snapshot {
	e.t.Helper()
	s, err := e.sdk.Snapshot(context.Background(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// waitSnap waits until the thread's snapshot is as ok says, and is it.
func (e *idleEnv) waitSnap(id string, ok func(protocol.Snapshot) bool) protocol.Snapshot {
	e.t.Helper()
	var s protocol.Snapshot
	until(e.t, func() bool {
		s = e.snap(id)
		return ok(s)
	})
	return s
}

func (e *idleEnv) runs() []miniRun { return miniRuns(e.t, e.log) }

// exited waits until the run i has exited.
func (e *idleEnv) exited(i int) {
	e.t.Helper()
	until(e.t, func() bool {
		runs := e.runs()
		return len(runs) > i && runs[i].Exited
	})
}

// alive checks the run i hasn't exited, a while after.
func (e *idleEnv) alive(i int) {
	e.t.Helper()
	time.Sleep(100 * time.Millisecond)
	if runs := e.runs(); len(runs) <= i || runs[i].Exited {
		e.t.Fatalf("run %d isn't running: %+v", i, runs)
	}
}

func (e *idleEnv) release(id string) (bool, error) {
	return e.sdk.Release(context.Background(), id)
}

func isCommandError(err error) bool {
	var ce *agentthreads.CommandError
	return errors.As(err, &ce)
}

// idleAfter is an IdleClose of d.
func idleAfter(d time.Duration) *time.Duration { return &d }

func TestLetsAnIdleProcessGoAndResumesItsSessionInANewOne(t *testing.T) {
	t.Parallel()
	e := newIdleEnv(t, idleAfter(0), nil, nil)
	id := e.create("claude")
	e.send(id, "reply one")
	s := settle(t, e.sdk, id)
	session := s.Thread.SessionID
	if session == "" {
		t.Fatal("no session")
	}
	// Its input is closed, so it exits; the thread has no run, and keeps its session.
	e.exited(0)
	s = e.snap(id)
	if s.Thread.Run != nil || s.Thread.SessionID != session || s.Thread.Status != protocol.ThreadStatusIdle {
		t.Fatalf("the thread: %s", mustMarshal(s.Thread))
	}
	e.send(id, "reply two")
	s = settle(t, e.sdk, id)
	same(t, "texts", texts(s), []string{"one", "two"})
	runs := e.runs()
	if len(runs) != 2 || !hasFlag(runs[1].Argv, "--resume", session) {
		t.Fatalf("runs: %+v", runs)
	}
	r := turnResults(s.Items)
	if r[1].Session == nil || r[1].Session.ID != session || r[1].Session.Started {
		t.Fatalf("the second turn's session: %s", mustMarshal(r[1].Session))
	}
}

func TestAMessageSentBeforeTheIdleTimeIsUpGoesToTheLiveProcess(t *testing.T) {
	t.Parallel()
	e := newIdleEnv(t, idleAfter(400*time.Millisecond), nil, nil)
	id := e.create("claude")
	e.send(id, "reply one")
	settle(t, e.sdk, id)
	time.Sleep(200 * time.Millisecond)
	e.send(id, "reply two")
	settle(t, e.sdk, id)
	if n := len(e.runs()); n != 1 {
		t.Fatalf("%d runs", n)
	}
	// The wait starts again when a turn ends.
	time.Sleep(250 * time.Millisecond)
	if e.runs()[0].Exited {
		t.Fatal("let go before the idle time was up")
	}
	e.exited(0)
	if s := e.snap(id); s.Thread.Run != nil {
		t.Fatalf("the thread: %s", mustMarshal(s.Thread))
	}
}

func TestASteeredMessageCarriedOverGoesToTheLiveProcessBeforeItsLetGo(t *testing.T) {
	t.Parallel()
	// Claude takes the steered message in after its turn's result: the next turn, in the same process.
	e := newIdleEnv(t, idleAfter(0), nil, map[string]string{"MINI_CLAUDE_STEER": "late"})
	id := e.create("claude")
	e.send(id, "sleep 200 first")
	e.waitSnap(id, func(s protocol.Snapshot) bool { return s.Thread.SessionID != "" })
	e.send(id, "reply second")
	s := e.waitSnap(id, func(s protocol.Snapshot) bool {
		return len(turnResults(s.Items)) == 2 && s.Thread.Status == protocol.ThreadStatusIdle
	})
	same(t, "texts", texts(s), []string{"first", "second"})
	e.exited(0)
	if n := len(e.runs()); n != 1 {
		t.Fatalf("%d runs", n)
	}
}

func TestKeepsTheProcessWhileABackgroundSubagentRunsAndLetsItGoAfter(t *testing.T) {
	t.Parallel()
	// Claude reports the subagent a while after it ends: the process is kept for that turn too.
	e := newIdleEnv(t, idleAfter(0), nil, map[string]string{"MINI_CLAUDE_REPORT_DELAY": "200"})
	id := e.create("claude")
	e.send(id, "background 400 apple")
	e.waitSnap(id, func(s protocol.Snapshot) bool { return len(turnResults(s.Items)) == 1 })
	// Refused while the subagent runs.
	if _, err := e.release(id); !isCommandError(err) {
		t.Fatalf("release: %v", err)
	}
	e.alive(0)
	// Claude's own turn says how it went, and then it's let go.
	s := e.waitSnap(id, func(s protocol.Snapshot) bool {
		return len(turnResults(s.Items)) == 2 && s.Thread.Status == protocol.ThreadStatusIdle
	})
	if got := texts(s); got[len(got)-1] != "the subagent said apple" {
		t.Fatalf("texts: %q", got)
	}
	e.exited(0)
	if n := len(e.runs()); n != 1 {
		t.Fatalf("%d runs", n)
	}
}

func TestKeepsTheProcessWhileABackgroundSubagentsRequestIsOpen(t *testing.T) {
	t.Parallel()
	shell := agentthreads.PolicyFunc(func(_ context.Context, q agentthreads.PermissionQuery, _ agentthreads.PermissionContext) agentthreads.Decision {
		if q.Kind == protocol.ToolKindShell {
			return agentthreads.Ask
		}
		return agentthreads.Allow
	})
	e := newIdleEnv(t, idleAfter(0), shell, nil)
	id := e.create("claude")
	e.send(id, "background 0 apple")
	s := e.waitSnap(id, func(s protocol.Snapshot) bool {
		return len(turnResults(s.Items)) == 1 && s.Thread.Status == protocol.ThreadStatusWaiting
	})
	e.alive(0)
	open := protocol.OpenRequests(s)
	if len(open) != 1 {
		t.Fatalf("open requests: %s", mustMarshal(open))
	}
	if err := e.sdk.Respond(context.Background(), id, open[0].ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow}); err != nil {
		t.Fatal(err)
	}
	e.waitSnap(id, func(s protocol.Snapshot) bool {
		return len(turnResults(s.Items)) == 2 && s.Thread.Status == protocol.ThreadStatusIdle
	})
	e.exited(0)
}

func TestReleaseLetsAnIdleThreadsProcessGoAndIsRefusedWhileATurnRuns(t *testing.T) {
	t.Parallel()
	e := newIdleEnv(t, nil, nil, nil)
	id := e.create("claude")
	// No process yet.
	if ok, err := e.release(id); ok || err != nil {
		t.Fatalf("release: %v, %v", ok, err)
	}
	e.send(id, "slow")
	e.waitSnap(id, func(s protocol.Snapshot) bool { return s.Thread.SessionID != "" })
	if _, err := e.release(id); !isCommandError(err) {
		t.Fatalf("release during a turn: %v", err)
	}
	if err := e.sdk.Interrupt(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	s := settle(t, e.sdk, id)
	// Without IdleClose, it's kept.
	e.alive(0)
	if ok, err := e.release(id); !ok || err != nil {
		t.Fatalf("release: %v, %v", ok, err)
	}
	e.exited(0)
	if after := e.snap(id); after.Thread.Run != nil {
		t.Fatalf("the thread: %s", mustMarshal(after.Thread))
	}
	if ok, err := e.release(id); ok || err != nil {
		t.Fatalf("release again: %v, %v", ok, err)
	}
	e.send(id, "reply again")
	after := settle(t, e.sdk, id)
	if got := texts(after); got[len(got)-1] != "again" {
		t.Fatalf("texts: %q", got)
	}
	if runs := e.runs(); len(runs) != 2 || !hasFlag(runs[1].Argv, "--resume", s.Thread.SessionID) {
		t.Fatalf("runs: %+v", runs)
	}
}

func TestLetsAnIdleAppServerGoAndResumesTheSessionInANewOne(t *testing.T) {
	t.Parallel()
	e := newIdleEnv(t, idleAfter(0), nil, nil)
	id := e.create("codex")
	e.send(id, "reply first")
	s := settle(t, e.sdk, id)
	session := s.Thread.SessionID
	e.exited(0)
	s = e.snap(id)
	if s.Thread.Run != nil || s.Thread.SessionID != session {
		t.Fatalf("the thread: %s", mustMarshal(s.Thread))
	}
	e.send(id, "reply back")
	s = settle(t, e.sdk, id)
	same(t, "texts", texts(s), []string{"first", "back"})
	runs := e.runs()
	if len(runs) != 2 {
		t.Fatalf("%d runs", len(runs))
	}
	resumes := runs[1].sent("thread/resume")
	if len(resumes) != 1 || resumes[0]["params"].(map[string]any)["threadId"] != session {
		t.Fatalf("thread/resume: %s", mustMarshal(resumes))
	}
	if s.Thread.SessionID != session {
		t.Fatalf("the session: %s", s.Thread.SessionID)
	}
}

func TestKeepsTheAppServerWhileAChildThreadRunsAndLetsItGoAfter(t *testing.T) {
	t.Parallel()
	shell := agentthreads.PolicyFunc(func(_ context.Context, q agentthreads.PermissionQuery, _ agentthreads.PermissionContext) agentthreads.Decision {
		if q.Kind == protocol.ToolKindShell {
			return agentthreads.Ask
		}
		return agentthreads.Allow
	})
	e := newIdleEnv(t, idleAfter(0), shell, nil)
	id := e.create("codex")
	e.send(id, "bg touch a.txt")
	s := e.waitSnap(id, func(s protocol.Snapshot) bool {
		return len(turnResults(s.Items)) == 1 && s.Thread.Status == protocol.ThreadStatusWaiting
	})
	if _, err := e.release(id); !isCommandError(err) {
		t.Fatalf("release: %v", err)
	}
	e.alive(0)
	if err := e.sdk.Respond(context.Background(), id, s.Requests[0].ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow}); err != nil {
		t.Fatal(err)
	}
	s = e.waitSnap(id, func(s protocol.Snapshot) bool {
		calls := toolCalls(s)
		return s.Thread.Status == protocol.ThreadStatusIdle && len(calls) > 0 && calls[0].Subagent != nil && calls[0].Subagent.Status == protocol.SubagentStatusCompleted
	})
	if calls := toolCalls(s); calls[1].Status != protocol.ToolStatusCompleted {
		t.Fatalf("the child's call: %s", mustMarshal(calls[1]))
	}
	e.exited(0)
	if n := len(e.runs()); n != 1 {
		t.Fatalf("%d runs", n)
	}
}

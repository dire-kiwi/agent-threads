//go:build unix

package agentthreads_test

// A new_session or rewind retires the harness process of the old session: what's still going on in
// it (a background subagent, and the turn Claude starts by itself when one ends) can't reach the
// thread after. mini-claude.mjs (the Node backend's test harness) plays Claude.

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func TestASessionChangeRetiresTheProcess(t *testing.T) {
	for _, change := range []string{"new_session", "rewind"} {
		t.Run("stops the process when "+change+" changes the session, so a background subagent's turn can't bring the old one back", func(t *testing.T) {
			ctx := context.Background()
			log := filepath.Join(t.TempDir(), "mini.log")
			sdk, rec := miniClaude(t, agentthreads.Allow, map[string]string{"MINI_CLAUDE_LOG": log})
			th, err := sdk.Create(ctx, agentthreads.CreateOptions{Model: "mini", Cwd: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			sdk.Send(ctx, th.ID, "background 500 apple", agentthreads.SendOptions{})
			if rec.waitFor(0, []byte(`{"type":"turn.completed"}`), waitFor) < 0 {
				t.Fatal("the turn didn't end")
			}
			s, _ := sdk.Snapshot(ctx, th.ID)
			if s.Thread.SessionID == "" {
				t.Fatalf("no session: %s", mustMarshal(s.Thread))
			}
			var agent *protocol.ToolCall
			for _, c := range toolCalls(s) {
				if c.Name == "Agent" {
					agent = c
				}
			}
			if agent == nil || agent.Subagent == nil || agent.Subagent.Status != protocol.SubagentStatusRunning {
				t.Fatalf("the Agent call: %s", mustMarshal(agent))
			}
			if change == "new_session" {
				err = sdk.NewSession(ctx, th.ID)
			} else {
				err = sdk.Rewind(ctx, th.ID, turnResults(s.Items)[0].TurnID)
			}
			if err != nil {
				t.Fatal(err)
			}
			// Long enough for the subagent to have ended, and Claude's turn about it to have come.
			time.Sleep(time.Second)
			s, _ = sdk.Snapshot(ctx, th.ID)
			if s.Thread.SessionID != "" || s.Thread.Status != protocol.ThreadStatusIdle {
				t.Fatalf("the thread: %s", mustMarshal(s.Thread))
			}
			code := "rewind"
			if change == "new_session" {
				code = "session.new"
			}
			if n, ok := s.Items[len(s.Items)-1].Value.(*protocol.Notice); !ok || n.Code != code {
				t.Fatalf("the last item: %s\n%s", mustMarshal(s.Items[len(s.Items)-1]), show(rec.all()))
			}
			if slices.Contains(texts(s), "the subagent said apple") {
				t.Fatalf("the old session's turn came:\n%s", show(rec.all()))
			}
			if change == "new_session" {
				for _, c := range toolCalls(s) {
					if c.ID == agent.ID && (c.Subagent == nil || c.Subagent.Status != protocol.SubagentStatusStopped) {
						t.Fatalf("the Agent call: %s", mustMarshal(c))
					}
				}
			}
			if runs := miniRuns(t, log); len(runs) != 1 {
				t.Fatalf("%d runs, not 1", len(runs))
			}
			// The next message starts a new process, in a new session.
			sdk.Send(ctx, th.ID, "reply fresh", agentthreads.SendOptions{})
			s = settle(t, sdk, th.ID)
			if got := texts(s); len(got) == 0 || got[len(got)-1] != "fresh" {
				t.Fatalf("texts: %q", got)
			}
			runs := miniRuns(t, log)
			if len(runs) != 2 || slices.Contains(runs[1].Argv, "--resume") {
				t.Fatalf("runs: %+v", runs)
			}
		})
	}
}

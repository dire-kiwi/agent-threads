package agentthreads_test

// Background subagents, which the recordings cover only when nothing goes wrong: their calls and
// requests outlive their turn, and they're stopped when their run ends. mini-claude.mjs (the Node
// backend's test harness) plays Claude.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func miniClaude(t *testing.T, policy agentthreads.PermissionPolicy) (*agentthreads.AgentThreads, *recorder) {
	needNode(t)
	mini := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-claude.mjs")
	rec := &recorder{}
	sdk := agentthreads.New(agentthreads.Options{
		Store:        agentthreads.NewMemoryStore(),
		Harnesses:    map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: mini})},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
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
	sdk, rec := miniClaude(t, shell)
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
	if snap.Thread.Status != protocol.ThreadStatusWaiting || len(snap.Requests) != 1 || len(calls) != 2 {
		t.Fatalf("after the turn:\n%s", show(rec.all()))
	}
	agent, bash := calls[0], calls[1]
	if agent.Status != protocol.ToolStatusCompleted || agent.Subagent == nil || agent.Subagent.Status != protocol.SubagentStatusRunning || !agent.Subagent.Background || agent.Subagent.Model != "mini-1" {
		t.Fatalf("the Agent call: %s", mustMarshal(agent))
	}
	if bash.Status != protocol.ToolStatusPending || bash.ParentID != agent.ID {
		t.Fatalf("the subagent's call: %s", mustMarshal(bash))
	}

	sdk.Respond(ctx, th.ID, snap.Requests[0].ID(), protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow})
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
	sdk, rec := miniClaude(t, agentthreads.Allow)
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

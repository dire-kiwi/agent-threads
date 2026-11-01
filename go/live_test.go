package agentthreads_test

// Smoke tests against the real claude and codex, which need them installed and logged in, and cost
// a cent or so: AGENT_THREADS_LIVE=1 go test -run Live. (CLAUDE_BIN and CODEX_BIN name other
// binaries, CODEX_MODEL another model.)

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func live(t *testing.T) {
	if os.Getenv("AGENT_THREADS_LIVE") == "" {
		t.Skip("set AGENT_THREADS_LIVE=1 to run against the real CLIs")
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func lookupOrder() agentthreads.Tool {
	type args struct {
		OrderID string `json:"order_id"`
	}
	return agentthreads.TypedTool("lookup_order", "Looks up an order by its id.",
		`{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}`,
		func(_ context.Context, a args, _ agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
			return agentthreads.Text(fmt.Sprintf("Order %s: 3 blue widgets.", a.OrderID)), nil
		})
}

// turn sends a message and waits for its turn to end.
func turn(t *testing.T, sdk *agentthreads.AgentThreads, threadID, text string) protocol.Snapshot {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	events := sdk.Events(ctx)
	if err := sdk.Send(ctx, threadID, text, agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	ended := false
	for e := range events {
		if e.ThreadID() != threadID {
			continue
		}
		ended = ended || e.Type() == "turn.completed"
		// The thread.updated after the turn's end, which says how it is now.
		if u, ok := e.Value.(*protocol.ThreadUpdatedEvent); ok && ended && u.Thread.Status != protocol.ThreadStatusRunning {
			snap, err := sdk.Snapshot(ctx, threadID)
			if err != nil {
				t.Fatal(err)
			}
			return snap
		}
	}
	t.Fatal("the turn didn't end")
	return protocol.Snapshot{}
}

func replyText(s protocol.Snapshot) string {
	var b strings.Builder
	for _, it := range s.Items {
		if m, ok := it.Value.(*protocol.AssistantMessage); ok {
			b.WriteString(m.Text)
		}
	}
	return b.String()
}

func appCall(s protocol.Snapshot) *protocol.ToolCall {
	for _, it := range s.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok && c.Kind == protocol.ToolKindApp {
			return c
		}
	}
	return nil
}

// lineSpawner is the direct spawner, keeping the process's output.
type lineSpawner struct {
	agentthreads.Spawner
	mu    sync.Mutex
	lines []string
}

func (s *lineSpawner) Spawn(o agentthreads.SpawnOptions, h agentthreads.ProcessHandlers) (agentthreads.Process, error) {
	line := h.Line
	h.Line = func(l string) {
		s.mu.Lock()
		s.lines = append(s.lines, l)
		s.mu.Unlock()
		line(l)
	}
	return s.Spawner.Spawn(o, h)
}

func TestLiveClaude(t *testing.T) {
	live(t)
	spawner := &lineSpawner{Spawner: agentthreads.Direct()}
	sdk := agentthreads.New(agentthreads.Options{
		Harnesses: map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: envOr("CLAUDE_BIN", "claude")})},
		Spawner:   spawner,
		Capabilities: agentthreads.Capabilities{
			Tools:       []agentthreads.Tool{lookupOrder()},
			Skills:      []agentthreads.Skill{{Name: "review-sentinel", Content: "---\nname: review-sentinel\ndescription: Says sentinel.\n---\nSay sentinel.\n"}},
			Permissions: agentthreads.Allow,
		},
	})
	defer sdk.Close(context.Background())
	th, err := sdk.Create(context.Background(), agentthreads.CreateOptions{Model: "haiku", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	s := turn(t, sdk, th.ID, "Reply with exactly these words and nothing else: hello from agent-threads")
	if s.Thread.Status != protocol.ThreadStatusIdle || s.Thread.SessionID == "" || !regexp.MustCompile(`(?i)hello from agent-threads`).MatchString(replyText(s)) {
		t.Fatalf("got %s", mustMarshal(s))
	}
	// The app's skill is there, though the user's and the project's config aren't loaded.
	spawner.mu.Lock()
	output := strings.Join(spawner.lines, "\n")
	spawner.mu.Unlock()
	if !strings.Contains(output, `"app:review-sentinel"`) {
		t.Errorf("Claude doesn't list the app's skill")
	}
	s = turn(t, sdk, th.ID, "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.")
	call := appCall(s)
	if call == nil || call.Name != "lookup_order" || call.Status != protocol.ToolStatusCompleted || call.Result == nil || call.Result.Content != "Order 42: 3 blue widgets." {
		t.Fatalf("got %s", mustMarshal(s.Items))
	}
	if s.Thread.Usage == nil || s.Thread.Usage.CostUSD == nil || *s.Thread.Usage.CostUSD <= 0 {
		t.Errorf("no cost in %s", mustMarshal(s.Thread.Usage))
	}
}

func TestLiveCodex(t *testing.T) {
	live(t)
	for _, overMCP := range []bool{false, true} {
		t.Run(map[bool]string{false: "dynamic tools", true: "loopback MCP"}[overMCP], func(t *testing.T) {
			sdk := agentthreads.New(agentthreads.Options{
				Harnesses:    map[string]agentthreads.Harness{"codex": agentthreads.Codex(agentthreads.CodexOptions{Bin: envOr("CODEX_BIN", "codex"), Home: t.TempDir(), AppToolsOverMCP: overMCP})},
				Capabilities: agentthreads.Capabilities{Tools: []agentthreads.Tool{lookupOrder()}, Permissions: agentthreads.Allow},
			})
			defer sdk.Close(context.Background())
			th, err := sdk.Create(context.Background(), agentthreads.CreateOptions{Harness: "codex", Model: envOr("CODEX_MODEL", "gpt-5.6-luna"), Effort: "low", Cwd: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			s := turn(t, sdk, th.ID, "Reply with exactly these words and nothing else: hello from agent-threads")
			if s.Thread.Status != protocol.ThreadStatusIdle || s.Thread.SessionID == "" || !regexp.MustCompile(`(?i)hello from agent-threads`).MatchString(replyText(s)) {
				t.Fatalf("got %s", mustMarshal(s))
			}
			s = turn(t, sdk, th.ID, "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.")
			call := appCall(s)
			if call == nil || call.Name != "lookup_order" || call.Status != protocol.ToolStatusCompleted || call.Result == nil || !strings.Contains(call.Result.Content, "Order 42: 3 blue widgets.") {
				t.Fatalf("got %s", mustMarshal(s.Items))
			}
			if s.Thread.Usage == nil || s.Thread.Usage.OutputTokens <= 0 {
				t.Errorf("no usage in %s", mustMarshal(s.Thread.Usage))
			}
		})
	}
}

// The real codex against a local stand-in for the model (no login, no cost): what it's sent.
func TestLiveCodexSkills(t *testing.T) {
	live(t)
	var mu sync.Mutex
	var bodies []string
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body strings.Builder
		buf := make([]byte, 1<<16)
		for {
			n, err := r.Body.Read(buf)
			body.Write(buf[:n])
			if err != nil {
				break
			}
		}
		mu.Lock()
		bodies = append(bodies, body.String())
		mu.Unlock()
		w.Header().Set("content-type", "text/event-stream")
		event := func(typ string, o map[string]any) {
			o["type"] = typ
			data, _ := json.Marshal(o)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", typ, data)
		}
		event("response.created", map[string]any{"response": map[string]any{"id": "r"}})
		event("response.output_item.done", map[string]any{"item": map[string]any{"type": "message", "role": "assistant", "id": "m", "content": []any{map[string]any{"type": "output_text", "text": "ok"}}}})
		usage := map[string]any{"input_tokens": 1, "input_tokens_details": map[string]any{"cached_tokens": 0}, "output_tokens": 1, "output_tokens_details": map[string]any{"reasoning_tokens": 0}, "total_tokens": 2}
		event("response.completed", map[string]any{"response": map[string]any{"id": "r", "usage": usage}})
	})}
	go server.Serve(ln)
	defer server.Close()
	skill := func(root, name string) {
		os.MkdirAll(filepath.Join(root, name), 0o755)
		os.WriteFile(filepath.Join(root, name, "SKILL.md"), []byte(fmt.Sprintf("---\nname: %s\ndescription: The %s skill.\n---\nSay %s.\n", name, name, name)), 0o644)
	}
	home, cwd := t.TempDir(), t.TempDir()
	skill(filepath.Join(home, ".agents", "skills"), "user-sentinel")
	skill(filepath.Join(cwd, ".agents", "skills"), "repo-sentinel")
	provider := fmt.Sprintf(`model_providers.local={name="local",base_url="http://%s/v1",wire_api="responses",requires_openai_auth=false}`, ln.Addr())
	sdk := agentthreads.New(agentthreads.Options{
		Harnesses: map[string]agentthreads.Harness{"codex": agentthreads.Codex(agentthreads.CodexOptions{
			Bin: envOr("CODEX_BIN", "codex"), Home: t.TempDir(), NoLogin: true, Env: map[string]string{"HOME": home},
			Args: []string{"-c", provider, "-c", "model_provider=local"},
		})},
		Capabilities: agentthreads.Capabilities{
			Skills:      []agentthreads.Skill{{Name: "app-sentinel", Content: "---\nname: app-sentinel\ndescription: The app-sentinel skill.\n---\nSay app-sentinel.\n"}},
			Permissions: agentthreads.Allow,
		},
	})
	defer sdk.Close(context.Background())
	th, err := sdk.Create(context.Background(), agentthreads.CreateOptions{Harness: "codex", Model: "gpt-5.6-luna", Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	turn(t, sdk, th.ID, "hi")
	mu.Lock()
	sent := strings.Join(bodies, "\n")
	mu.Unlock()
	if !strings.Contains(sent, "app-sentinel") || strings.Contains(sent, "user-sentinel") || strings.Contains(sent, "repo-sentinel") {
		t.Fatalf("the skills sent aren't the app's alone")
	}
}

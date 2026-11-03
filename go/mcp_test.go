//go:build unix

package agentthreads_test

// The app's external MCP servers, as each harness is given them: Codex with each server's Codex
// settings in its mcp_servers table, Claude Code with its --mcp-config in a file of the run's own
// rather than on its command line.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
)

func TestCodexGivesMCPServersTheirCodexSettings(t *testing.T) {
	needNode(t)
	ctx := context.Background()
	log := filepath.Join(t.TempDir(), "log.jsonl")
	var servers map[string]agentthreads.MCPServer
	// As an app's options (and the fixtures) write them.
	if err := json.Unmarshal([]byte(`{
		"gh": {"command": "gh-mcp", "args": ["--stdio"], "env": {"TOKEN": "x"}},
		"board": {"command": "board-mcp", "args": ["--serve"], "codex": {"tool_timeout_sec": 3900, "startup_timeout_sec": 20, "default_tools_approval_mode": "approve", "command": "not-this"}},
		"search": {"url": "https://example.com/search", "headers": {"X-Key": "k"}, "codex": {"tool_timeout_sec": 600}}
	}`), &servers); err != nil {
		t.Fatal(err)
	}
	sdk := agentthreads.New(agentthreads.Options{
		Harnesses: map[string]agentthreads.Harness{"codex": agentthreads.Codex(agentthreads.CodexOptions{
			Bin: mini("codex"), Home: t.TempDir(), Login: t.TempDir(), CloseGrace: time.Second,
			Env: map[string]string{"MINI_CODEX_LOG": log, "HOME": t.TempDir()},
		})},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow, MCPServers: servers},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	defer sdk.Close(ctx)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Harness: "codex", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply ok", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	settle(t, sdk, th.ID)
	start := miniRuns(t, log)[0].sent("thread/start")[0]
	got := start["params"].(map[string]any)["config"].(map[string]any)["mcp_servers"]
	// The server's own fields over its Codex settings.
	same(t, "mcp_servers", got, map[string]any{
		"gh": map[string]any{"command": "gh-mcp", "args": []any{"--stdio"}, "env": map[string]any{"TOKEN": "x"}},
		"board": map[string]any{
			"command": "board-mcp", "args": []any{"--serve"},
			"tool_timeout_sec": float64(3900), "startup_timeout_sec": float64(20), "default_tools_approval_mode": "approve",
		},
		"search": map[string]any{"url": "https://example.com/search", "http_headers": map[string]any{"X-Key": "k"}, "tool_timeout_sec": float64(600)},
	})
}

func TestClaudeWritesTheMCPConfigToAPrivateFile(t *testing.T) {
	mcpConfigInAPrivateFile(t, nil)
}

func TestClaudeWritesTheMCPConfigToAPrivateFileUnderTheShim(t *testing.T) {
	mcpConfigInAPrivateFile(t, agentthreads.Shim(shimPath(t), agentthreads.ShimOptions{RunsDir: t.TempDir()}))
}

// mcpConfigInAPrivateFile starts a thread with MCP servers whose environment and headers have a
// secret: it isn't on any process's command line while Claude runs (its --mcp-config is a file
// readable by the user only), and the file goes with the run.
func mcpConfigInAPrivateFile(t *testing.T, spawner agentthreads.Spawner) {
	ctx := context.Background()
	secret := fmt.Sprintf("secret-%d-%d", os.Getpid(), time.Now().UnixNano())
	env := newClaudeEnv(t, agentthreads.NewMemoryStore(), spawner, agentthreads.ClaudeOptions{}, nil)
	sdk := env.make()
	defer sdk.Stop(ctx)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir(), Capabilities: agentthreads.Capabilities{
		MCPServers: map[string]agentthreads.MCPServer{
			// Codex's settings are Codex's alone: Claude Code takes MCP_TOOL_TIMEOUT from its environment.
			"echo": {Command: "node", Args: []string{"echo.mjs"}, Env: map[string]string{"ECHO_TOKEN": secret}, Codex: map[string]any{"tool_timeout_sec": 600}},
			"docs": {URL: "https://example.com/mcp", Headers: map[string]string{"authorization": "Bearer " + secret}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply hi", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	settle(t, sdk, th.ID)
	argv := env.runs()[0].Argv
	for _, a := range argv {
		if strings.Contains(a, secret) {
			t.Fatalf("the secret is in Claude's arguments: %q", argv)
		}
	}
	// Claude stays up between turns: nothing running has the secret on its command line.
	if runtime.GOOS == "linux" {
		procs, _ := os.ReadDir("/proc")
		for _, p := range procs {
			if cmdline, err := os.ReadFile(filepath.Join("/proc", p.Name(), "cmdline")); err == nil && strings.Contains(string(cmdline), secret) {
				t.Fatalf("/proc/%s has the secret on its command line", p.Name())
			}
		}
	}
	files := flagValues(argv, "--mcp-config")
	if len(files) != 1 || !strings.HasPrefix(filepath.Base(files[0]), "mcp-") {
		t.Fatalf("--mcp-config %q", files)
	}
	file := files[0]
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	same(t, "echo", config.MCPServers["echo"], map[string]any{
		"type": "stdio", "command": "node", "args": []any{"echo.mjs"}, "env": map[string]any{"ECHO_TOKEN": secret},
	})
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file's mode: %v %v", info.Mode(), err)
	}
	// It goes with the run.
	if err := sdk.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("the file is still there: %v", err)
	}
}

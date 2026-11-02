package agentthreads_test

// Every fixture in spec/fixtures (Claude Code and Codex), run as spec/fixtures/README.md says: the
// SDK drives the fake CLI (which replays the recording and checks what it's sent), and its events
// must match expected.jsonl by spec/tools/check-events.mjs's rules. Its snapshot must be its events,
// folded. The pass-through fixtures' control requests, harness messages and raw payloads are checked
// too.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

var specDir, _ = filepath.Abs("../spec")

type fixture struct {
	Thread struct {
		Harness        string                  `json:"harness"`
		Model          string                  `json:"model"`
		Effort         string                  `json:"effort"`
		PermissionMode protocol.PermissionMode `json:"permission_mode"`
	} `json:"thread"`
	Permissions string `json:"permissions"`
	Tools       []struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Input       json.RawMessage `json:"input"`
		Result      string          `json:"result"`
	} `json:"tools"`
	MCPServers map[string]agentthreads.MCPServer `json:"mcp_servers"`
	Steps      []struct {
		Command json.RawMessage `json:"command"`
		Wait    json.RawMessage `json:"wait"`
		Restart bool            `json:"restart"`
		Control json.RawMessage `json:"control"`
		Result  json.RawMessage `json:"result"`
		Error   *string         `json:"error"`
	} `json:"steps"`
	Raw             bool              `json:"raw"`
	HarnessMessages []json.RawMessage `json:"harness_messages"`
	RawChecks       []struct {
		Event json.RawMessage `json:"event"`
		Raw   json.RawMessage `json:"raw"`
	} `json:"raw_checks"`
}

// recorder collects an SDK's events.
type recorder struct {
	mu     sync.Mutex
	events []protocol.ThreadEvent
}

func (r *recorder) add(e protocol.ThreadEvent) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) all() []protocol.ThreadEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]protocol.ThreadEvent(nil), r.events...)
}

func (r *recorder) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

// waitFor is the index of the first event from from on that matches pattern, or -1 after d.
func (r *recorder) waitFor(from int, pattern json.RawMessage, d time.Duration) int {
	var p any
	json.Unmarshal(pattern, &p)
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		events := r.all()
		for i := from; i < len(events); i++ {
			var v any
			json.Unmarshal(mustMarshal(events[i]), &v)
			if matches(v, p) {
				return i
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	return -1
}

// matches says whether v has everything pattern has (objects field by field, everything else exactly).
func matches(v, pattern any) bool {
	if p, ok := pattern.(map[string]any); ok {
		o, ok := v.(map[string]any)
		if !ok {
			return false
		}
		for k, x := range p {
			if !matches(o[k], x) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(v, pattern)
}

func mustMarshal(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

func show(events []protocol.ThreadEvent) string {
	var b strings.Builder
	for _, e := range events {
		if e.Type() == "delta" {
			continue
		}
		line := string(mustMarshal(e))
		if len(line) > 300 {
			line = line[:300]
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}

func scenarios(t *testing.T) []string {
	var out []string
	for _, h := range []string{"claude", "codex"} {
		dirs, err := os.ReadDir(filepath.Join(specDir, "fixtures", h))
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range dirs {
			if _, err := os.Stat(filepath.Join(specDir, "fixtures", h, d.Name(), "session.jsonl")); err == nil {
				out = append(out, h+"/"+d.Name())
			}
		}
	}
	sort.Strings(out)
	return out
}

// spawners are the spawners every fixture runs with: as a child process, and under the shim (but
// not on Windows).
func spawners() []string {
	if runtime.GOOS == "windows" {
		return []string{"direct"}
	}
	return []string{"direct", "shim"}
}

func needNode(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("the fake CLI needs node")
	}
}

func TestFixtures(t *testing.T) {
	needNode(t)
	for _, scenario := range scenarios(t) {
		for _, spawner := range spawners() {
			t.Run(scenario+"/"+spawner, func(t *testing.T) {
				t.Parallel()
				runFixture(t, scenario, spawner)
			})
		}
	}
}

const waitFor = 10 * time.Second

func runFixture(t *testing.T, scenario, spawnerName string) {
	dir := filepath.Join(specDir, "fixtures", scenario)
	var fx fixture
	data, err := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	cwd, state, codexHome := t.TempDir(), t.TempDir(), t.TempDir()
	store := agentthreads.NewMemoryStore()
	rec := &recorder{}
	env := map[string]string{"AGENT_THREADS_FIXTURE": dir, "AGENT_THREADS_FIXTURE_STATE": state}
	fakeCLI := filepath.Join(specDir, "tools", "fake-cli.mjs")
	var spawner agentthreads.Spawner = agentthreads.Direct()
	if spawnerName == "shim" {
		spawner = agentthreads.Shim(shimPath(t), agentthreads.ShimOptions{RunsDir: t.TempDir()})
	}
	var tools []agentthreads.Tool
	for _, tool := range fx.Tools {
		result := tool.Result
		tools = append(tools, agentthreads.ToolFunc(tool.Name, tool.Description, tool.Input, func(context.Context, json.RawMessage, agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
			return agentthreads.Text(result), nil
		}))
	}
	var policy agentthreads.PermissionPolicy = agentthreads.Allow
	if fx.Permissions == "ask" {
		policy = agentthreads.Ask
	}
	var messagesMu sync.Mutex
	var messages []agentthreads.HarnessMessage
	var onMessage func(agentthreads.HarnessMessage)
	if fx.Raw {
		onMessage = func(m agentthreads.HarnessMessage) {
			messagesMu.Lock()
			messages = append(messages, m)
			messagesMu.Unlock()
		}
	}
	make := func() *agentthreads.AgentThreads {
		sdk := agentthreads.New(agentthreads.Options{
			Store: store,
			Harnesses: map[string]agentthreads.Harness{
				"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: fakeCLI, Env: env}),
				"codex":  agentthreads.Codex(agentthreads.CodexOptions{Bin: fakeCLI, Env: env, Home: codexHome, NoLogin: true}),
			},
			Capabilities:     agentthreads.Capabilities{Tools: tools, MCPServers: fx.MCPServers, Permissions: policy},
			Spawner:          spawner,
			OnError:          func(err error) { t.Errorf("OnError: %v", err) },
			Raw:              fx.Raw,
			OnHarnessMessage: onMessage,
		})
		sdk.Subscribe(rec.add)
		return sdk
	}
	ctx := context.Background()
	sdk := make()
	thread, err := sdk.Create(ctx, agentthreads.CreateOptions{
		Harness: fx.Thread.Harness, Model: fx.Thread.Model, Effort: fx.Thread.Effort, PermissionMode: fx.Thread.PermissionMode, Cwd: cwd,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Its first event is delivered (subscribers get events on a goroutine of their own) before the
	// steps begin, so a wait doesn't match it.
	if rec.waitFor(0, json.RawMessage(`{"type":"thread.updated","seq":1}`), waitFor) < 0 {
		t.Fatal("no first thread.updated")
	}
	from := 1
	for i, step := range fx.Steps {
		where := fmt.Sprintf("step %d", i+1)
		switch {
		case step.Restart:
			if err := sdk.Stop(ctx); err != nil {
				t.Fatalf("%s: %v", where, err)
			}
			sdk = make()
			from = rec.len()
		case step.Control != nil:
			result, err := sdk.Control(ctx, thread.ID, step.Control)
			if step.Error != nil {
				var ce *agentthreads.ControlError
				if !errors.As(err, &ce) || !strings.Contains(err.Error(), *step.Error) {
					t.Fatalf("%s: got %s, %v; want a ControlError with %q", where, result, err, *step.Error)
				}
			} else if err != nil {
				t.Fatalf("%s: %v", where, err)
			} else if !sameJSON(result, step.Result) {
				t.Fatalf("%s: got %s, want %s", where, result, step.Result)
			}
		case step.Command != nil:
			var cmd map[string]any
			json.Unmarshal(step.Command, &cmd)
			cmd["thread_id"] = thread.ID
			if cmd["type"] == "respond" {
				snap, err := sdk.Snapshot(ctx, thread.ID)
				if err != nil {
					t.Fatal(err)
				}
				open := protocol.OpenRequests(snap)
				if len(open) != 1 {
					t.Fatalf("%s: %d requests open, not 1", where, len(open))
				}
				cmd["request_id"] = open[0].ID()
			}
			from = rec.len()
			if err := sdk.HandleJSON(ctx, mustMarshal(cmd)); err != nil {
				t.Fatalf("%s: %v", where, err)
			}
		default:
			at := rec.waitFor(from, step.Wait, waitFor)
			if at < 0 {
				t.Fatalf("%s: no %s within %s. Events since the step before:\n%s", where, step.Wait, waitFor, show(rec.all()[from:]))
			}
			from = at + 1
		}
	}

	// Its snapshot is its events, folded (deltas included).
	snap, err := sdk.Snapshot(ctx, thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	all := rec.all()
	first := thread
	if u, ok := all[0].Value.(*protocol.ThreadUpdatedEvent); ok {
		first = u.Thread
	}
	if got, want := string(mustMarshal(snap)), string(mustMarshal(protocol.ApplyEvents(protocol.InitialState(first), all))); got != want {
		t.Errorf("the snapshot isn't its events, folded:\n got %s\nwant %s", got, want)
	}
	if err := sdk.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	all = rec.all()

	// The fake CLI was sent what the recording has, in every run.
	runs := 0
	session, _ := os.ReadFile(filepath.Join(dir, "session.jsonl"))
	for _, line := range bytes.Split(session, []byte("\n")) {
		if bytes.Contains(line, []byte(`"dir":"spawn"`)) {
			runs++
		}
	}
	for n := 1; n <= runs; n++ {
		data, err := os.ReadFile(filepath.Join(state, fmt.Sprintf("run-%d.json", n)))
		if err != nil {
			t.Fatalf("no report for run %d of %d: %v", n, runs, err)
		}
		var report struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		json.Unmarshal(data, &report)
		if !report.OK {
			t.Fatalf("run %d: %s", n, data)
		}
	}
	if extra, _ := filepath.Glob(filepath.Join(state, fmt.Sprintf("run-%d.json", runs+1))); len(extra) > 0 {
		t.Fatalf("more runs than the recording has")
	}

	// The events match expected.jsonl.
	checkEvents(t, filepath.Join(dir, "expected.jsonl"), all)

	// What the protocol leaves out came through.
	messagesMu.Lock()
	got := append([]agentthreads.HarnessMessage(nil), messages...)
	messagesMu.Unlock()
	for _, m := range got {
		if m.ThreadID != thread.ID || m.Harness != fx.Thread.Harness || m.RunID == "" {
			t.Errorf("a harness message for another thread or run: %+v", m)
		}
		if m.Message != nil && !json.Valid(m.Message) {
			t.Errorf("a harness message that isn't JSON: %s", m.Message)
		}
	}
	for _, pattern := range fx.HarnessMessages {
		var p any
		json.Unmarshal(pattern, &p)
		found := false
		for _, m := range got {
			var v any
			if m.Message != nil && json.Unmarshal(m.Message, &v) == nil && matches(v, p) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no harness message like %s", pattern)
		}
	}
	for _, c := range fx.RawChecks {
		var event, want any
		json.Unmarshal(c.Event, &event)
		json.Unmarshal(c.Raw, &want)
		n := 0
		for _, e := range all {
			var v any
			json.Unmarshal(mustMarshal(e), &v)
			if !matches(v, event) {
				continue
			}
			n++
			raw := e.Raw()
			switch x := e.Value.(type) {
			case *protocol.ItemAddedEvent:
				raw = x.Item.Raw()
			case *protocol.RequestOpenedEvent:
				raw = x.Request.Raw()
			}
			line := string(mustMarshal(e))
			if len(line) > 300 {
				line = line[:300]
			}
			if want == nil {
				if raw != nil {
					t.Errorf("%s has a raw: %.300s", line, raw)
				}
				continue
			}
			var r any
			if raw == nil || json.Unmarshal(raw, &r) != nil || !matches(r, want) {
				t.Errorf("%s doesn't have a raw like %s: %.300s", line, c.Raw, raw)
			}
		}
		if n == 0 {
			t.Errorf("no event like %s", c.Event)
		}
	}
}

// sameJSON says whether two JSON values are equal (objects whatever their keys' order).
func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

// checkEvents compares events with an expected.jsonl, by spec/tools/check-events.mjs.
func checkEvents(t *testing.T, expected string, events []protocol.ThreadEvent) {
	t.Helper()
	var lines bytes.Buffer
	for _, e := range events {
		lines.Write(mustMarshal(e))
		lines.WriteByte('\n')
	}
	actual := filepath.Join(t.TempDir(), "events.jsonl")
	os.WriteFile(actual, lines.Bytes(), 0o644)
	out, err := exec.Command("node", filepath.Join(specDir, "tools", "check-events.mjs"), expected, actual).CombinedOutput()
	if err != nil {
		t.Fatalf("%s\n\nEvents:\n%s", out, show(events))
	}
}

var (
	shimOnce sync.Once
	shimBin  string
	shimErr  error
)

// shimPath is agent-threads-shim, built from ../shim if it isn't yet (or $AGENT_THREADS_SHIM).
// Building it needs cargo.
func shimPath(t *testing.T) string {
	shimOnce.Do(func() {
		if given := os.Getenv("AGENT_THREADS_SHIM"); given != "" {
			shimBin = given
			return
		}
		dir, _ := filepath.Abs("../shim")
		shimBin = filepath.Join(dir, "target", "debug", "agent-threads-shim")
		if _, err := os.Stat(shimBin); err == nil {
			return
		}
		if _, err := exec.LookPath("cargo"); err != nil {
			shimErr = fmt.Errorf("agent-threads-shim isn't built, and there's no cargo to build it")
			return
		}
		cmd := exec.Command("cargo", "build", "--quiet", "--manifest-path", filepath.Join(dir, "Cargo.toml"))
		cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
		shimErr = cmd.Run()
	})
	if shimErr != nil {
		t.Skipf("no shim: %v", shimErr)
	}
	return shimBin
}

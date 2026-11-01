//go:build unix

package agentthreads_test

// Runs that survive a backend restart: a backend (this test binary, run as a process of its own) runs
// a fixture's turn under the shim, and is killed with SIGKILL partway through it. A new backend
// recovers, and the thread finishes as if nothing had happened: the store has exactly the fixture's
// events (with a notice that the run was picked up again), none lost and none twice.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func TestMain(m *testing.M) {
	if os.Getenv("AGENT_THREADS_TEST_BACKEND") != "" {
		runBackend()
		return
	}
	os.Exit(m.Run())
}

// runBackend is a backend in a process of its own, for the restart tests to kill: a FileStore, the
// shim spawner, and Claude Code and Codex played by the fake CLI. It takes commands on stdin, one
// JSON object a line ({id, op, args}), and writes each reply ({reply, result} or {reply, error})
// and every event ({event}) to stdout, a line each.
func runBackend() {
	env := os.Getenv
	fake := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "AGENT_THREADS_FIXTURE") {
			fake[k] = v
		}
	}
	store, err := agentthreads.NewFileStore(env("STORE"))
	if err != nil {
		panic(err)
	}
	var policy agentthreads.PermissionPolicy = agentthreads.Allow
	if env("POLICY") == "ask" {
		policy = agentthreads.Ask
	}
	var mu sync.Mutex
	out := func(msg any) {
		mu.Lock()
		defer mu.Unlock()
		os.Stdout.Write(append(mustMarshal(msg), '\n'))
	}
	sdk := agentthreads.New(agentthreads.Options{
		Store: store,
		Harnesses: map[string]agentthreads.Harness{
			"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: env("FAKE_CLI"), Env: fake}),
			"codex":  agentthreads.Codex(agentthreads.CodexOptions{Bin: env("FAKE_CLI"), Env: fake, Home: env("CODEX_HOME_DIR"), NoLogin: true}),
		},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
		Spawner:      agentthreads.Shim(env("SHIM"), agentthreads.ShimOptions{RunsDir: env("RUNS"), Poll: 50 * time.Millisecond}),
		OnError:      func(err error) { fmt.Fprintf(os.Stderr, "backend error: %v\n", err) },
	})
	sdk.Subscribe(func(e protocol.ThreadEvent) { out(map[string]any{"event": e}) })
	ctx := context.Background()
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(nil, 1<<24)
	for in.Scan() {
		var req struct {
			ID   int               `json:"id"`
			Op   string            `json:"op"`
			Args []json.RawMessage `json:"args"`
		}
		json.Unmarshal(in.Bytes(), &req)
		arg := func(i int) json.RawMessage {
			if i < len(req.Args) {
				return req.Args[i]
			}
			return nil
		}
		var result any
		var err error
		switch req.Op {
		case "create":
			var o struct {
				Harness, Model, Effort, Cwd string
			}
			json.Unmarshal(arg(0), &o)
			result, err = sdk.Create(ctx, agentthreads.CreateOptions{Harness: o.Harness, Model: o.Model, Effort: o.Effort, Cwd: o.Cwd})
		case "handle":
			err = sdk.HandleJSON(ctx, arg(0))
		case "snapshot":
			var id string
			json.Unmarshal(arg(0), &id)
			result, err = sdk.Snapshot(ctx, id)
		case "recover":
			result, err = sdk.Recover(ctx)
		case "close", "stop":
			if req.Op == "stop" {
				err = sdk.Stop(ctx)
			} else {
				err = sdk.Close(ctx)
			}
			store.Close()
		}
		if err != nil {
			out(map[string]any{"reply": req.ID, "error": err.Error()})
		} else {
			out(map[string]any{"reply": req.ID, "result": result})
		}
		if req.Op == "close" || req.Op == "stop" {
			os.Exit(0)
		}
	}
}

// backend is a backend process, and what it has said.
type backend struct {
	t       *testing.T
	cmd     *exec.Cmd
	stdin   interface{ Write([]byte) (int, error) }
	events  recorder
	mu      sync.Mutex
	replies map[int]chan json.RawMessage
	next    int
	exited  chan struct{}
}

func startBackend(t *testing.T, env []string) *backend {
	exe, _ := os.Executable()
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), append(env, "AGENT_THREADS_TEST_BACKEND=1")...)
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	b := &backend{t: t, cmd: cmd, stdin: stdin, replies: map[int]chan json.RawMessage{}, exited: make(chan struct{})}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(nil, 1<<24)
		for sc.Scan() {
			var msg struct {
				Event *protocol.ThreadEvent `json:"event"`
				Reply *int                  `json:"reply"`
			}
			line := append([]byte(nil), sc.Bytes()...)
			json.Unmarshal(line, &msg)
			if msg.Event != nil {
				b.events.add(*msg.Event)
			} else if msg.Reply != nil {
				b.mu.Lock()
				ch := b.replies[*msg.Reply]
				b.mu.Unlock()
				if ch != nil {
					ch <- line
				}
			}
		}
		cmd.Wait()
		close(b.exited)
	}()
	return b
}

func (b *backend) call(op string, args ...any) json.RawMessage {
	b.t.Helper()
	b.mu.Lock()
	b.next++
	id := b.next
	ch := make(chan json.RawMessage, 1)
	b.replies[id] = ch
	b.mu.Unlock()
	b.stdin.Write(append(mustMarshal(map[string]any{"id": id, "op": op, "args": args}), '\n'))
	select {
	case line := <-ch:
		var r struct {
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
		}
		json.Unmarshal(line, &r)
		if r.Error != "" {
			b.t.Fatalf("%s: %s", op, r.Error)
		}
		return r.Result
	case <-b.exited:
		b.t.Fatalf("%s: the backend exited", op)
	case <-time.After(20 * time.Second):
		b.t.Fatalf("%s: no reply", op)
	}
	return nil
}

func (b *backend) waitFor(pattern string) {
	b.t.Helper()
	if b.events.waitFor(0, json.RawMessage(pattern), 15*time.Second) < 0 {
		b.t.Fatalf("no event like %s; got:\n%s", pattern, show(b.events.all()))
	}
}

// crash kills it as a crash would: no chance to save anything or stop anything.
func (b *backend) crash() {
	b.cmd.Process.Signal(syscall.SIGKILL)
	<-b.exited
}

func until(t *testing.T, what func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !what() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// scene is a fixture's directories and environment, which its backends share.
type scene struct {
	t                       *testing.T
	fixture                 string
	fx                      fixture
	store, runs, state, cwd string
	env                     []string
}

func newScene(t *testing.T, name string, extra ...string) *scene {
	s := &scene{t: t, fixture: name, store: t.TempDir(), runs: t.TempDir(), state: t.TempDir(), cwd: t.TempDir()}
	data, _ := os.ReadFile(filepath.Join(specDir, "fixtures", name, "fixture.json"))
	json.Unmarshal(data, &s.fx)
	policy := s.fx.Permissions
	if policy == "" {
		policy = "allow"
	}
	s.env = append([]string{
		"STORE=" + s.store, "RUNS=" + s.runs, "CODEX_HOME_DIR=" + t.TempDir(), "SHIM=" + shimPath(t),
		"FAKE_CLI=" + filepath.Join(specDir, "tools", "fake-cli.mjs"), "POLICY=" + policy,
		"AGENT_THREADS_FIXTURE=" + filepath.Join(specDir, "fixtures", name), "AGENT_THREADS_FIXTURE_STATE=" + s.state,
	}, extra...)
	return s
}

func (s *scene) start() *backend { return startBackend(s.t, s.env) }

// begin creates the thread and sends the fixture's first command.
func (s *scene) begin(b *backend) string {
	var th protocol.Thread
	json.Unmarshal(b.call("create", map[string]any{"harness": s.fx.Thread.Harness, "model": s.fx.Thread.Model, "effort": s.fx.Thread.Effort, "cwd": s.cwd}), &th)
	var cmd map[string]any
	json.Unmarshal(s.fx.Steps[0].Command, &cmd)
	cmd["thread_id"] = th.ID
	b.call("handle", cmd)
	return th.ID
}

// check checks the saved events are the fixture's expected events (without deltas, which aren't
// saved), plus the notices that the run was picked up again, and that the fake CLI got what it should.
func (s *scene) check(threadID string, reattached int) {
	t := s.t
	t.Helper()
	store, err := agentthreads.NewFileStore(s.store)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.ReadEvents(context.Background(), threadID, 0, 0)
	store.Close()
	if err != nil {
		t.Fatal(err)
	}
	var rest []protocol.ThreadEvent
	notices := 0
	for _, e := range saved {
		if a, ok := e.Value.(*protocol.ItemAddedEvent); ok {
			if n, ok := a.Item.Value.(*protocol.Notice); ok && n.Code == "run.reattached" {
				notices++
				continue
			}
		}
		rest = append(rest, e)
	}
	if notices != reattached {
		t.Fatalf("%d run.reattached notices, not %d", notices, reattached)
	}
	// Without them, renumbered, the events must be exactly the fixture's.
	for i, e := range rest {
		e.Number(threadID, int64(i+1))
	}
	expected, _ := os.ReadFile(filepath.Join(specDir, "fixtures", s.fixture, "expected.jsonl"))
	var kept bytes.Buffer
	for _, line := range bytes.Split(expected, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 && !bytes.Contains(line, []byte(`"type":"delta"`)) {
			kept.Write(line)
			kept.WriteByte('\n')
		}
	}
	path := filepath.Join(t.TempDir(), "expected.jsonl")
	os.WriteFile(path, kept.Bytes(), 0o644)
	checkEvents(t, path, rest)
	report, err := os.ReadFile(filepath.Join(s.state, "run-1.json"))
	if err != nil || !bytes.Contains(report, []byte(`"ok":true`)) {
		t.Fatalf("run 1: %s %v", report, err)
	}
	if _, err := os.Stat(filepath.Join(s.state, "run-2.json")); err == nil {
		t.Fatal("more runs than one")
	}
}

func TestRestart(t *testing.T) {
	needNode(t)
	// For each harness: a fixture whose turn waits on the user, one that streams (with approvals the
	// policy answers), and one that needs no input after it starts, which can end while the backend
	// is down, the pace it's replayed at, when it's partway through that turn, and what marks its end
	// in its output.
	type harness struct {
		waits, streams, ends, pace string
		partway                    func(s *scene, b *backend, out func() string)
		ended                      string
	}
	harnesses := map[string]harness{
		"claude": {waits: "claude/permission-allow", streams: "claude/tool-calls", ends: "claude/subagent", pace: "0.2",
			partway: func(_ *scene, b *backend, _ func() string) {
				b.waitFor(`{"type":"item.added","item":{"type":"tool_call"}}`)
			},
			ended: `"type":"result"`},
		"codex": {waits: "codex/permission-allow", streams: "codex/tool-calls", ends: "codex/plain-reply", pace: "0.5",
			partway: func(s *scene, _ *backend, out func() string) {
				until(s.t, func() bool { return strings.Contains(out(), `"method":"turn/started"`) })
			},
			ended: `"method":"turn/completed"`},
	}
	for name, f := range harnesses {
		t.Run(name, func(t *testing.T) {
			t.Run("while the turn waits on the user", func(t *testing.T) {
				t.Parallel()
				s := newScene(t, f.waits)
				a := s.start()
				id := s.begin(a)
				a.waitFor(`{"type":"request.opened"}`)
				a.crash()

				b := s.start()
				expectRecovered(t, b, id)
				snap := snapshotOf(t, b, id)
				if snap.Thread.Status != protocol.ThreadStatusWaiting || snap.Thread.Run == nil || snap.Thread.Run.ReattachedAt == "" || len(snap.Requests) != 1 {
					t.Fatalf("got %s", mustMarshal(snap))
				}
				b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": snap.Requests[0].ID(), "resolution": map[string]any{"outcome": "allow"}})
				b.waitFor(`{"type":"thread.updated","thread":{"status":"idle"}}`)
				b.call("stop")
				<-b.exited
				s.check(id, 1)
			})

			t.Run("while output streams in", func(t *testing.T) {
				t.Parallel()
				// Replayed at a fifth of the recorded pace, so the backend is killed partway through the turn.
				s := newScene(t, f.streams, "AGENT_THREADS_FIXTURE_SPEED=0.2")
				a := s.start()
				id := s.begin(a)
				a.waitFor(`{"type":"item.added","item":{"type":"tool_call"}}`)
				time.Sleep(100 * time.Millisecond)
				a.crash()

				b := s.start()
				expectRecovered(t, b, id)
				b.waitFor(`{"type":"thread.updated","thread":{"status":"idle"}}`)
				b.call("stop")
				<-b.exited
				s.check(id, 1)
			})

			t.Run("when the run ends while it's down", func(t *testing.T) {
				t.Parallel()
				s := newScene(t, f.ends, "AGENT_THREADS_FIXTURE_SPEED="+f.pace)
				a := s.start()
				id := s.begin(a)
				var runDir string
				until(t, func() bool {
					entries, _ := os.ReadDir(s.runs)
					if len(entries) > 0 {
						runDir = filepath.Join(s.runs, entries[0].Name())
					}
					return runDir != ""
				})
				out := func() string { data, _ := os.ReadFile(filepath.Join(runDir, "out.jsonl")); return string(data) }
				f.partway(s, a, out)
				a.crash()

				// While it's down, the turn finishes and the run ends (its input closed, as a backend would).
				if strings.Contains(out(), f.ended) {
					t.Fatal("the turn ended before the backend was killed")
				}
				until(t, func() bool { return strings.Contains(out(), f.ended) })
				os.WriteFile(filepath.Join(runDir, "input.closed"), nil, 0o644)
				until(t, func() bool { _, err := os.Stat(filepath.Join(runDir, "exit")); return err == nil })

				b := s.start()
				expectRecovered(t, b, id)
				b.waitFor(`{"type":"thread.updated","thread":{"status":"idle"}}`)
				// The run's over, and the backend is done with it.
				until(t, func() bool {
					for _, e := range b.events.all() {
						if u, ok := e.Value.(*protocol.ThreadUpdatedEvent); ok && u.Thread.Status == "idle" && u.Thread.Run == nil {
							return true
						}
					}
					return false
				})
				b.call("close")
				<-b.exited
				s.check(id, 1)
				store, _ := agentthreads.NewFileStore(s.store)
				defer store.Close()
				if active, _ := store.ActiveRuns(context.Background()); len(active) != 0 {
					t.Fatalf("active runs: %v", active)
				}
				run, _ := store.GetRun(context.Background(), filepath.Base(runDir))
				if run == nil || run.Offset != int64(len(out())) {
					t.Fatalf("got run %+v, want offset %d", run, len(out()))
				}
			})

			t.Run("when it's shut down", func(t *testing.T) {
				t.Parallel()
				s := newScene(t, f.waits)
				a := s.start()
				id := s.begin(a)
				a.waitFor(`{"type":"request.opened"}`)
				a.call("close")
				<-a.exited

				b := s.start()
				expectRecovered(t, b, id)
				snap := snapshotOf(t, b, id)
				b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": snap.Requests[0].ID(), "resolution": map[string]any{"outcome": "allow"}})
				b.waitFor(`{"type":"thread.updated","thread":{"status":"idle"}}`)
				b.call("stop")
				<-b.exited
				s.check(id, 1)
			})
		})
	}
}

func expectRecovered(t *testing.T, b *backend, id string) {
	t.Helper()
	var r agentthreads.Recovered
	json.Unmarshal(b.call("recover"), &r)
	if len(r.Reattached) != 1 || r.Reattached[0] != id || len(r.Lost) != 0 {
		t.Fatalf("recovered %+v", r)
	}
}

func snapshotOf(t *testing.T, b *backend, id string) protocol.Snapshot {
	var snap protocol.Snapshot
	json.Unmarshal(b.call("snapshot", id), &snap)
	return snap
}

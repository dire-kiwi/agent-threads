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
	"slices"
	"strconv"
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
	fileStore, err := agentthreads.NewFileStore(env("STORE"))
	if err != nil {
		panic(err)
	}
	var store agentthreads.Store = fileStore
	// With SAVE_DELAY_MS, each save (AppendEvents) takes that long.
	if ms, _ := strconv.Atoi(env("SAVE_DELAY_MS")); ms > 0 {
		store = slowStore{fileStore, time.Duration(ms) * time.Millisecond}
	}
	ms := func(k string) time.Duration { n, _ := strconv.Atoi(env(k)); return time.Duration(n) * time.Millisecond }
	or := func(k, def string) string {
		if v := env(k); v != "" {
			return v
		}
		return def
	}
	var policy agentthreads.PermissionPolicy = agentthreads.Allow
	if env("POLICY") == "ask" {
		policy = agentthreads.Ask
	}
	// SPAWNER=direct runs the harnesses as its own children instead of under the shim.
	var spawner agentthreads.Spawner = agentthreads.Shim(env("SHIM"), agentthreads.ShimOptions{RunsDir: env("RUNS"), Poll: 50 * time.Millisecond})
	if env("SPAWNER") == "direct" {
		spawner = agentthreads.Direct()
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
			"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: or("CLAUDE_BIN", env("FAKE_CLI")), Env: fake, StopGrace: ms("STOP_GRACE_MS"), SteerGrace: ms("STEER_GRACE_MS"), CloseGrace: ms("CLOSE_GRACE_MS")}),
			"codex":  agentthreads.Codex(agentthreads.CodexOptions{Bin: or("CODEX_BIN", env("FAKE_CLI")), Env: fake, Home: env("CODEX_HOME_DIR"), NoLogin: true, StopGrace: ms("STOP_GRACE_MS"), CloseGrace: ms("CLOSE_GRACE_MS")}),
		},
		Capabilities: agentthreads.Capabilities{Permissions: policy},
		Spawner:      spawner,
		OnError:      func(err error) { fmt.Fprintf(os.Stderr, "backend error: %v\n", err) },
		LateAnswers:  env("LATE_ANSWERS") != "",
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
				PermissionMode              protocol.PermissionMode `json:"permission_mode"`
			}
			json.Unmarshal(arg(0), &o)
			result, err = sdk.Create(ctx, agentthreads.CreateOptions{Harness: o.Harness, Model: o.Model, Effort: o.Effort, PermissionMode: o.PermissionMode, Cwd: o.Cwd})
		case "handle":
			err = sdk.HandleJSON(ctx, arg(0))
		case "snapshot":
			var id string
			json.Unmarshal(arg(0), &id)
			result, err = sdk.Snapshot(ctx, id)
		case "saved":
			// Once every event so far is saved (and the run with them).
			var id string
			json.Unmarshal(arg(0), &id)
			_, err = sdk.EventsSince(ctx, id, 0, 0)
		case "recover":
			result, err = sdk.Recover(ctx)
		case "delete":
			// Within ms milliseconds.
			var id string
			var ms int
			json.Unmarshal(arg(0), &id)
			json.Unmarshal(arg(1), &ms)
			short, cancel := context.WithTimeout(ctx, time.Duration(ms)*time.Millisecond)
			result, err = sdk.Delete(short, id)
			cancel()
		case "hold":
			var id string
			json.Unmarshal(arg(0), &id)
			err = agentthreads.HoldThreadPastTimers(sdk, id)
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

// slowStore takes a while over each save.
type slowStore struct {
	*agentthreads.FileStore
	delay time.Duration
}

func (s slowStore) AppendEvents(ctx context.Context, id string, events []protocol.ThreadEvent, runs []agentthreads.RunRecord) error {
	time.Sleep(s.delay)
	return s.FileStore.AppendEvents(ctx, id, events, runs)
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
	result, err := b.try(op, args...)
	if err != "" {
		b.t.Fatalf("%s: %s", op, err)
	}
	return result
}

// try is call, for one that may fail: it returns the error.
func (b *backend) try(op string, args ...any) (json.RawMessage, string) {
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
		return r.Result, r.Error
	case <-b.exited:
		b.t.Fatalf("%s: the backend exited", op)
	case <-time.After(20 * time.Second):
		b.t.Fatalf("%s: no reply", op)
	}
	return nil, ""
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
				if snap.Thread.Status != protocol.ThreadStatusWaiting || snap.Thread.Run == nil || snap.Thread.Run.ReattachedAt == "" || len(protocol.OpenRequests(snap)) != 1 {
					t.Fatalf("got %s", mustMarshal(snap))
				}
				b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": protocol.OpenRequests(snap)[0].ID(), "resolution": map[string]any{"outcome": "allow"}})
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
				b.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": protocol.OpenRequests(snap)[0].ID(), "resolution": map[string]any{"outcome": "allow"}})
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

// miniScene runs mini-claude.mjs as Claude and mini-codex.mjs as Codex (the Node backend's test
// harnesses), for what the recordings don't cover.
func miniScene(t *testing.T, extra ...string) *scene {
	tests := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test")
	return newScene(t, "claude/plain-reply", append([]string{
		"CLAUDE_BIN=" + filepath.Join(tests, "mini-claude.mjs"), "CODEX_BIN=" + filepath.Join(tests, "mini-codex.mjs"),
		"MINI_CLAUDE_LOG=" + filepath.Join(t.TempDir(), "log.jsonl"),
	}, extra...)...)
}

func (s *scene) startWith(extra ...string) *backend {
	return startBackend(s.t, append(append([]string{}, s.env...), extra...))
}

func (s *scene) create(b *backend, harness string) string {
	var th protocol.Thread
	json.Unmarshal(b.call("create", map[string]any{"harness": harness, "cwd": s.cwd}), &th)
	return th.ID
}

func (s *scene) runDir() string {
	var dir string
	until(s.t, func() bool {
		entries, _ := os.ReadDir(s.runs)
		if len(entries) > 0 {
			dir = filepath.Join(s.runs, entries[0].Name())
		}
		return dir != ""
	})
	return dir
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func TestRestartStopsARunThatIgnoresAnInterrupt(t *testing.T) {
	needNode(t)
	for _, how := range []string{"killed", "closed"} {
		for harness, interrupt := range map[string]string{"claude": `"subtype":"interrupt"`, "codex": `"method":"turn/interrupt"`} {
			t.Run(how+"/"+harness, func(t *testing.T) {
				t.Parallel()
				s := miniScene(t, "STOP_GRACE_MS=1000", "CLOSE_GRACE_MS=500")
				// Saving takes a while, so the backend is killed after the interrupt is sent, and before
				// any save that comes after it would be done.
				a := s.startWith("SAVE_DELAY_MS=500")
				id := s.create(a, harness)
				a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "stubborn"})
				a.waitFor(`{"type":"turn.started"}`)
				dir := s.runDir()
				until(t, func() bool { _, err := os.Stat(filepath.Join(dir, "pid")); return err == nil })
				// It has taken in the message, and ignores interrupts from now on.
				time.Sleep(500 * time.Millisecond)
				a.call("saved", id)
				go a.call("handle", map[string]any{"type": "interrupt", "thread_id": id})
				until(t, func() bool {
					data, _ := os.ReadFile(filepath.Join(dir, "input.jsonl"))
					return strings.Contains(string(data), interrupt)
				})
				if how == "killed" {
					a.crash()
				} else {
					// Shut down within the interrupt's grace: the run's left going, still to be stopped.
					a.call("close")
					<-a.exited
				}
				pid := readPidFile(t, dir)
				if !processAlive(pid) {
					t.Fatal("the run's program went with the backend")
				}

				b := s.start()
				expectRecovered(t, b, id)
				// Stopped once the interrupt's grace is over, and the turn ends as interrupted.
				until(t, func() bool { return !processAlive(pid) })
				b.waitFor(`{"type":"turn.completed"}`)
				b.waitFor(`{"type":"item.added","item":{"type":"turn_result","interrupted":true}}`)
				until(t, func() bool { _, err := os.Stat(filepath.Join(dir, "stopping")); return err != nil })
				b.call("stop")
				<-b.exited
			})
		}
	}
}

func readPidFile(t *testing.T, dir string) int {
	data, err := os.ReadFile(filepath.Join(dir, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func TestRestartDoesntAskAgainWhatWasAnswered(t *testing.T) {
	needNode(t)
	cases := []struct{ harness, opening, text, answer string }{
		{"claude", "saved", "tool Bash {}", `"behavior":"allow"`},
		{"codex", "saved", "sleep 1000\nexec ls\nsleep 3000", `"decision":"accept"`},
		{"claude", "not saved", "tool Bash {}", `"behavior":"allow"`},
		{"codex", "not saved", "sleep 1000\nexec ls\nsleep 3000", `"decision":"accept"`},
	}
	for _, c := range cases {
		t.Run(c.harness+"/"+c.opening, func(t *testing.T) {
			t.Parallel()
			// Claude asks a while after the tool call, and the turn runs on for a while after it's
			// allowed (Codex's turn waits before and after the command).
			s := miniScene(t, "POLICY=ask", "MINI_CLAUDE_ASK_DELAY=1000", "MINI_CLAUDE_TOOL_RUN_MS=3000")
			// Saving takes a while, so the backend is killed after the answer is sent, and before the
			// save that has it is done: and, unless the request's opening is saved first, before that is.
			a := s.startWith("SAVE_DELAY_MS=500")
			id := s.create(a, c.harness)
			a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": c.text})
			a.waitFor(`{"type":"turn.started"}`)
			// The run and its turn are saved before the request comes.
			a.call("saved", id)
			a.waitFor(`{"type":"request.opened"}`)
			var requestID string
			for _, e := range a.events.all() {
				if o, ok := e.Value.(*protocol.RequestOpenedEvent); ok {
					requestID = o.Request.ID()
				}
			}
			if c.opening == "saved" {
				a.call("saved", id)
			}
			dir := s.runDir()
			input := func() string { data, _ := os.ReadFile(filepath.Join(dir, "input.jsonl")); return string(data) }
			go a.call("handle", map[string]any{"type": "respond", "thread_id": id, "request_id": requestID, "resolution": map[string]any{"outcome": "allow"}})
			until(t, func() bool { return strings.Contains(input(), c.answer) })
			a.crash()

			b := s.start()
			expectRecovered(t, b, id)
			// The tool's still running: nothing's asked of the user, and the turn runs on.
			time.Sleep(500 * time.Millisecond)
			snap := snapshotOf(t, b, id)
			if len(protocol.OpenRequests(snap)) != 0 || snap.Thread.Status != protocol.ThreadStatusRunning {
				t.Fatalf("got %s", mustMarshal(snap))
			}
			resolved, notice := -1, -1
			for i, e := range b.events.all() {
				switch v := e.Value.(type) {
				case *protocol.RequestOpenedEvent:
					t.Fatal("asked again")
				case *protocol.RequestResolvedEvent:
					if v.RequestID == requestID && resolved < 0 {
						resolved = i
					}
				case *protocol.ItemAddedEvent:
					if n, ok := v.Item.Value.(*protocol.Notice); ok && n.Code == "run.reattached" {
						notice = i
					}
				}
			}
			// Closed as the run's picked up again.
			if c.opening == "saved" && (resolved < 0 || resolved > notice) {
				t.Fatalf("resolved at %d, notice at %d", resolved, notice)
			}
			b.waitFor(`{"type":"turn.completed"}`)
			b.call("stop")
			<-b.exited
			// Answered once.
			if n := strings.Count(input(), c.answer); n != 1 {
				t.Fatalf("answered %d times", n)
			}
		})
	}
}

// A Delete whose context runs out while a run that ignores its closed input is being stopped leaves
// the thread refusing commands; a Close then waits for that stop, rather than leaving the run going
// for the next backend.
func TestCloseAfterATimedOutDelete(t *testing.T) {
	needNode(t)
	s := miniScene(t, "CLOSE_GRACE_MS=500")
	a := s.start()
	id := s.create(a, "claude")
	a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "stubborn"})
	a.waitFor(`{"type":"turn.started"}`)
	dir := s.runDir()
	until(t, func() bool { _, err := os.Stat(filepath.Join(dir, "pid")); return err == nil })
	pid := readPidFile(t, dir)
	// It has taken in the message, and ignores its input closing from now on.
	time.Sleep(500 * time.Millisecond)
	if _, err := a.try("delete", id, 50); !strings.Contains(err, "deadline exceeded") {
		t.Fatalf("delete: %q", err)
	}
	if _, err := a.try("handle", map[string]any{"type": "send", "thread_id": id, "text": "reply hi"}); !strings.Contains(err, "being deleted") {
		t.Fatalf("send: %q", err)
	}
	a.call("close")
	<-a.exited
	if processAlive(pid) {
		t.Fatal("the run's program outlived Close")
	}
	store, err := agentthreads.NewFileStore(s.store)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if runs, err := store.ActiveRuns(context.Background()); err != nil || len(runs) != 0 {
		t.Fatalf("runs left going: %+v %v", runs, err)
	}
}

// A run left going as the backend closes keeps the deadlines of its steer and stop timers, though
// they went off while Close's Detach was queued, and posted their functions after it.
func TestCloseKeepsTheDeadlinesOfTimersThatWentOff(t *testing.T) {
	needNode(t)
	s := miniScene(t, "MINI_CLAUDE_STEER=never", "STEER_GRACE_MS=1500", "STOP_GRACE_MS=1500")
	a := s.start()
	id := s.create(a, "claude")
	a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "sleep 300 one"})
	first := a.events.waitFor(0, json.RawMessage(`{"type":"turn.started"}`), 15*time.Second)
	if first < 0 {
		t.Fatal("no turn")
	}
	// Steered, never taken in: carried over to a turn of its own, which waits for Claude to take it in.
	a.call("handle", map[string]any{"type": "send", "thread_id": id, "text": "reply two"})
	if a.events.waitFor(first+1, json.RawMessage(`{"type":"turn.started"}`), 15*time.Second) < 0 {
		t.Fatalf("no carried turn; got:\n%s", show(a.events.all()))
	}
	a.call("handle", map[string]any{"type": "interrupt", "thread_id": id})
	snap := snapshotOf(t, a, id)
	if snap.Thread.Run == nil {
		t.Fatal("no run")
	}
	runID := snap.Thread.Run.ID
	pid := readPidFile(t, s.runDir())
	a.call("hold", id)
	a.call("close")
	<-a.exited

	store, err := agentthreads.NewFileStore(s.store)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.GetRun(context.Background(), runID)
	store.Close()
	if err != nil || record == nil || !record.Active() {
		t.Fatalf("run: %+v %v", record, err)
	}
	var data struct {
		State struct {
			SteerAt *int64 `json:"steerAt"`
			StopAt  *int64 `json:"stopAt"`
		} `json:"state"`
	}
	json.Unmarshal(record.Data, &data)
	if data.State.SteerAt == nil || data.State.StopAt == nil {
		t.Fatalf("the deadlines are gone: %s", record.Data)
	}
	if !processAlive(pid) {
		t.Fatal("the run's program went with the backend")
	}

	// The next backend carries them out: the run's stopped, and the turn ends.
	b := s.start()
	expectRecovered(t, b, id)
	until(t, func() bool { return !processAlive(pid) })
	b.waitFor(`{"type":"turn.completed"}`)
	b.call("stop")
	<-b.exited
}

// After a restart, the next turn starts a new process if the options changed, as it would have. (A
// new effort needs a new process; a model or permission mode doesn't.)
func TestRestartStartsANewProcessIfTheOptionsChanged(t *testing.T) {
	needNode(t)
	log := filepath.Join(t.TempDir(), "log.jsonl")
	s := miniScene(t, "MINI_CLAUDE_LOG="+log)
	a := s.start()
	var th protocol.Thread
	json.Unmarshal(a.call("create", map[string]any{"harness": "claude", "effort": "old", "cwd": s.cwd}), &th)
	a.call("handle", map[string]any{"type": "send", "thread_id": th.ID, "text": "reply one"})
	a.waitFor(`{"type":"turn.completed"}`)
	a.call("handle", map[string]any{"type": "set_options", "thread_id": th.ID, "effort": "new"})
	a.waitFor(`{"type":"thread.updated","thread":{"effort":"new"}}`)
	a.call("saved", th.ID)
	a.crash()

	b := s.start()
	expectRecovered(t, b, th.ID)
	b.call("handle", map[string]any{"type": "send", "thread_id": th.ID, "text": "reply two"})
	b.waitFor(`{"type":"turn.completed"}`)
	b.call("stop")
	<-b.exited
	data, _ := os.ReadFile(log)
	var efforts []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var v struct{ Argv []string }
		json.Unmarshal([]byte(line), &v)
		if i := slices.Index(v.Argv, "--effort"); i >= 0 && i+1 < len(v.Argv) {
			efforts = append(efforts, v.Argv[i+1])
		}
	}
	if !slices.Equal(efforts, []string{"old", "new"}) {
		t.Fatalf("efforts %v", efforts)
	}
}

// A plan Codex proposed is still asked about after a restart, and approving it carries on with the
// turn.
func TestRestartStillAsksAboutCodexsPlan(t *testing.T) {
	needNode(t)
	log := filepath.Join(t.TempDir(), "log.jsonl")
	s := miniScene(t, "MINI_CODEX_LOG="+log)
	a := s.start()
	var th protocol.Thread
	json.Unmarshal(a.call("create", map[string]any{"harness": "codex", "permission_mode": "plan", "cwd": s.cwd}), &th)
	a.call("handle", map[string]any{"type": "send", "thread_id": th.ID, "text": "propose One."})
	a.waitFor(`{"type":"request.opened","request":{"type":"plan","plan":"One."}}`)
	a.call("saved", th.ID)
	a.crash()

	b := s.start()
	expectRecovered(t, b, th.ID)
	snap := snapshotOf(t, b, th.ID)
	if snap.Thread.Status != protocol.ThreadStatusWaiting || len(snap.Requests) != 1 {
		t.Fatalf("got %s", mustMarshal(snap))
	}
	if _, ok := snap.Requests[0].Value.(*protocol.PlanRequest); !ok {
		t.Fatalf("request %s", mustMarshal(snap.Requests[0]))
	}
	b.call("handle", map[string]any{"type": "respond", "thread_id": th.ID, "request_id": snap.Requests[0].ID(), "resolution": map[string]any{"outcome": "allow", "permission_mode": "accept_edits"}})
	b.waitFor(`{"type":"thread.updated","thread":{"status":"idle"}}`)
	snap = snapshotOf(t, b, th.ID)
	b.call("stop")
	<-b.exited
	var results []*protocol.TurnResult
	for _, it := range snap.Items {
		if r, ok := it.Value.(*protocol.TurnResult); ok {
			results = append(results, r)
		}
	}
	if snap.Thread.PermissionMode != protocol.PermissionModeAcceptEdits || len(results) != 1 || !results[0].OK || results[0].DurationMs == nil || *results[0].DurationMs != 14 {
		t.Fatalf("got %s", mustMarshal(snap))
	}
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), `"text":"Implement the plan."`) {
		t.Fatalf("no turn to implement the plan:\n%s", data)
	}
}

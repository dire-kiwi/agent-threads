//go:build unix

package agentthreads_test

// A thread's launch options (args, environment, directories, config directory): what each
// harness's process is started with, stored with the thread but never sent to clients. The
// harnesses are mini-claude.mjs and mini-codex.mjs (the Node backend's test harnesses), whose logs
// say what each run was started with.

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// mini is the path to mini-claude.mjs or mini-codex.mjs.
func mini(name string) string {
	return filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-"+name+".mjs")
}

// miniRun is what a run of mini-claude or mini-codex was started with and sent, from its log.
type miniRun struct {
	Argv []string
	// ConfigDir is its CLAUDE_CONFIG_DIR or CODEX_HOME ("" if unset), and Env the variables
	// MINI_LOG_ENV names (nil if unset).
	ConfigDir string
	Env       map[string]*string
	Sent      []map[string]any
	Notes     []map[string]any
}

// miniRuns reads a mini-claude or mini-codex log.
func miniRuns(t *testing.T, log string) []miniRun {
	t.Helper()
	f, err := os.Open(log)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []miniRun
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<24)
	for sc.Scan() {
		if len(strings.TrimSpace(sc.Text())) == 0 {
			continue
		}
		var v map[string]json.RawMessage
		if err := json.Unmarshal(sc.Bytes(), &v); err != nil {
			t.Fatalf("log line %q: %v", sc.Text(), err)
		}
		if argv, ok := v["argv"]; ok {
			var r miniRun
			json.Unmarshal(argv, &r.Argv)
			for _, k := range []string{"configDir", "codexHome"} {
				if d, ok := v[k]; ok && r.ConfigDir == "" {
					json.Unmarshal(d, &r.ConfigDir)
				}
			}
			json.Unmarshal(v["env"], &r.Env)
			out = append(out, r)
			continue
		}
		var m map[string]any
		json.Unmarshal(sc.Bytes(), &m)
		last := &out[len(out)-1]
		_, rpc := v["jsonrpc"]
		_, method := v["method"]
		_, id := v["id"]
		_, typ := v["type"]
		_, result := v["result"]
		if rpc || method || id || typ || result {
			last.Sent = append(last.Sent, m)
		} else {
			last.Notes = append(last.Notes, m)
		}
	}
	return out
}

// sent is the messages a run was sent with this method.
func (r miniRun) sent(method string) []map[string]any {
	var out []map[string]any
	for _, m := range r.Sent {
		if m["method"] == method {
			out = append(out, m)
		}
	}
	return out
}

// settle waits for the thread to be idle (or in error) with nothing queued, and is its snapshot.
func settle(t *testing.T, sdk *agentthreads.AgentThreads, id string) protocol.Snapshot {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		s, err := sdk.Snapshot(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		queued := false
		for _, it := range s.Items {
			if m, ok := it.Value.(*protocol.UserMessage); ok && m.Queued {
				queued = true
			}
		}
		if st := s.Thread.Status; (st == protocol.ThreadStatusIdle || st == protocol.ThreadStatusError) && !queued {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("the thread didn't settle: %s", mustMarshal(s))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// texts is what the agent said, in order.
func texts(s protocol.Snapshot) []string {
	var out []string
	for _, it := range s.Items {
		if m, ok := it.Value.(*protocol.AssistantMessage); ok {
			out = append(out, m.Text)
		}
	}
	return out
}

func str(s string) *string { return &s }

// flagValues is the values flag is given in argv, in order.
func flagValues(argv []string, flag string) []string {
	var out []string
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag {
			out = append(out, argv[i+1])
		}
	}
	return out
}

// hasFlag says whether argv has flag followed by value.
func hasFlag(argv []string, flag, value string) bool {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag && argv[i+1] == value {
			return true
		}
	}
	return false
}

// last is argv's last n arguments.
func last(argv []string, n int) []string {
	if len(argv) < n {
		return argv
	}
	return argv[len(argv)-n:]
}

func same(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %s, want %s", what, mustMarshal(got), mustMarshal(want))
	}
}

// claudeEnv runs mini-claude as Claude Code, on a store.
type claudeEnv struct {
	t       *testing.T
	log     string
	store   agentthreads.Store
	spawner agentthreads.Spawner
	options agentthreads.ClaudeOptions
	rec     *recorder
}

func newClaudeEnv(t *testing.T, store agentthreads.Store, spawner agentthreads.Spawner, options agentthreads.ClaudeOptions, env map[string]string) *claudeEnv {
	needNode(t)
	log := filepath.Join(t.TempDir(), "log.jsonl")
	o := options
	o.Bin = mini("claude")
	o.Env = map[string]string{"MINI_CLAUDE_LOG": log, "MINI_CLAUDE_STEER": "now"}
	for k, v := range options.Env {
		o.Env[k] = v
	}
	for k, v := range env {
		o.Env[k] = v
	}
	if o.CloseGrace == 0 {
		o.CloseGrace = time.Second
	}
	return &claudeEnv{t: t, log: log, store: store, spawner: spawner, options: o, rec: &recorder{}}
}

func (e *claudeEnv) make() *agentthreads.AgentThreads {
	t := e.t
	sdk := agentthreads.New(agentthreads.Options{
		Store:        e.store,
		Harnesses:    map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(e.options)},
		Spawner:      e.spawner,
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	sdk.Subscribe(e.rec.add)
	return sdk
}

func (e *claudeEnv) runs() []miniRun { return miniRuns(e.t, e.log) }

// Launch options with the claude harness's own options, stored with the thread but not sent to
// clients, for every process it starts: after SetOptions changes them, and after a restart.
func TestClaudeStartsWithTheThreadsLaunchOptionsAndKeepsThemAcrossARestart(t *testing.T) {
	ctx := context.Background()
	store, err := agentthreads.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	env := newClaudeEnv(t, store, nil, agentthreads.ClaudeOptions{
		Args: []string{"--own"}, ConfigDir: "/instance-config", Env: map[string]string{"AT_GONE": "instance"},
	}, map[string]string{"MINI_LOG_ENV": "AT_SET,AT_GONE,AT_KEPT", "AT_KEPT": "kept"})
	sdk := env.make()
	first := agentthreads.LaunchOptions{
		Args:      []string{"--allowedTools", "Read Edit", "--settings", `{"a":1}`},
		Env:       map[string]*string{"AT_SET": str("a b"), "AT_GONE": nil},
		AddDirs:   []string{"/one", "/two"},
		ConfigDir: "/profile-a",
	}
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir(), Launch: first})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply one", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	settle(t, sdk, th.ID)
	run := env.runs()[0]
	same(t, "--add-dir", flagValues(run.Argv, "--add-dir"), []string{"/one", "/two"})
	// After the driver's arguments and the harness options'.
	same(t, "the last arguments", last(run.Argv, 5), []string{"--own", "--allowedTools", "Read Edit", "--settings", `{"a":1}`})
	same(t, "CLAUDE_CONFIG_DIR", run.ConfigDir, "/profile-a")
	same(t, "env", run.Env, map[string]*string{"AT_SET": str("a b"), "AT_GONE": nil, "AT_KEPT": str("kept")})
	// Stored with the thread, and never sent to clients.
	stored, err := store.GetThread(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	var launch struct {
		Env map[string]*string `json:"env"`
	}
	json.Unmarshal(stored.Extra["launch"], &launch)
	same(t, "the stored launch's env", launch.Env, map[string]*string{"AT_SET": str("a b"), "AT_GONE": nil})
	for _, e := range env.rec.all() {
		if strings.Contains(string(mustMarshal(e)), "profile-a") {
			t.Fatalf("an event has the launch options: %s", mustMarshal(e))
		}
	}
	snap, _ := sdk.Snapshot(ctx, th.ID)
	if _, ok := snap.Thread.Extra["launch"]; ok {
		t.Fatal("the snapshot's thread has the launch options")
	}

	// Changed: the next turn's process has the new ones.
	second := agentthreads.LaunchOptions{
		Args:      []string{"--disallowedTools", "Bash"},
		Env:       map[string]*string{"AT_SET": str("b")},
		AddDirs:   []string{"/three"},
		ConfigDir: "/profile-b",
	}
	if err := sdk.SetOptions(ctx, th.ID, agentthreads.ThreadOptions{Launch: &second}); err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply two", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	s := settle(t, sdk, th.ID)
	runs := env.runs()
	if len(runs) != 2 {
		t.Fatalf("%d runs", len(runs))
	}
	same(t, "--add-dir", flagValues(runs[1].Argv, "--add-dir"), []string{"/three"})
	same(t, "the last arguments", last(runs[1].Argv, 2), []string{"--disallowedTools", "Bash"})
	if slices.Contains(runs[1].Argv, "--allowedTools") {
		t.Fatalf("the old arguments are still there: %q", runs[1].Argv)
	}
	same(t, "CLAUDE_CONFIG_DIR", runs[1].ConfigDir, "/profile-b")
	same(t, "env", runs[1].Env, map[string]*string{"AT_SET": str("b"), "AT_GONE": str("instance"), "AT_KEPT": str("kept")})
	// Neither Get nor List has them.
	got, _ := sdk.Get(ctx, th.ID)
	listed, _ := sdk.List(ctx)
	if _, ok := got.Extra["launch"]; ok || len(listed) != 1 || listed[0].Extra["launch"] != nil {
		t.Fatal("Get or List has the launch options")
	}

	// A new backend on the same store resumes the thread with them.
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := sdk.Get(ctx, th.ID); got == nil || got.Extra["launch"] != nil {
		t.Fatal("Get has the launch options from the store")
	}
	if listed, _ := sdk.List(ctx); len(listed) != 1 || listed[0].Extra["launch"] != nil {
		t.Fatal("List has the launch options from the store")
	}
	again := env.make()
	defer again.Close(ctx)
	if err := again.Send(ctx, th.ID, "reply three", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	after := settle(t, again, th.ID)
	runs = env.runs()
	if len(runs) != 3 {
		t.Fatalf("%d runs", len(runs))
	}
	if !hasFlag(runs[2].Argv, "--resume", s.Thread.SessionID) {
		t.Fatalf("not resumed: %q", runs[2].Argv)
	}
	same(t, "--add-dir", flagValues(runs[2].Argv, "--add-dir"), []string{"/three"})
	same(t, "the last arguments", last(runs[2].Argv, 2), []string{"--disallowedTools", "Bash"})
	same(t, "CLAUDE_CONFIG_DIR", runs[2].ConfigDir, "/profile-b")
	same(t, "AT_SET", runs[2].Env["AT_SET"], str("b"))
	if _, ok := after.Thread.Extra["launch"]; ok {
		t.Fatal("the loaded thread's snapshot has the launch options")
	}
	// Saved again (with the run that ended) with them.
	stored, _ = store.GetThread(ctx, th.ID)
	var kept agentthreads.LaunchOptions
	json.Unmarshal(stored.Extra["launch"], &kept)
	same(t, "the stored launch", kept, second)
}

// Under the shim, the process is started with the thread's launch options too.
func TestClaudeStartsUnderTheShimWithTheThreadsLaunchOptions(t *testing.T) {
	ctx := context.Background()
	spawner := agentthreads.Shim(shimPath(t), agentthreads.ShimOptions{RunsDir: t.TempDir()})
	env := newClaudeEnv(t, agentthreads.NewMemoryStore(), spawner, agentthreads.ClaudeOptions{}, map[string]string{"MINI_LOG_ENV": "AT_SET"})
	sdk := env.make()
	defer sdk.Stop(ctx)
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: t.TempDir(), Launch: agentthreads.LaunchOptions{
		Args: []string{"--settings", "{}"}, Env: map[string]*string{"AT_SET": str("x y")}, AddDirs: []string{"/one"}, ConfigDir: "/profile",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply one", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	same(t, "texts", texts(settle(t, sdk, th.ID)), []string{"one"})
	run := env.runs()[0]
	same(t, "--add-dir", flagValues(run.Argv, "--add-dir"), []string{"/one"})
	same(t, "the last arguments", last(run.Argv, 2), []string{"--settings", "{}"})
	same(t, "CLAUDE_CONFIG_DIR", run.ConfigDir, "/profile")
	same(t, "env", run.Env, map[string]*string{"AT_SET": str("x y")})
}

// A thread's launch options: its own CODEX_HOME (used as it is), arguments after the options',
// environment, and writable roots; stored with the thread, and changed by SetOptions.
func TestCodexStartsWithTheThreadsLaunchOptions(t *testing.T) {
	needNode(t)
	ctx := context.Background()
	log := filepath.Join(t.TempDir(), "log.jsonl")
	// A login that isn't linked into the thread's own home.
	login := t.TempDir()
	os.WriteFile(filepath.Join(login, "auth.json"), []byte("{}"), 0o600)
	store := agentthreads.NewMemoryStore()
	sdk := agentthreads.New(agentthreads.Options{
		Store: store,
		Harnesses: map[string]agentthreads.Harness{"codex": agentthreads.Codex(agentthreads.CodexOptions{
			Bin: mini("codex"), Args: []string{"--own"}, Home: t.TempDir(), Login: login, CloseGrace: time.Second,
			Config: map[string]any{"sandbox_workspace_write.writable_roots": []string{"/base"}},
			// A home of its own, so the user's own skills don't show up.
			Env: map[string]string{"MINI_CODEX_LOG": log, "HOME": t.TempDir(), "MINI_LOG_ENV": "AT_SET,AT_GONE", "AT_GONE": "instance"},
		})},
		Capabilities: agentthreads.Capabilities{Permissions: agentthreads.Allow},
		OnError:      func(err error) { t.Errorf("OnError: %v", err) },
	})
	defer sdk.Close(ctx)
	home, cwd := t.TempDir(), t.TempDir()
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Harness: "codex", Cwd: cwd, Launch: agentthreads.LaunchOptions{
		Args:      []string{"-c", "a=1"},
		Env:       map[string]*string{"AT_SET": str("x y"), "AT_GONE": nil},
		AddDirs:   []string{"sub", "/abs"},
		ConfigDir: home,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply one", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	same(t, "texts", texts(settle(t, sdk, th.ID)), []string{"one"})
	runs := miniRuns(t, log)
	same(t, "argv", runs[0].Argv, []string{"app-server", "--own", "-c", "a=1"})
	same(t, "CODEX_HOME", runs[0].ConfigDir, home)
	same(t, "env", runs[0].Env, map[string]*string{"AT_SET": str("x y"), "AT_GONE": nil})
	roots := func(r miniRun, method string) any {
		sent := r.sent(method)
		if len(sent) != 1 {
			t.Fatalf("%d %s", len(sent), method)
		}
		return sent[0]["params"].(map[string]any)["config"].(map[string]any)["sandbox_workspace_write.writable_roots"]
	}
	same(t, "writable roots", roots(runs[0], "thread/start"), []any{"/base", filepath.Join(cwd, "sub"), "/abs"})
	// Its own home, not the app's: no login was linked into it.
	if _, err := os.Lstat(filepath.Join(home, "auth.json")); err == nil {
		t.Fatal("a login was linked into the thread's own home")
	}
	stored, _ := store.GetThread(ctx, th.ID)
	var launch struct {
		Args []string `json:"args"`
	}
	json.Unmarshal(stored.Extra["launch"], &launch)
	same(t, "the stored launch's args", launch.Args, []string{"-c", "a=1"})
	snap, _ := sdk.Snapshot(ctx, th.ID)
	if _, ok := snap.Thread.Extra["launch"]; ok {
		t.Fatal("the snapshot's thread has the launch options")
	}

	// New arguments: the next turn resumes the thread in a new process that has them.
	if err := sdk.SetOptions(ctx, th.ID, agentthreads.ThreadOptions{Launch: &agentthreads.LaunchOptions{
		Args: []string{"-c", "a=2"}, ConfigDir: home,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply two", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	same(t, "texts", texts(settle(t, sdk, th.ID)), []string{"one", "two"})
	runs = miniRuns(t, log)
	if len(runs) != 2 {
		t.Fatalf("%d runs", len(runs))
	}
	same(t, "argv", runs[1].Argv, []string{"app-server", "--own", "-c", "a=2"})
	same(t, "env", runs[1].Env, map[string]*string{"AT_SET": nil, "AT_GONE": str("instance")})
	same(t, "writable roots", roots(runs[1], "thread/resume"), []any{"/base"})
}

// followed collects a process's lines and exit, in order.
type followed struct {
	mu    sync.Mutex
	lines []string
	exit  *agentthreads.ExitStatus
	queue chan func()
}

func follow(t *testing.T) (*followed, func(func()), agentthreads.ProcessHandlers) {
	f := &followed{queue: make(chan func(), 1024)}
	go func() {
		for fn := range f.queue {
			fn()
		}
	}()
	t.Cleanup(func() { close(f.queue) })
	h := agentthreads.ProcessHandlers{
		Line:   func(l string) { f.mu.Lock(); f.lines = append(f.lines, l); f.mu.Unlock() },
		Stderr: func(l string) { t.Logf("stderr: %s", l) },
		Exit:   func(s agentthreads.ExitStatus) { f.mu.Lock(); f.exit = &s; f.mu.Unlock() },
	}
	return f, func(fn func()) { f.queue <- fn }, h
}

// wait waits for it to exit, and is its lines.
func (f *followed) wait(t *testing.T) []string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		exit, lines := f.exit, append([]string(nil), f.lines...)
		f.mu.Unlock()
		if exit != nil {
			if exit.Err != nil {
				t.Fatalf("it couldn't start: %v", exit.Err)
			}
			return lines
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("it didn't exit")
	return nil
}

// exactly is `sh -c show` with these arguments after it ($0 first), only this environment, in cwd.
func exactly(runID, cwd string, post func(func())) agentthreads.SpawnOptions {
	const show = `for a in "$0" "$@"; do echo "arg:$a"; done; echo "env:$AT_SET:${AT_EMPTY-unset}:${HOME-unset}"; pwd`
	return agentthreads.SpawnOptions{
		Command:  "sh",
		Args:     []string{"-c", show, "zero", "a b", "", "--add-dir", `--settings={"x": "$HOME"}`},
		Cwd:      cwd,
		Env:      []string{"PATH=" + os.Getenv("PATH"), "AT_SET=x y", "AT_EMPTY="},
		ThreadID: "th", RunID: runID, Post: post,
	}
}

func shown(t *testing.T, cwd string) []string {
	real, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		t.Fatal(err)
	}
	return []string{"arg:zero", "arg:a b", "arg:", "arg:--add-dir", `arg:--settings={"x": "$HOME"}`, "env:x y::unset", real}
}

func TestDirectStartsAProcessWithExactlyItsArgumentsEnvironmentAndWorkingDirectory(t *testing.T) {
	cwd := t.TempDir()
	f, post, h := follow(t)
	if _, err := agentthreads.Direct().Spawn(exactly("run", cwd, post), h); err != nil {
		t.Fatal(err)
	}
	same(t, "output", f.wait(t), shown(t, cwd))
}

func TestShimStartsARunWithExactlyItsArgumentsEnvironmentAndWorkingDirectory(t *testing.T) {
	spawner := agentthreads.Shim(shimPath(t), agentthreads.ShimOptions{RunsDir: t.TempDir()})
	cwd := t.TempDir()
	f, post, h := follow(t)
	if _, err := spawner.Spawn(exactly("run_exact", cwd, post), h); err != nil {
		t.Fatal(err)
	}
	same(t, "output", f.wait(t), shown(t, cwd))
}

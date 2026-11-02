// Command chat-go is the chat example's server in Go: agent-threads' Go backend, and the app's own
// transport, a WebSocket. The SDK has no network layer, so this file is the whole "seam": events
// out (sdk.Subscribe → every client), commands in (a client's command → sdk.HandleJSON), plus
// snapshots (or windows of them), ItemsBefore and EventsSince for clients that connect, scroll back
// or reconnect. It speaks examples/PROTOCOL.md, so chat-node's React frontend talks to it unchanged.
//
//	go run .               the server (see the README)
//	go run . supervise     the server, started again when it exits for a restart
//	go run . shipping-mcp  the example's stdio MCP server, which the harnesses start
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
	"github.com/dire-kiwi/agent-threads/go/sqlitestore"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "shipping-mcp":
			shippingMCP()
			return
		case "supervise":
			os.Exit(supervise())
		}
	}
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	app, err := newApp(cfg)
	if err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.port))
	if err != nil {
		log.Fatal(err)
	}
	var what []string
	for _, h := range cfg.harnesses {
		if h.Fake != "" {
			what = append(what, h.Name+" (fake)")
		} else {
			what = append(what, h.Name)
		}
	}
	shim := ""
	if cfg.shim != "" {
		shim = ", under the shim"
	}
	// Before it says it's listening, so a signal straight after that stops it as any other does.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		app.shutdown(0)
	}()
	// Unprefixed, so whatever starts it (chat-node's smoke tests) sees it's listening.
	fmt.Printf("chat-go on http://127.0.0.1:%d with %s%s; data in %s\n", cfg.port, strings.Join(what, ", "), shim, cfg.data)
	server := &http.Server{Handler: app, ReadHeaderTimeout: 30 * time.Second}
	app.server = server
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	// Serve returns as soon as shutdown begins: wait for it to finish.
	select {}
}

// app is the backend and the transport.
type app struct {
	cfg    config
	sdk    *agentthreads.AgentThreads
	store  *sqlitestore.Store
	server *http.Server
	// workspace is the agents' working directory.
	workspace string
	trusted   map[string]bool

	mu       sync.Mutex
	clients  map[*client]bool
	stopping sync.Once
}

func newApp(cfg config) (*app, error) {
	a := &app{cfg: cfg, workspace: filepath.Join(cfg.data, "workspace"), clients: map[*client]bool{}, trusted: map[string]bool{}}
	if err := os.MkdirAll(a.workspace, 0o755); err != nil {
		return nil, err
	}
	// Vite's dev server only in development: otherwise whatever else listens on its port isn't ours.
	ports := []int{cfg.port}
	if cfg.dev {
		ports = append(ports, devPort)
	}
	for _, name := range []string{"localhost", "127.0.0.1", "[::1]"} {
		for _, port := range ports {
			a.trusted[name+":"+strconv.Itoa(port)] = true
		}
	}
	store, err := sqlitestore.Open(filepath.Join(cfg.data, "threads.db"))
	if err != nil {
		return nil, err
	}
	a.store = store
	harnesses := map[string]agentthreads.Harness{}
	for _, h := range cfg.harnesses {
		harnesses[h.Name], err = a.harness(h)
		if err != nil {
			return nil, err
		}
	}
	var spawner agentthreads.Spawner = agentthreads.Direct()
	if cfg.shim != "" {
		spawner = agentthreads.Shim(cfg.shim, agentthreads.ShimOptions{RunsDir: filepath.Join(cfg.data, "runs")})
	}
	caps := agentthreads.Capabilities{
		Permissions:  permissions,
		SystemPrompt: "You're the support agent for Widget Co., a small online shop. Use the order-support skill for questions about orders.",
	}
	// The recorded sessions had no MCP server or skill, and the fake CLI checks that.
	if !cfg.fake || cfg.fakeTools {
		caps.Tools = []agentthreads.Tool{lookupOrder}
	}
	if !cfg.fake {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		caps.MCPServers = map[string]agentthreads.MCPServer{"shipping": {Command: exe, Args: []string{"shipping-mcp"}}}
		caps.Skills = []agentthreads.Skill{agentthreads.SkillDir(filepath.Join(root, "skills", "order-support"))}
	}
	a.sdk = agentthreads.New(agentthreads.Options{
		Store: store, Harnesses: harnesses, Spawner: spawner, Capabilities: caps,
		OnError: func(err error) { log.Printf("agent-threads: %v", err) },
	})
	// Events out: every thread's events (deltas included) to every client, as they happen.
	a.sdk.Subscribe(func(e protocol.ThreadEvent) {
		frame, err := json.Marshal(map[string]any{"type": "event", "event": e})
		if err != nil {
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		for c := range a.clients {
			c.send(frame)
		}
	})
	// Runs that outlived the last server (with the shim) carry on from where it left them.
	if cfg.shim != "" {
		r, err := a.sdk.Recover(context.Background())
		if err != nil {
			return nil, err
		}
		if len(r.Reattached)+len(r.Lost) > 0 {
			log.Printf("recovered: %d run(s) re-attached, %d lost", len(r.Reattached), len(r.Lost))
		}
	}
	return a, nil
}

func (a *app) harness(h harnessInfo) (agentthreads.Harness, error) {
	var bin string
	var binArgs []string
	var env map[string]string
	if h.Fake != "" {
		// The fake CLI, replaying a fixture's recorded session (and checking what the backend sends
		// it). Where it keeps which of the session's runs is next: afresh each time, or kept across
		// restarts in CHAT_FAKE_STATE, for a session that has several runs.
		state := filepath.Join(a.cfg.data, "fake-"+h.Name)
		if a.cfg.fakeState != "" {
			state = filepath.Join(a.cfg.fakeState, h.Name)
		} else {
			os.RemoveAll(state)
		}
		if err := os.MkdirAll(state, 0o755); err != nil {
			return nil, err
		}
		node, err := exec.LookPath("node")
		if err != nil {
			return nil, fmt.Errorf("the fake CLI needs node: %w", err)
		}
		bin, binArgs = node, []string{filepath.Join(repo, "spec", "tools", "fake-cli.mjs")}
		env = map[string]string{"AGENT_THREADS_FIXTURE": h.Fake, "AGENT_THREADS_FIXTURE_STATE": state}
	}
	if h.Name == "claude" {
		return agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: bin, BinArgs: binArgs, Env: env}), nil
	}
	// Codex keeps the app's sessions in a CODEX_HOME of the app's own (with the user's login linked in).
	return agentthreads.Codex(agentthreads.CodexOptions{Bin: bin, BinArgs: binArgs, Env: env, Home: filepath.Join(a.cfg.data, "codex-home")}), nil
}

// ---------- the transport ----------

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws" {
		a.websocket(w, r)
		return
	}
	a.static(w, r)
}

// trustedRequest says whether a WebSocket may connect. Listening on 127.0.0.1 isn't enough: any page
// the user has open can open a WebSocket to it, and the socket can read every thread, send the agent
// anything and allow its own permission requests. So it must come from this app's own page (its
// Origin is the host it connects to), on a loopback name (which a rebound DNS name isn't), at this
// server or Vite's dev server (whose proxy keeps the Host and Origin). Clients that aren't browsers
// send no Origin. This is the example's only check: a real app authenticates its users here too.
func (a *app) trustedRequest(r *http.Request) bool {
	if !a.trusted[r.Host] {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

// maxFrame is the largest frame a client may send (a message with attachments, say): a larger one
// closes its connection. It's chat-node's (its WebSocket library's default).
const maxFrame = 16 << 20

// client is a connected WebSocket.
type client struct {
	conn   *websocket.Conn
	frames chan []byte
	done   chan struct{}
	once   sync.Once
}

// send queues a frame for the client; a client that falls too far behind is dropped (it catches up
// with events_since when it reconnects).
func (c *client) send(frame []byte) {
	select {
	case c.frames <- frame:
	case <-c.done:
	default:
		c.close(websocket.StatusPolicyViolation, "too far behind")
	}
}

func (c *client) close(code websocket.StatusCode, reason string) {
	c.once.Do(func() {
		close(c.done)
		go c.conn.Close(code, reason)
	})
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// isRequest says whether a frame is a request: anything else is ignored (with no id, it can't be
// answered).
func isRequest(data []byte) (request, bool) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil || raw == nil {
		return request{}, false
	}
	var r request
	id, method := raw["id"], raw["method"]
	if len(id) == 0 || !(id[0] == '"' || id[0] == '-' || id[0] >= '0' && id[0] <= '9') {
		return r, false
	}
	if json.Unmarshal(method, &r.Method) != nil || len(method) == 0 || method[0] != '"' {
		return r, false
	}
	r.ID = id
	if p, ok := raw["params"]; ok && (len(p) == 0 || p[0] != '{' && p[0] != '[') {
		return r, false
	}
	r.Params = raw["params"]
	return r, true
}

func (a *app) websocket(w http.ResponseWriter, r *http.Request) {
	if !a.trustedRequest(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	// The Origin is checked above.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrame)
	c := &client{conn: conn, frames: make(chan []byte, 4096), done: make(chan struct{})}
	a.mu.Lock()
	a.clients[c] = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.clients, c)
		a.mu.Unlock()
		c.close(websocket.StatusNormalClosure, "")
	}()
	ctx := r.Context()
	go func() {
		for {
			select {
			case frame := <-c.frames:
				wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				err := conn.Write(wctx, websocket.MessageText, frame)
				cancel()
				if err != nil {
					c.close(websocket.StatusGoingAway, "")
					return
				}
			case <-c.done:
				return
			}
		}
	}()
	for {
		// A frame the library refuses (one over the limit, say) ends this connection only.
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		if !utf8.Valid(data) {
			c.close(websocket.StatusInvalidFramePayloadData, "not UTF-8")
			return
		}
		req, ok := isRequest(data)
		if !ok {
			continue
		}
		go a.answer(ctx, c, req)
	}
}

func (a *app) answer(ctx context.Context, c *client, req request) {
	reply := func(k string, v any) {
		frame, err := json.Marshal(map[string]any{"id": req.ID, k: v})
		if err == nil {
			c.send(frame)
		}
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("%s: %v", req.Method, r)
			reply("error", fmt.Sprint(r))
		}
	}()
	result, err := a.call(ctx, req.Method, req.Params)
	if err != nil {
		// A CommandError is the client's mistake (an unknown thread, a malformed command); anything
		// else is ours.
		var ce *agentthreads.CommandError
		if !errors.As(err, &ce) {
			log.Printf("%s: %v", req.Method, err)
		}
		reply("error", err.Error())
		return
	}
	reply("result", result)
}

// call is the app's methods: what a client asks for, and what the backend says (see
// examples/PROTOCOL.md).
func (a *app) call(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var p struct {
		Harness  string          `json:"harness"`
		Model    string          `json:"model"`
		Title    string          `json:"title"`
		ThreadID string          `json:"thread_id"`
		Seq      int64           `json:"seq"`
		Before   int64           `json:"before"`
		Limit    *int            `json:"limit"`
		Command  json.RawMessage `json:"command"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &p) != nil {
		return nil, &agentthreads.CommandError{Message: "the params aren't right"}
	}
	switch method {
	case "hello":
		// Offered only with the shim: without it, a restart loses the running turn.
		return map[string]any{"harnesses": a.cfg.harnesses, "restart": a.cfg.supervised && a.cfg.shim != ""}, nil
	case "list":
		threads, err := a.sdk.List(ctx)
		if err != nil {
			return nil, err
		}
		sort.SliceStable(threads, func(i, j int) bool { return threads[i].CreatedAt > threads[j].CreatedAt })
		return threads, nil
	case "create":
		for _, h := range a.cfg.harnesses {
			if h.Name != p.Harness {
				continue
			}
			model := p.Model
			if model == "" {
				model = h.Model
			}
			title := p.Title
			if len([]rune(title)) > 80 {
				title = string([]rune(title)[:80])
			}
			return a.sdk.Create(ctx, agentthreads.CreateOptions{Harness: h.Name, Model: model, Effort: h.Effort, Title: title, Cwd: a.workspace})
		}
		return nil, &agentthreads.CommandError{Message: fmt.Sprintf("there's no harness %q", p.Harness)}
	case "snapshot":
		// With a limit, a window of its latest items; the client loads earlier ones with items_before.
		if p.Limit != nil {
			return a.sdk.SnapshotWindow(ctx, p.ThreadID, max(0, *p.Limit))
		}
		return a.sdk.Snapshot(ctx, p.ThreadID)
	case "items_before":
		if p.Limit == nil {
			return nil, &agentthreads.CommandError{Message: "items_before needs a limit"}
		}
		return a.sdk.ItemsBefore(ctx, p.ThreadID, p.Before, *p.Limit)
	case "events_since":
		return a.sdk.EventsSince(ctx, p.ThreadID, p.Seq, 0)
	case "command":
		// Commands in: send, interrupt, respond, set_options, rewind, new_session and compact, checked
		// and carried out by the backend.
		if len(p.Command) == 0 {
			return nil, &agentthreads.CommandError{Message: "there's no command"}
		}
		return nil, a.sdk.HandleJSON(ctx, p.Command)
	case "restart":
		if !a.cfg.supervised || a.cfg.shim == "" {
			return nil, errors.New("this server can't restart: it isn't run by `chat-go supervise` with CHAT_SHIM")
		}
		time.AfterFunc(50*time.Millisecond, func() { a.shutdown(restartCode) })
		return nil, nil
	}
	return nil, &agentthreads.CommandError{Message: fmt.Sprintf("there's no method %q", method)}
}

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json",
}

// static serves the built frontend, with index.html for any path that isn't a file.
func (a *app) static(w http.ResponseWriter, r *http.Request) {
	// A path must decode, as UTF-8 too (as decodeURIComponent has it).
	path, err := url.PathUnescape(r.URL.EscapedPath())
	if err != nil || !utf8.ValidString(path) {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	webRoot := a.cfg.web
	file := filepath.Join(webRoot, filepath.FromSlash(filepath.Clean("/"+path)))
	isFile := func(f string) bool { st, err := os.Stat(f); return err == nil && st.Mode().IsRegular() }
	if !strings.HasPrefix(file, webRoot+string(filepath.Separator)) || !isFile(file) {
		file = filepath.Join(webRoot, "index.html")
	}
	if !isFile(file) {
		http.Error(w, "The frontend isn't built: run pnpm build in examples/chat-node (or use its pnpm dev).", http.StatusNotFound)
		return
	}
	if t, ok := contentTypes[filepath.Ext(file)]; ok {
		w.Header().Set("Content-Type", t)
	}
	// Vite's assets have their hash in their names; index.html must be fetched fresh.
	if strings.Contains(file, string(filepath.Separator)+"assets"+string(filepath.Separator)) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, file)
}

// ---------- shutting down ----------

func (a *app) shutdown(code int) {
	a.stopping.Do(func() {
		a.mu.Lock()
		for c := range a.clients {
			c.close(websocket.StatusServiceRestart, "restarting")
		}
		a.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if a.server != nil {
			a.server.Shutdown(ctx)
		}
		// Stops the harness processes, or with the shim leaves them running for the next server to
		// re-attach to.
		if err := a.sdk.Close(ctx); err != nil {
			log.Printf("close: %v", err)
		}
		a.store.Close() // The store is the app's to close.
		os.Exit(code)
	})
}

// supervise runs the server, and starts it again when it exits asking to (the frontend's Restart
// button, for the restart demo): with CHAT_SHIM set, its harness runs carry on meanwhile, and the new
// server re-attaches to them.
func supervise() int {
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	return superviseWith(func() *exec.Cmd {
		cmd := exec.Command(exe)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		cmd.Env = append(os.Environ(), "CHAT_SUPERVISED=1")
		return cmd
	}, signals)
}

// superviseWith runs the servers server makes, one after another while each exits asking for a
// restart, and returns the last one's exit code. A signal from signals is passed on to the server,
// which isn't started again: it returns once the server has exited, so it never leaves one behind.
func superviseWith(server func() *exec.Cmd, signals <-chan os.Signal) int {
	stopping := false
	for {
		cmd := server()
		if err := cmd.Start(); err != nil {
			log.Print(err)
			return 1
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		var err error
	wait:
		for {
			select {
			case err = <-done:
				break wait
			// Ctrl-C goes to the whole process group, so the server has it already: having it twice
			// is harmless.
			case sig := <-signals:
				stopping = true
				cmd.Process.Signal(sig)
			}
		}
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				log.Print(err)
				return 1
			}
			code = exit.ExitCode()
		}
		switch {
		case code < 0:
			return 1
		case code == restartCode && stopping:
			return 0
		case code != restartCode:
			return code
		}
		log.Print("restarting the server…")
	}
}

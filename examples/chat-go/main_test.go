package main

// The server end to end over its WebSocket, with Claude Code played by the fake CLI replaying the
// app-tool fixture (so no login is needed): what chat-node's frontend does, as examples/PROTOCOL.md
// has it. And the checks that keep other pages and bad input out.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func TestReadsOnly(t *testing.T) {
	// chat-node's server/policy.test.ts cases.
	for _, c := range []string{"cat a.txt", "cat 'a b.txt'", "cat '*.txt'", "ls -la", "head -n 5 notes.txt", "grep -rn widget .", "sed -n '1,240p' /tmp/x/SKILL.md", "sed -n 5p a b"} {
		if !readsOnly(c) {
			t.Errorf("readsOnly(%q) should be true", c)
		}
	}
	for _, c := range []string{
		"rm x", "touch a", "cat a > b", "cat a | sh", "ls; rm -rf /", "cat a && rm b", `cat "$(rm x)"`, "cat `rm x`",
		"cat $HOME/.ssh/id_rsa", "sed -i 's/a/b/' f", "sed -n '1,5p'", "sed -n 'w out' f",
		// GNU sed takes options after the script and files too.
		"sed -n 1p -i notes.txt", "sed -n '1,5p' --in-place=.bak f", "sed -n 1p -e 'w /tmp/x' f", "sed -n 1p f -i", "sed -n 1p -- -i",
		// Globs: with a file called -i there, `sed -n 1p *` is `sed -n 1p -i notes.txt`.
		"sed -n 1p *", "sed -n 1p notes.?", "sed -n 1p [-]i notes.txt", "cat *",
		// Quotes partway through a word, which the shell joins up.
		"sed -n 1p -'i' notes.txt", "sed -n 1p 'notes'.txt -'-in-place'", "'cat'chsegv touch x", "'cat",
		"", "rm -rf /", "cat $(echo a)", "echo hi > a", "sed -n 1p",
	} {
		if readsOnly(c) {
			t.Errorf("readsOnly(%q) should be false", c)
		}
	}
}

func TestIsRequest(t *testing.T) {
	for frame, want := range map[string]bool{
		`{"id":1,"method":"hello"}`: true, `{"id":"a","method":"list","params":{}}`: true,
		`null`: false, `[]`: false, `"hi"`: false, `{"method":"hello"}`: false, `{"id":1}`: false,
		`{"id":null,"method":"hello"}`: false, `{"id":1,"method":2}`: false, `{"id":1,"method":"x","params":3}`: false,
		`{"id":1,"method":"x","params":null}`: false,
	} {
		if _, got := isRequest([]byte(frame)); got != want {
			t.Errorf("isRequest(%s) = %v", frame, got)
		}
	}
}

func TestTrusted(t *testing.T) {
	a := &app{trusted: map[string]bool{"127.0.0.1:3001": true, "localhost:5173": true}}
	for _, c := range []struct {
		host, origin string
		want         bool
	}{
		{"127.0.0.1:3001", "", true},
		{"127.0.0.1:3001", "http://127.0.0.1:3001", true},
		{"localhost:5173", "http://localhost:5173", true},
		{"127.0.0.1:3001", "http://evil.example", false},
		{"127.0.0.1:3001", "http://localhost:3001", false},
		{"evil.example:3001", "", false},
		{"127.0.0.1:9999", "", false},
		{"localhost:3002", "", false},
	} {
		r, _ := http.NewRequest("GET", "http://"+c.host+"/ws", nil)
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := a.trustedRequest(r); got != c.want {
			t.Errorf("host %s, origin %q: %v", c.host, c.origin, got)
		}
	}
}

// server starts the app on a free port, replaying the fixture with the fake CLI.
func server(t *testing.T, fixture string) (*app, string) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("the fake CLI needs node")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	env := map[string]string{
		"PORT": fmt.Sprint(port), "CHAT_DATA": t.TempDir(), "CHAT_WEB": t.TempDir(),
		"CHAT_FAKE_CLAUDE": filepath.Join(repo, "spec", "fixtures", fixture),
	}
	cfg, err := loadConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(cfg.web, "index.html"), []byte("<!doctype html><title>chat</title>"), 0o644)
	a, err := newApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: a}
	go srv.Serve(ln)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
		a.sdk.Stop(ctx)
		a.store.Close()
	})
	return a, fmt.Sprintf("127.0.0.1:%d", port)
}

// wsClient is a connection to the server, and what it has been sent.
type wsClient struct {
	t       *testing.T
	conn    *websocket.Conn
	mu      sync.Mutex
	events  []protocol.ThreadEvent
	replies map[string]json.RawMessage
	next    int
	closed  chan struct{}
}

func dial(t *testing.T, host string) *wsClient {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws://"+host+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://" + host}}})
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(1 << 24)
	c := &wsClient{t: t, conn: conn, replies: map[string]json.RawMessage{}, closed: make(chan struct{})}
	go func() {
		defer close(c.closed)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var msg struct {
				ID    json.RawMessage       `json:"id"`
				Type  string                `json:"type"`
				Event *protocol.ThreadEvent `json:"event"`
			}
			json.Unmarshal(data, &msg)
			c.mu.Lock()
			if msg.Type == "event" && msg.Event != nil {
				c.events = append(c.events, *msg.Event)
			} else if msg.ID != nil {
				c.replies[string(msg.ID)] = data
			}
			c.mu.Unlock()
		}
	}()
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	return c
}

func (c *wsClient) call(method string, params any) (json.RawMessage, string) {
	c.t.Helper()
	c.mu.Lock()
	c.next++
	id := fmt.Sprint(c.next)
	c.mu.Unlock()
	req := map[string]any{"id": c.next, "method": method}
	if params != nil {
		req["params"] = params
	}
	frame, _ := json.Marshal(req)
	if err := c.conn.Write(context.Background(), websocket.MessageText, frame); err != nil {
		c.t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		data, ok := c.replies[id]
		c.mu.Unlock()
		if ok {
			var r struct {
				Result json.RawMessage `json:"result"`
				Error  string          `json:"error"`
			}
			json.Unmarshal(data, &r)
			return r.Result, r.Error
		}
		time.Sleep(5 * time.Millisecond)
	}
	c.t.Fatalf("no reply to %s", method)
	return nil, ""
}

func (c *wsClient) waitIdle(threadID string) {
	c.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		for _, e := range c.events {
			if u, ok := e.Value.(*protocol.ThreadUpdatedEvent); ok && u.ThreadID == threadID && u.Thread.Status == protocol.ThreadStatusIdle && u.Seq > 1 {
				c.mu.Unlock()
				return
			}
		}
		c.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	c.t.Fatal("the thread didn't go idle")
}

func TestChat(t *testing.T) {
	_, host := server(t, "claude/app-tool")
	c := dial(t, host)

	hello, errText := c.call("hello", nil)
	if errText != "" || !strings.Contains(string(hello), `"name":"claude"`) || !strings.Contains(string(hello), `"restart":false`) {
		t.Fatalf("hello: %s %s", hello, errText)
	}
	if _, errText := c.call("create", map[string]any{"harness": "grok"}); !strings.Contains(errText, "no harness") {
		t.Fatalf("create grok: %q", errText)
	}
	raw, errText := c.call("create", map[string]any{"harness": "claude", "title": "Where's order 42?"})
	var th protocol.Thread
	json.Unmarshal(raw, &th)
	if errText != "" || th.ID == "" || th.Model != "haiku" || th.Title != "Where's order 42?" {
		t.Fatalf("create: %s %s", raw, errText)
	}
	list, _ := c.call("list", nil)
	if !strings.Contains(string(list), th.ID) {
		t.Fatalf("list: %s", list)
	}
	// Frames that aren't requests are ignored, and the connection carries on.
	for _, junk := range []string{"null", "[]", `{"id":1}`, "not json"} {
		c.conn.Write(context.Background(), websocket.MessageText, []byte(junk))
	}
	if _, errText := c.call("command", map[string]any{"command": map[string]any{"type": "send", "thread_id": th.ID}}); !strings.Contains(errText, "valid command") {
		t.Fatalf("a bad command: %q", errText)
	}
	_, errText = c.call("command", map[string]any{"command": map[string]any{
		"type": "send", "thread_id": th.ID, "client_id": "c1",
		"text": "Look up order 42 with the lookup_order tool and tell me in one short sentence what's in it.",
	}})
	if errText != "" {
		t.Fatal(errText)
	}
	c.waitIdle(th.ID)

	raw, _ = c.call("snapshot", map[string]any{"thread_id": th.ID})
	var snap protocol.Snapshot
	json.Unmarshal(raw, &snap)
	var call *protocol.ToolCall
	for _, it := range snap.Items {
		if tc, ok := it.Value.(*protocol.ToolCall); ok && tc.Name == "lookup_order" {
			call = tc
		}
	}
	// The order card's structured output is in the call's result.
	if call == nil || call.Status != protocol.ToolStatusCompleted || call.Result == nil || !strings.Contains(string(call.Result.Structured), `"order_id":"42"`) {
		t.Fatalf("got %s", raw)
	}
	raw, _ = c.call("events_since", map[string]any{"thread_id": th.ID, "seq": snap.Seq - 2})
	var since []protocol.ThreadEvent
	if json.Unmarshal(raw, &since) != nil || len(since) != 2 {
		t.Fatalf("events_since: %s", raw)
	}
}

func TestTheServerRefusesOtherPagesAndBadInput(t *testing.T) {
	_, host := server(t, "claude/plain-reply")
	// Another page's WebSocket.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, "ws://"+host+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://evil.example"}}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("got %v %v", resp, err)
	}
	// Vite's port, outside development (CHAT_DEV isn't set).
	for _, h := range []string{"localhost:5173", "127.0.0.1:5173"} {
		conn, err := net.Dial("tcp", host)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", h)
		status := make([]byte, 12)
		io.ReadFull(conn, status)
		conn.Close()
		if !strings.HasPrefix(string(status), "HTTP/1.1 403") {
			t.Fatalf("Host %s: got %q", h, status)
		}
	}
	// Paths that don't decode.
	for _, path := range []string{"/%E0%A4%A", "/%zz", "/%E0"} {
		conn, err := net.Dial("tcp", host)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", path, host)
		status := make([]byte, 12)
		io.ReadFull(conn, status)
		conn.Close()
		if !strings.HasPrefix(string(status), "HTTP/1.1 400") {
			t.Fatalf("%s: got %q", path, status)
		}
	}
	r, err := http.Get("http://" + host + "/anything")
	if err != nil || r.StatusCode != http.StatusOK {
		t.Fatalf("got %v %v", r, err)
	}
	// A frame that isn't UTF-8 closes that connection only.
	bad := dial(t, host)
	bad.conn.Write(context.Background(), websocket.MessageText, []byte{0xff, 0xfe})
	select {
	case <-bad.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the connection stayed open")
	}
	big := dial(t, host)
	big.conn.Write(context.Background(), websocket.MessageText, []byte(strings.Repeat("x", 17<<20)))
	select {
	case <-big.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the connection stayed open after a frame over the limit")
	}
	good := dial(t, host)
	if _, errText := good.call("hello", nil); errText != "" {
		t.Fatal(errText)
	}
}

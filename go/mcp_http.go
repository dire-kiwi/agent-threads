package agentthreads

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// A loopback MCP server for the app's tools, over streamable HTTP: for a harness that can't take
// them any other way (Codex without dynamic tools). It listens on 127.0.0.1 on a random port and
// takes only requests with its bearer token. It answers each POST with JSON (no SSE streams), which
// streamable HTTP allows.

// toolServerHandlers are what the server asks of its owner, from its own goroutines.
type toolServerHandlers struct {
	// tools is the tools to list.
	tools func(ctx context.Context) []Tool
	// call runs one.
	call func(ctx context.Context, name string, args json.RawMessage) ToolOutput
}

type loopbackMCP struct {
	url    string
	port   int
	token  string
	server *http.Server
}

const maxMCPBody = 16 << 20

// serveTools starts a loopback MCP server for the tools: on a new port with a new token, or on
// those given (for a process configured with them that outlived the backend).
func serveTools(name string, h toolServerHandlers, port int, token string) (*loopbackMCP, error) {
	if token == "" {
		b := make([]byte, 24)
		rand.Read(b)
		token = base64.RawURLEncoding.EncodeToString(b)
	}
	expected := []byte("Bearer " + token)
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	answer := func(ctx context.Context, msg jmap) any {
		id := msg.raw("id")
		if msg == nil || msg.str("jsonrpc") != "2.0" || !isStr(msg.raw("method")) {
			if id != nil {
				return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32600, "message": "invalid request"}}
			}
			return nil
		}
		if id == nil {
			return nil // a notification
		}
		reply := func(k string, v any) any { return map[string]any{"jsonrpc": "2.0", "id": id, k: v} }
		params := msg.obj("params")
		switch msg.str("method") {
		case "initialize":
			version := params.str("protocolVersion")
			if version == "" {
				version = "2025-06-18"
			}
			return reply("result", map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": name, "version": "1.0.0"}})
		case "ping":
			return reply("result", map[string]any{})
		case "tools/list":
			return reply("result", map[string]any{"tools": toolList(h.tools(ctx))})
		case "tools/call":
			out := h.call(ctx, params.str("name"), orEmpty(params.raw("arguments")))
			return reply("result", mcpResult(out))
		}
		return reply("error", map[string]any{"code": -32601, "message": fmt.Sprintf("method %s isn't supported", msg.str("method"))})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), expected) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodDelete:
			w.WriteHeader(http.StatusOK)
			return
		case http.MethodPost:
		default:
			w.Header().Set("Allow", "POST, DELETE")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxMCPBody+1))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(body) > maxMCPBody {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		var batch []json.RawMessage
		isBatch := json.Unmarshal(body, &batch) == nil
		if !isBatch {
			var one json.RawMessage
			if json.Unmarshal(body, &one) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "parse error"}})
				return
			}
			batch = []json.RawMessage{one}
		}
		var replies []any
		for _, m := range batch {
			if out := answer(r.Context(), parseObj(m)); out != nil {
				replies = append(replies, out)
			}
		}
		if len(replies) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if isBatch {
			writeJSON(w, http.StatusOK, replies)
		} else {
			writeJSON(w, http.StatusOK, replies[0])
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 30 * time.Second}
	go server.Serve(ln)
	actual := ln.Addr().(*net.TCPAddr).Port
	return &loopbackMCP{url: fmt.Sprintf("http://127.0.0.1:%d/mcp", actual), port: actual, token: token, server: server}, nil
}

func (m *loopbackMCP) close() {
	if m != nil {
		m.server.Close()
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data := mustJSON(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	w.Write(data)
}

package main

// The external MCP server: a stand-in for a courier's tracking service, as a stdio MCP server with
// one tool, track_parcel. The harness (Claude Code or Codex) starts it (as `chat-go shipping-mcp`),
// not the backend, and its calls go through the app's permission policy like any other tool's.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

var parcels = map[string]struct {
	tracking string
	events   []string
}{
	"42":   {"NZP-4410-2291", []string{"2026-10-30 09:12 Picked up in Auckland", "2026-10-31 06:40 At the Christchurch depot", "2026-11-01 08:05 Out for delivery"}},
	"1001": {"NZP-3982-0017", []string{"2026-10-21 10:30 Picked up in Auckland", "2026-10-22 14:02 Delivered, left at the front door"}},
}

func shippingMCP() {
	out := json.NewEncoder(os.Stdout)
	send := func(msg map[string]any) {
		msg["jsonrpc"] = "2.0"
		out.Encode(msg)
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(nil, 1<<24)
	for in.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
				Arguments       struct {
					OrderID string `json:"order_id"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(in.Bytes(), &msg) != nil || len(msg.ID) == 0 {
			continue // not JSON, or a notification
		}
		switch msg.Method {
		case "initialize":
			version := msg.Params.ProtocolVersion
			if version == "" {
				version = "2025-06-18"
			}
			send(map[string]any{"id": msg.ID, "result": map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "shipping", "version": "1.0.0"}}})
		case "tools/list":
			send(map[string]any{"id": msg.ID, "result": map[string]any{"tools": []any{map[string]any{
				"name":        "track_parcel",
				"description": "Tracks the parcel an order was shipped in: its tracking number and where it has been.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"order_id": map[string]any{"type": "string"}}, "required": []string{"order_id"}},
			}}}})
		case "tools/call":
			id := strings.TrimPrefix(msg.Params.Arguments.OrderID, "#")
			result := map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("No parcel has been shipped for order %s.", id)}}, "isError": true}
			if p, ok := parcels[id]; ok {
				result = map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("Parcel %s for order %s:\n%s", p.tracking, id, strings.Join(p.events, "\n"))}}}
			}
			send(map[string]any{"id": msg.ID, "result": result})
		case "ping":
			send(map[string]any{"id": msg.ID, "result": map[string]any{}})
		default:
			send(map[string]any{"id": msg.ID, "error": map[string]any{"code": -32601, "message": "no method " + msg.Method}})
		}
	}
}

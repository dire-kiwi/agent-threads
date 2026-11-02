package agentthreads

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// Codex's items, plans, questions and usage in the protocol's terms (spec/fixtures/README.md,
// "Codex").

// isToolItem says whether a Codex item is a tool call.
func isToolItem(typ string) bool {
	switch typ {
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView":
		return true
	}
	return false
}

var wrapped = regexp.MustCompile(`(?s)^(?:\S*/)?(?:bash|zsh|sh) -lc (?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$`)
var escaped = regexp.MustCompile(`\\(.)`)

// unwrapCommand takes off the login shell Codex wraps commands in: `/usr/bin/bash -lc 'cmd'` is cmd.
func unwrapCommand(command string) string {
	m := wrapped.FindStringSubmatchIndex(command)
	if m == nil {
		return command
	}
	if m[2] >= 0 {
		return strings.ReplaceAll(command[m[2]:m[3]], `'\''`, "'")
	}
	return escaped.ReplaceAllString(command[m[4]:m[5]], "$1")
}

// codexTool is a tool item's tool_call (all but its id, status and the item's own fields). With
// mcpApp, the app's tools are on the app MCP server.
func codexTool(item jmap, mcpApp bool) *protocol.ToolCall {
	switch item.str("type") {
	case "commandExecution":
		input := rawObject("command", item.raw("command"), "cwd", item.raw("cwd"))
		return &protocol.ToolCall{Name: "commandExecution", Kind: protocol.ToolKindShell, Input: input, Command: unwrapCommand(item.str("command"))}
	case "fileChange":
		return &protocol.ToolCall{Name: "fileChange", Kind: protocol.ToolKindEdit, Input: rawObject("changes", item.raw("changes")), Changes: fileChanges(item.arr("changes"))}
	case "mcpToolCall":
		if mcpApp && item.str("server") == appServer {
			return &protocol.ToolCall{Name: item.str("tool"), Kind: protocol.ToolKindApp, Input: orEmpty(item.raw("arguments"))}
		}
		return &protocol.ToolCall{Name: item.str("tool"), Kind: protocol.ToolKindMCP, Input: orEmpty(item.raw("arguments")), Server: item.str("server")}
	case "dynamicToolCall":
		return &protocol.ToolCall{Name: item.str("tool"), Kind: protocol.ToolKindApp, Input: orEmpty(item.raw("arguments"))}
	case "webSearch":
		t := &protocol.ToolCall{Name: "webSearch", Kind: protocol.ToolKindWeb, Input: rawObject("query", item.raw("query"), "action", item.raw("action"))}
		t.Query, t.URL = webFields(item)
		return t
	case "imageView":
		return &protocol.ToolCall{Name: "imageView", Kind: protocol.ToolKindRead, Input: rawObject("path", item.raw("path")), Path: item.str("path")}
	}
	return &protocol.ToolCall{Name: item.str("type"), Kind: protocol.ToolKindOther, Input: json.RawMessage("{}")}
}

func webFields(item jmap) (query, url string) {
	action := item.obj("action")
	query = item.str("query")
	if query == "" {
		query = action.str("query")
	}
	return query, action.str("url")
}

func fileChanges(changes []json.RawMessage) []protocol.FileChange {
	out := []protocol.FileChange{}
	for _, raw := range changes {
		c := parseObj(raw)
		kind := c.obj("kind")
		f := protocol.FileChange{Path: c.str("path"), Op: protocol.FileChangeOpUpdate}
		switch kind.str("type") {
		case "add":
			f.Op = protocol.FileChangeOpAdd
		case "delete":
			f.Op = protocol.FileChangeOpDelete
		}
		f.Diff = c.str("diff")
		f.MoveTo = kind.str("move_path")
		out = append(out, f)
	}
	return out
}

var codexStatuses = map[string]protocol.ToolStatus{"completed": protocol.ToolStatusCompleted, "failed": protocol.ToolStatusFailed, "declined": protocol.ToolStatusDenied, "inProgress": protocol.ToolStatusRunning}

// codexDone is what a tool item's completion changes in its call (denied: the call was denied, and
// stays so).
func codexDone(item jmap, denied bool) Patch {
	status, ok := codexStatuses[item.str("status")]
	if !ok {
		status = protocol.ToolStatusCompleted
	}
	if denied {
		status = protocol.ToolStatusDenied
	}
	patch := Patch{"status": status}
	switch item.str("type") {
	case "commandExecution":
		// A command with no output has none (null), but still an exit code.
		out := item.raw("aggregatedOutput")
		code, hasCode := item.int("exitCode")
		if isStr(out) || hasCode {
			r := slim(item.str("aggregatedOutput"))
			if hasCode {
				r.ExitCode = &code
			}
			patch["result"] = r
		}
	case "fileChange":
		patch["changes"] = fileChanges(item.arr("changes"))
	case "mcpToolCall":
		if res := item.obj("result"); res != nil {
			r := slim(resultText(res.raw("content")))
			if sc := res.raw("structuredContent"); sc != nil {
				r.Structured = sc
			}
			patch["result"] = r
		} else if e := item.raw("error"); e != nil {
			msg := parseObj(e).str("message")
			if msg == "" {
				msg = string(e)
			}
			patch["result"] = protocol.ToolResult{Content: msg}
		}
	case "dynamicToolCall":
		var texts []string
		for _, raw := range item.arr("contentItems") {
			c := parseObj(raw)
			if c.str("type") == "inputText" {
				texts = append(texts, c.str("text"))
			}
		}
		patch["result"] = slim(strings.Join(texts, "\n"))
	case "webSearch":
		q, u := webFields(item)
		if q != "" {
			patch["query"] = q
		}
		if u != "" {
			patch["url"] = u
		}
	}
	return patch
}

// codexTotals is Codex's token totals for a thread.
type codexTotals struct {
	InputTokens           int64  `json:"inputTokens"`
	CachedInputTokens     int64  `json:"cachedInputTokens"`
	OutputTokens          int64  `json:"outputTokens"`
	CacheWriteInputTokens *int64 `json:"cacheWriteInputTokens,omitempty"`
}

// codexUsage is what a turn used. Codex reports the thread's running totals (again after a
// resume), so it's how far they are past the thread's usage before the turn. Its input tokens
// include the cached ones, which (as Claude's do) input_tokens leaves out.
func codexUsage(total codexTotals, before *protocol.Usage) *protocol.Usage {
	b := protocol.Usage{}
	if before != nil {
		b = *before
	}
	cached := total.CachedInputTokens - deref(b.CacheReadTokens)
	input := total.InputTokens - b.InputTokens - deref(b.CacheReadTokens)
	pos := func(n int64) int64 { return max(0, n) }
	read := pos(cached)
	write := pos(deref(total.CacheWriteInputTokens) - deref(b.CacheWriteTokens))
	return &protocol.Usage{InputTokens: pos(input - cached), OutputTokens: pos(total.OutputTokens - b.OutputTokens), CacheReadTokens: &read, CacheWriteTokens: &write}
}

// totalsAsUsage is Codex's totals as the usage they'd be if a turn had used them all.
func totalsAsUsage(t codexTotals) *protocol.Usage {
	read := t.CachedInputTokens
	write := deref(t.CacheWriteInputTokens)
	return &protocol.Usage{InputTokens: t.InputTokens - t.CachedInputTokens, CacheReadTokens: &read, OutputTokens: t.OutputTokens, CacheWriteTokens: &write}
}

// codexQuestions is requestUserInput's questions.
func codexQuestions(qs []json.RawMessage) []protocol.Question {
	out := []protocol.Question{}
	for _, raw := range qs {
		q := parseObj(raw)
		x := protocol.Question{ID: q.str("id"), Question: q.str("question"), Header: q.str("header"), AllowOther: q.bool("isOther"), Secret: q.bool("isSecret")}
		if opts := q.arr("options"); q.has("options") {
			x.Options = []protocol.QuestionOption{}
			for _, o := range opts {
				oo := parseObj(o)
				x.Options = append(x.Options, protocol.QuestionOption{Label: oo.str("label"), Description: oo.str("description")})
			}
		}
		out = append(out, x)
	}
	return out
}

func codexTodos(plan []json.RawMessage) []protocol.Todo {
	out := []protocol.Todo{}
	for _, raw := range plan {
		s := parseObj(raw)
		status := protocol.TodoStatusPending
		switch s.str("status") {
		case "inProgress":
			status = protocol.TodoStatusInProgress
		case "completed":
			status = protocol.TodoStatusCompleted
		}
		out = append(out, protocol.Todo{Text: s.str("step"), Status: status})
	}
	return out
}

// codexPolicy is how a permission mode runs under Codex: its approval policy and sandbox.
func codexPolicy(mode protocol.PermissionMode) (approval, sandbox string) {
	switch mode {
	case protocol.PermissionModeAcceptEdits:
		return "on-request", "workspace-write"
	case protocol.PermissionModePlan:
		return "untrusted", "read-only"
	case protocol.PermissionModeBypass:
		return "never", "danger-full-access"
	}
	return "untrusted", "workspace-write"
}

// sandboxPolicy is a sandbox mode as turn/start's sandboxPolicy has it.
func sandboxPolicy(mode string) map[string]any {
	switch mode {
	case "read-only":
		return map[string]any{"type": "readOnly"}
	case "danger-full-access":
		return map[string]any{"type": "dangerFullAccess"}
	}
	return map[string]any{"type": "workspaceWrite"}
}

// mcpServerConfig is an MCP server as Codex's mcp_servers config has it, or why it can't be.
func mcpServerConfig(s MCPServer) (map[string]any, string) {
	if s.URL != "" {
		if s.Type == "sse" {
			return nil, "Codex doesn't support SSE MCP servers"
		}
		c := map[string]any{"url": s.URL}
		if len(s.Headers) > 0 {
			c["http_headers"] = s.Headers
		}
		return c, ""
	}
	c := map[string]any{"command": s.Command}
	if s.Args != nil {
		c["args"] = s.Args
	}
	if s.Env != nil {
		c["env"] = s.Env
	}
	return c, ""
}

// rawObject is an object of the keys and values given in turn, leaving out values that are nil (as
// JSON.stringify leaves out undefined).
func rawObject(kv ...any) json.RawMessage {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		v := kv[i+1]
		if r, ok := v.(json.RawMessage); ok && r == nil {
			continue
		}
		if v == nil {
			continue
		}
		m[kv[i].(string)] = v
	}
	return mustJSON(m)
}

// codexRateLimits is the limits an account/rateLimits/updated notification's snapshot reports: its
// primary and secondary windows, named by its limitId when that isn't Codex's own.
func codexRateLimits(rl jmap) []protocol.RateLimit {
	prefix := ""
	if id := rl.str("limitId"); id != "" && id != "codex" {
		prefix = id + ":"
	}
	// Credits carry on past a used-up window.
	credits := rl.obj("credits")
	carryOn := credits != nil && (credits.bool("hasCredits") || credits.bool("unlimited"))
	var out []protocol.RateLimit
	for _, key := range []string{"primary", "secondary"} {
		w := rl.obj(key)
		if w == nil {
			continue
		}
		limit := protocol.RateLimit{ID: prefix + key, Status: protocol.RateLimitStatusAllowed}
		if used, ok := w.num("usedPercent"); ok {
			limit.UsedPercent = &used
			if used >= 100 {
				limit.Status = protocol.RateLimitStatusRejected
				if carryOn {
					limit.Status = protocol.RateLimitStatusWarning
				}
			}
		}
		if t, ok := w.num("resetsAt"); ok {
			limit.ResetsAt = unixTime(t)
		}
		if m, ok := w.num("windowDurationMins"); ok && m >= 0 && m == math.Trunc(m) {
			n := int64(m)
			limit.WindowMinutes = &n
		}
		out = append(out, limit)
	}
	return out
}

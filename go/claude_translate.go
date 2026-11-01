package agentthreads

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// Claude Code's tools, results and usage in the protocol's terms (spec/fixtures/README.md,
// "Claude Code").

// appServer is the in-process MCP server that serves a thread's app tools.
const appServer = "app"

// maxResult is how long a tool result may be before it's cut short, as Huntaway does.
const maxResult = 30_000

var claudeKinds = map[string]protocol.ToolKind{
	"Bash": protocol.ToolKindShell, "BashOutput": protocol.ToolKindShell,
	"Read": protocol.ToolKindRead, "NotebookRead": protocol.ToolKindRead,
	"Edit": protocol.ToolKindEdit, "MultiEdit": protocol.ToolKindEdit, "Write": protocol.ToolKindEdit, "NotebookEdit": protocol.ToolKindEdit,
	"Glob": protocol.ToolKindSearch, "Grep": protocol.ToolKindSearch,
	"WebFetch": protocol.ToolKindWeb, "WebSearch": protocol.ToolKindWeb,
	"Task": protocol.ToolKindSubagent, "Agent": protocol.ToolKindSubagent,
	"TodoWrite": protocol.ToolKindTodo,
}

// claudeTool is a tool_call for a Claude tool_use (all but its id, status and the item's own fields).
func claudeTool(name string, input json.RawMessage) *protocol.ToolCall {
	t := &protocol.ToolCall{Name: name, Kind: protocol.ToolKindOther, Input: orEmpty(input)}
	if k, ok := claudeKinds[name]; ok {
		t.Kind = k
	}
	if strings.HasPrefix(name, "mcp__") {
		parts := strings.Split(name, "__")
		t.Kind = protocol.ToolKindMCP
		t.Name = strings.Join(parts[2:], "__")
		if len(parts) > 1 {
			if parts[1] == appServer {
				t.Kind = protocol.ToolKindApp
			} else if parts[1] != "" {
				t.Server = parts[1]
			}
		}
	}
	args := parseObj(input)
	switch t.Kind {
	case protocol.ToolKindShell:
		t.Command = args.str("command")
	case protocol.ToolKindRead:
		t.Path = args.str("file_path")
	case protocol.ToolKindSearch:
		t.Query, t.Path = args.str("pattern"), args.str("path")
	case protocol.ToolKindWeb:
		t.URL, t.Query = args.str("url"), args.str("query")
	case protocol.ToolKindEdit:
		if p := args.str("file_path"); p != "" {
			t.Changes = []protocol.FileChange{{Path: p, Op: protocol.FileChangeOpUpdate}}
		}
	case protocol.ToolKindSubagent:
		t.Title = args.str("description")
	case protocol.ToolKindTodo:
		if list := args.arr("todos"); list != nil {
			t.Todos = []protocol.Todo{}
			for _, raw := range list {
				x := parseObj(raw)
				status := protocol.TodoStatusPending
				switch s := x.str("status"); s {
				case "in_progress", "completed":
					status = protocol.TodoStatus(s)
				}
				text := x.str("content")
				if text == "" && x.has("content") {
					text = strings.Trim(string(x.raw("content")), `"`)
				}
				t.Todos = append(t.Todos, protocol.Todo{Text: text, Status: status})
			}
		}
	}
	return t
}

// toolTitle is a permission's title: what it's about, in a few words.
func toolTitle(t *protocol.ToolCall) string {
	switch {
	case t.Command != "":
		return t.Command
	case t.Path != "":
		return t.Path
	case len(t.Changes) > 0:
		paths := make([]string, len(t.Changes))
		for i, c := range t.Changes {
			paths[i] = c.Path
		}
		return strings.Join(paths, ", ")
	}
	return t.Name
}

// resultText is a tool result's content as text: text blocks joined by newlines, images as [image],
// tool references as their tool's name.
func resultText(content json.RawMessage) string {
	if isStr(content) {
		return rawStr(content)
	}
	var blocks []jmap
	if err := json.Unmarshal(content, &blocks); err != nil {
		return ""
	}
	var out []string
	for _, b := range blocks {
		switch b.str("type") {
		case "text":
			out = append(out, b.str("text"))
		case "image":
			out = append(out, "[image]")
		case "tool_reference":
			if b.has("tool_name") {
				out = append(out, b.str("tool_name"))
			}
		}
	}
	return strings.Join(out, "\n")
}

// slim is a result's content, cut short if it's long (counting as JavaScript does).
func slim(text string) protocol.ToolResult {
	if protocol.TextLen(text) <= maxResult {
		return protocol.ToolResult{Content: text}
	}
	return protocol.ToolResult{Content: cutText(text, maxResult), Truncated: true}
}

// cutText is text's first n UTF-16 code units.
func cutText(s string, n int64) string {
	count := int64(0)
	for i, r := range s {
		w := int64(1)
		if r >= 0x10000 {
			w = 2
		}
		if count+w > n {
			return s[:i]
		}
		count += w
	}
	return s
}

// hunks is a structuredPatch as a unified diff's hunks.
func hunks(patch []json.RawMessage) string {
	var b strings.Builder
	for _, raw := range patch {
		h := parseObj(raw)
		os, _ := h.int("oldStart")
		ol, _ := h.int("oldLines")
		ns, _ := h.int("newStart")
		nl, _ := h.int("newLines")
		var lines []string
		json.Unmarshal(h.raw("lines"), &lines)
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n%s\n", os, ol, ns, nl, strings.Join(lines, "\n"))
	}
	return b.String()
}

// editChange is an Edit or Write result's file change, from its tool_use_result.
func editChange(result jmap, path string) *protocol.FileChange {
	patch := result.arr("structuredPatch")
	if patch == nil && string(result.raw("structuredPatch")) != "[]" {
		return nil
	}
	if p := result.str("filePath"); p != "" {
		path = p
	}
	if path == "" {
		return nil
	}
	if result.str("type") == "create" {
		content := result.str("content")
		if !isStr(result.raw("content")) && result.has("content") {
			content = string(result.raw("content"))
		}
		return &protocol.FileChange{Path: path, Op: protocol.FileChangeOpAdd, Diff: content}
	}
	return &protocol.FileChange{Path: path, Op: protocol.FileChangeOpUpdate, Diff: hunks(patch)}
}

// claudeUsage is what a turn used: its result's model_usage_since_last_result, summed over the
// models. (Its usage is only the last model call's, and total_cost_usd is the session's so far.)
func claudeUsage(result jmap) *protocol.Usage {
	u := &protocol.Usage{}
	var read, write int64
	cost := 0.0
	models := result.obj("model_usage_since_last_result")
	names := make([]string, 0, len(models))
	for name := range models {
		names = append(names, name)
	}
	sortStrings(names)
	for _, name := range names {
		m := models.obj(name)
		n := func(k string) int64 { v, _ := m.int(k); return v }
		u.InputTokens += n("inputTokens")
		u.OutputTokens += n("outputTokens")
		read += n("cacheReadInputTokens")
		write += n("cacheCreationInputTokens")
		c, _ := m.num("costUSD")
		cost = math.Round((cost+c)*1e12) / 1e12
	}
	u.CacheReadTokens, u.CacheWriteTokens, u.CostUSD = &read, &write, &cost
	return u
}

// askQuestions is AskUserQuestion's questions; each one's id is its text, and "Other" is always
// offered.
func askQuestions(input json.RawMessage) []protocol.Question {
	var in struct {
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
			MultiSelect bool `json:"multiSelect"`
		} `json:"questions"`
	}
	json.Unmarshal(input, &in)
	out := []protocol.Question{}
	for _, q := range in.Questions {
		x := protocol.Question{ID: q.Question, Question: q.Question, Header: q.Header, MultiSelect: q.MultiSelect, AllowOther: true, Options: []protocol.QuestionOption{}}
		for _, o := range q.Options {
			x.Options = append(x.Options, protocol.QuestionOption{Label: o.Label, Description: o.Description})
		}
		out = append(out, x)
	}
	return out
}

// claudePermissionMode is the permission mode as Claude Code names it, or "" for the default.
func claudePermissionMode(mode protocol.PermissionMode) string {
	switch mode {
	case protocol.PermissionModeAcceptEdits:
		return "acceptEdits"
	case protocol.PermissionModePlan:
		return "plan"
	case protocol.PermissionModeBypass:
		return "bypassPermissions"
	}
	return ""
}

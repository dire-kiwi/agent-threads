package agentthreads

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// The app's permission policy: whether the agent may call a tool, decided in code or by asking the
// user (which opens a permission request).

// PermissionQuery is a tool call the agent wants to make.
type PermissionQuery struct {
	// Name is the tool's name (an MCP or app tool's own name, without Claude's mcp__server__ prefix).
	Name  string
	Kind  protocol.ToolKind
	Input json.RawMessage
	Title string
	// Server is the MCP server, for an mcp tool.
	Server string
	// Reason is why the harness is asking, when it says.
	Reason string
	// ToolCallID is the tool_call item it's for.
	ToolCallID string
	// ParentID is the subagent call it's from.
	ParentID string
}

// PermissionContext is the thread a query is from.
type PermissionContext struct {
	ThreadID string
	Thread   protocol.Thread
	Metadata map[string]json.RawMessage
}

// Decision is a policy's answer: Allow, Deny (or DenyWith, saying why: the agent is told) or Ask,
// which asks the user.
type Decision struct {
	kind    string
	message string
}

var (
	Allow = Decision{kind: "allow"}
	Deny  = Decision{kind: "deny"}
	Ask   = Decision{kind: "ask"}
)

// DenyWith denies, telling the agent why.
func DenyWith(message string) Decision { return Decision{kind: "deny", message: message} }

func (d Decision) IsAllow() bool { return d.kind == "allow" }
func (d Decision) IsAsk() bool   { return d.kind == "ask" || d.kind == "" }
func (d Decision) IsDeny() bool  { return d.kind == "deny" }

// Message is a deny's reason, if it has one.
func (d Decision) Message() string { return d.message }

func (d Decision) String() string {
	if d.message != "" {
		return d.kind + ": " + d.message
	}
	return d.kind
}

// Decide makes a Decision a PermissionPolicy that always gives it.
func (d Decision) Decide(context.Context, PermissionQuery, PermissionContext) Decision { return d }

// PermissionPolicy decides whether the agent may call a tool. It's called on the thread's
// goroutine, before the harness hears anything more about the thread, so it should be quick: to
// leave it to the user, return Ask.
type PermissionPolicy interface {
	Decide(ctx context.Context, query PermissionQuery, thread PermissionContext) Decision
}

// PolicyFunc is a PermissionPolicy that's a function.
type PolicyFunc func(ctx context.Context, query PermissionQuery, thread PermissionContext) Decision

func (f PolicyFunc) Decide(ctx context.Context, q PermissionQuery, t PermissionContext) Decision {
	return f(ctx, q, t)
}

// permissionKey says which tool a query is about, for a standing answer: its kind, its MCP server
// and its name, since two servers (or an app tool and a built-in) can have tools of the same name.
func permissionKey(kind protocol.ToolKind, server, name string) string {
	var s any
	if server != "" {
		s = server
	}
	data, _ := json.Marshal([]any{kind, s, name})
	return string(data)
}

// decide runs a policy; one that panics denies.
func decide(ctx context.Context, policy PermissionPolicy, q PermissionQuery, t PermissionContext) (d Decision) {
	defer func() {
		if r := recover(); r != nil {
			d = DenyWith(fmt.Sprintf("The permission policy failed: %v", r))
		}
	}()
	if policy == nil {
		return Ask
	}
	d = policy.Decide(ctx, q, t)
	if d.kind == "" {
		return Ask
	}
	return d
}

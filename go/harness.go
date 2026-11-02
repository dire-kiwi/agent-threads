package agentthreads

import (
	"context"
	"encoding/json"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// What a harness driver (Claude Code, Codex) and the core give each other. The core owns the
// thread: its events, turns, steering queue, requests and permission policy. A driver owns the
// harness process and translates between it and the core.
//
// Everything here runs on the thread's goroutine: the core calls a Session's methods there, a
// driver calls its ThreadContext's there, and a spawner calls a process's handlers there (through
// SpawnOptions.Post). A driver that does something elsewhere (waits on a tool, say) comes back with
// ThreadContext.Post.

// MCPServer is an external MCP server: a command to run (stdio), or a URL (streamable HTTP, or SSE).
type MCPServer struct {
	// Type is "stdio", "http" or "sse"; "stdio" with a Command, "http" with a URL, if it's left out.
	Type    string            `json:"type,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// Skill is a skill: a directory with a SKILL.md (and anything it refers to), or a SKILL.md's text.
type Skill struct {
	// Dir is the skill's directory.
	Dir string
	// Name and Content are a skill given as its SKILL.md's text.
	Name, Content string
}

// SkillDir is a skill in a directory.
func SkillDir(dir string) Skill { return Skill{Dir: dir} }

// ThreadConfig is what a thread runs with: the instance's settings with the thread's own on top.
type ThreadConfig struct {
	Tools        []Tool
	MCPServers   map[string]MCPServer
	Skills       []Skill
	SystemPrompt string
}

// Message is a message to give the harness: its user_message item's id, text and attachments.
type Message struct {
	ID          string
	Text        string
	Attachments []protocol.Attachment
}

// TurnEnd is how a turn ended, as the harness says.
type TurnEnd struct {
	OK         bool
	Error      string
	Usage      *protocol.Usage
	DurationMs *int64
}

// Patch is a change to an item's fields: each value replaces the field's (as JSON), and a nil one
// removes it.
type Patch map[string]any

// ThreadContext is the core's side, for one thread.
type ThreadContext interface {
	ThreadID() string
	Thread() protocol.Thread
	Config() ThreadConfig
	Spawner() Spawner
	// TurnID is the running turn's id, or "" if none is running.
	TurnID() string
	// Interrupted says whether the running turn was interrupted.
	Interrupted() bool
	// Queued is the steered messages the harness hasn't taken in yet, oldest first.
	Queued() []*protocol.UserMessage

	// Item is the item with the id, as saved (without text streamed since).
	Item(id string) (protocol.Item, bool)
	// AddItem adds an item, in the running turn.
	AddItem(item protocol.ItemValue)
	// UpdateItem changes an item's fields; it sends nothing if nothing changes.
	UpdateItem(id string, patch Patch)
	// Delta streams text onto the end of an assistant_message or reasoning item's text; it sends
	// nothing for "".
	Delta(itemID string, kind protocol.DeltaEventKind, text string)
	// SetThread changes the thread's fields (change gets a copy); it sends nothing if nothing changes.
	SetThread(change func(*protocol.Thread))
	// TookIn says the harness took in the queued message with this id, and whether it was queued.
	TookIn(id string) bool
	// ToolOutput says an app tool returned structured output for the tool call toolCallID: it goes
	// in the call's result.structured when the harness gives the call its result (harnesses pass on
	// only the text).
	ToolOutput(toolCallID string, structured any)

	// Decide is the permission policy's answer, after the thread's standing answers; what the policy
	// would ask the user about, the thread's permission mode may decide instead (bypass allows it,
	// dont_ask denies it).
	Decide(query PermissionQuery) Decision
	// Ask opens a request (for the tool call toolCallID, which is set pending) and calls answered
	// when the user responds. It isn't called when the request is cancelled because its turn ended.
	// standing (the tool's PermissionKey, or nil) lets an answer given "always" stand for the
	// thread. A request the thread's standing answers or permission mode answer isn't opened:
	// answered is called with their answer, as a task of its own.
	Ask(request protocol.ThreadRequestValue, toolCallID string, answered func(protocol.Resolution), standing *StandingKey) string
	// Reopen takes up a request opened before the backend restarted, which is still open: answered
	// is called when the user responds, as for Ask. It says whether it's open.
	Reopen(requestID string, answered func(protocol.Resolution), standing *StandingKey) bool
	// Persist saves the thread's run as it is now (with a spawner whose runs outlive the backend),
	// before the driver does something that mustn't be done twice: after a restart, it's
	// re-attached as of this. done is called (on the thread's goroutine) once it's saved, with the
	// store's error if it can't be.
	Persist(done func(error))
	// CancelRequest closes a request the harness no longer wants answered.
	CancelRequest(id string)
	// EndTurn says the running turn ended.
	EndTurn(end TurnEnd)
	// Error reports something that went wrong that isn't the turn's, to the app's OnError.
	Error(err error)
	// Post runs fn on the thread's goroutine, after what's running there now.
	Post(fn func())
}

// RunCheckpoint is what a driver needs saved to carry on with its run after the backend restarts.
type RunCheckpoint struct {
	// ID is the run's id.
	ID string
	// Offset is how far into its output the driver has read (Process.Offset).
	Offset int64
	// Dir is where its files are (the shim's run directory).
	Dir string
	// Input is how much of its input had been written (Process.InputOffset), if it's known.
	Input *int64
	// State is the driver's state for it, as JSON, which Reattach gets back.
	State any
	// Ended says it has exited, and the driver is done with it (its last checkpoint).
	Ended bool
}

// Session is a driver's side, for one thread.
type Session interface {
	// Start says a turn started with these messages (the core has added them).
	Start(messages []Message)
	// Steer is a message to steer the running turn with (the core has added it, queued).
	Steer(message Message)
	// CarryOver says the turn ended without taking in these queued messages, and the core has
	// started the next turn for them.
	CarryOver(messages []Message)
	// Interrupt stops the running turn.
	Interrupt()
	// Live says whether a harness process is running that has the queued messages (it was sent them).
	Live() bool
	// Release says the core gave up carrying the queued messages over: make sure nothing acts on
	// them (stop a process that has them). They're sent again with the next turn's Start.
	Release()
	// OptionsChanged says the thread's options (model, effort, permission mode) or config changed.
	OptionsChanged()
	// Close stops the harness process, if it's running, and calls done once it has.
	Close(done func())
}

// DurableSession is a Session that can carry on with a run after the backend restarts, with a
// spawner whose processes outlive the backend. A driver whose sessions aren't has its runs stopped
// when the backend restarts, and their turns end.
type DurableSession interface {
	Session
	// Checkpoint is the running process's checkpoint, which the core saves with the events made so
	// far; nil if there's none. It's called whenever events are saved, so it must be quick.
	Checkpoint() *RunCheckpoint
	// Reattach re-attaches to a run after a restart: its data's state is a Checkpoint of it, and the
	// core has restored the thread (its running turn, its open requests) as of the same moment. It
	// says whether it could; if not, the core stops the run.
	Reattach(run RunRecord) bool
	// Detach stops following the running process and leaves it running, as the backend shuts down,
	// to re-attach to it after. It says whether there was one to leave; nothing else is called after.
	Detach() bool
}

// Harness is a harness's driver: Claude Code (ClaudeCode) or Codex (Codex).
type Harness interface {
	Name() string
	Open(ctx ThreadContext) Session
}

// metadataOf is a thread's metadata, never nil.
func metadataOf(t protocol.Thread) map[string]json.RawMessage {
	if t.Metadata == nil {
		return map[string]json.RawMessage{}
	}
	return t.Metadata
}

// background is the context for what a thread does that no caller waits on.
var background = context.Background()

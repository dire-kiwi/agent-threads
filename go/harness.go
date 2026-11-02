package agentthreads

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

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

// LaunchOptions are how a thread's harness process is started, on top of the harness's own options:
// stored with the thread (but not sent to clients), so a run started after a restart has them too.
// A change applies from the next process the thread starts, as a model change does.
type LaunchOptions struct {
	// Args are more arguments, after the harness's (and its options' Args): for Claude Code, say,
	// --allowedTools, --disallowedTools or --settings; for Codex, -c key=value.
	Args []string `json:"args,omitempty"`
	// Env is changes to the environment, after the harness options' Env: a value sets a variable,
	// nil removes it.
	Env map[string]*string `json:"env,omitempty"`
	// AddDirs are more directories the agent may use besides the working directory: --add-dir for
	// Claude Code, writable roots (sandbox_workspace_write.writable_roots) for Codex.
	AddDirs []string `json:"add_dirs,omitempty"`
	// ConfigDir is the harness's config directory, in place of the harness options': CLAUDE_CONFIG_DIR
	// for Claude Code, CODEX_HOME for Codex (used as it is, with its own login and config). The
	// harness keeps its sessions there, so a thread that changes it can't resume what it had.
	ConfigDir string `json:"config_dir,omitempty"`
}

// IsEmpty says whether there are none.
func (l LaunchOptions) IsEmpty() bool {
	return len(l.Args) == 0 && len(l.Env) == 0 && len(l.AddDirs) == 0 && l.ConfigDir == ""
}

// applyEnv makes these changes to an environment (the backend's, with the harness options' changes).
func (l LaunchOptions) applyEnv(env []string) []string {
	if len(l.Env) == 0 {
		return env
	}
	set := map[string]string{}
	out := make([]string, 0, len(env)+len(l.Env))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := l.Env[k]; !ok {
			out = append(out, kv)
		}
	}
	for k, v := range l.Env {
		if v != nil {
			set[k] = *v
		}
	}
	for _, k := range sortedKeys(set) {
		out = append(out, k+"="+set[k])
	}
	return out
}

// launchField is the stored thread's field the launch options are kept in.
const launchField = "launch"

// withLaunch is the thread as the store keeps it: with its launch options, which clients aren't sent.
func withLaunch(t protocol.Thread, l LaunchOptions) protocol.Thread {
	extra := make(map[string]json.RawMessage, len(t.Extra)+1)
	for k, v := range t.Extra {
		if k != launchField {
			extra[k] = v
		}
	}
	if !l.IsEmpty() {
		data, err := json.Marshal(l)
		if err == nil {
			extra[launchField] = data
		}
	}
	if len(extra) == 0 {
		extra = nil
	}
	t.Extra = extra
	return t
}

// splitLaunch is a stored thread without its launch options (its launch field), and them (or none).
func splitLaunch(t protocol.Thread) (protocol.Thread, LaunchOptions) {
	var l LaunchOptions
	raw, ok := t.Extra[launchField]
	if !ok {
		return t, l
	}
	if json.Unmarshal(raw, &l) != nil {
		l = LaunchOptions{}
	}
	return withLaunch(t, LaunchOptions{}), l
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
	// SessionAt is the harness's own mark for the turn, in its session: Claude Code's last message in
	// it, Codex's id for the turn (the turn_result's session.at).
	SessionAt string
}

// Patch is a change to an item's fields: each value replaces the field's (as JSON), and a nil one
// removes it.
type Patch map[string]any

// ThreadContext is the core's side, for one thread.
type ThreadContext interface {
	ThreadID() string
	Thread() protocol.Thread
	Config() ThreadConfig
	// Launch is how the thread's harness process is started: its args, environment, directories and
	// config directory. Don't change what it returns.
	Launch() LaunchOptions
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
	// RateLimits says the harness reported usage limits: they replace the thread's rate_limits with
	// the same ids (with a thread.updated if that changes them).
	RateLimits(limits []protocol.RateLimit)
	// FromHarness handles a line the harness process runID wrote: it runs handle, which translates
	// it, with the events it makes taking it as their raw (with the Raw option), and then passes it
	// to the app's OnHarnessMessage.
	FromHarness(runID, line string, handle func())
	// TookIn says the harness took in the queued message with this id, and whether it was queued.
	TookIn(id string) bool
	// ToolOutput says an app tool returned structured output for the tool call toolCallID: it goes
	// in the call's result.structured when the harness gives the call its result (harnesses pass on
	// only the text).
	ToolOutput(toolCallID string, structured any)

	// Decide is the permission policy's answer (or the user's standing one).
	Decide(query PermissionQuery) Decision
	// Ask opens a request (for the tool call toolCallID, which is set pending) and calls answered
	// when the user responds. It isn't called when the request is cancelled because its turn ended.
	// standing (the tool's permission key) lets an answer given "always" stand for the thread.
	Ask(request protocol.ThreadRequestValue, toolCallID string, answered func(protocol.Resolution), standing string) string
	// Reopen takes up a request opened before the backend restarted, which is still open: answered
	// is called when the user responds, as for Ask. It says whether it's open.
	Reopen(requestID string, answered func(protocol.Resolution), standing string) bool
	// Persist saves the thread's run as it is now (with a spawner whose runs outlive the backend),
	// before the driver does something that mustn't be done twice: after a restart, it's
	// re-attached as of this. done is called (on the thread's goroutine) once it's saved, with the
	// store's error if it can't be.
	Persist(done func(error))
	// CancelRequest closes a request the harness no longer wants answered.
	CancelRequest(id string)
	// EndTurn says the running turn ended.
	EndTurn(end TurnEnd)
	// BeginTurn says the harness started a turn by itself, with no message (Claude does, to tell
	// the agent that a background subagent has ended). It does nothing if a turn is running.
	BeginTurn()
	// StopSubagents says the subagents of these calls that are still running were stopped (their
	// harness process ended): their calls still running are cancelled, and their open requests too.
	StopSubagents(ids []string)
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
	// OptionsChanged says the thread's options (model, effort, permission mode) changed: they go to
	// the running process where the harness takes them, and otherwise apply from the next turn.
	OptionsChanged()
	// ConfigChanged says the thread's config (tools, MCP servers, skills, system prompt) changed: the
	// next turn needs a new process.
	ConfigChanged()
	// Close stops the harness process, if it's running, and calls done once it has.
	Close(done func())
}

// CompactingSession is a Session that can compact the harness's context. A harness whose sessions
// aren't refuses the compact command.
type CompactingSession interface {
	Session
	// Compact says a turn started (with no messages) to compact the harness's context.
	Compact()
}

// RetiringSession is a Session that can retire its process as the thread's session changes
// (new_session, rewind) with no turn running. Without it, the core calls ConfigChanged.
type RetiringSession interface {
	Session
	// Retire stops the running process now (its background work too), and lets nothing it says
	// after reach the thread. The next turn starts a new one.
	Retire()
}

// RewindingSession is a Session that can take its conversation back to before a turn. A harness
// whose sessions aren't refuses the rewind command.
type RewindingSession interface {
	Session
	// RewindPoint is where a rewind to before turn index of sessions (each turn's session, in order;
	// nil for a turn that ended with none) takes the session: ResumeAtPoint or RevertPoint, say. It
	// returns a *RewindError if it can't be rewound there. The core then retires the old session
	// (Retire, or ConfigChanged), and sets the thread's session_id and resume_at.
	RewindPoint(sessions []*protocol.TurnSession, index int) (RewindPoint, error)
}

// ControlSession is a Session that takes the app's own requests to its running process
// (AgentThreads.Control).
type ControlSession interface {
	Session
	// Control sends the running process the request and calls reply (on the thread's goroutine)
	// with its answer, or with a *ControlError if the harness refuses it or doesn't answer. It
	// returns a *CommandError, and doesn't call reply, if there's no process to send it to or the
	// request is malformed.
	Control(request json.RawMessage, reply func(json.RawMessage, error)) error
}

// HarnessMessage is a line a thread's harness process wrote, for the app's OnHarnessMessage.
type HarnessMessage struct {
	ThreadID string
	// RunID is the process that wrote it (the thread's run.id while it runs).
	RunID   string
	Harness string
	// Line is the line, without its newline.
	Line string
	// Message is the line, if it's JSON; nil if it isn't.
	Message json.RawMessage
}

// unixTime is Unix seconds as an RFC 3339 time, to the second: YYYY-MM-DDTHH:MM:SSZ.
func unixTime(seconds float64) string {
	return time.Unix(int64(math.Floor(seconds)), 0).UTC().Format(time.RFC3339)
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

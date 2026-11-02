package agentthreads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// AgentThreads is the backend an app runs. It creates threads, takes commands, runs each thread's
// harness, and sends every thread's events to its subscribers, which the app wires to its own
// transport.

// Capabilities are the tools, MCP servers, skills and permission policy: for every thread, or for one.
type Capabilities struct {
	Tools      []Tool
	MCPServers map[string]MCPServer
	Skills     []Skill
	// Permissions says whether the agent may call a tool: Allow, Deny, Ask (the user), or a
	// PolicyFunc. The default asks.
	Permissions PermissionPolicy
	// SystemPrompt is added to the harness's own system prompt.
	SystemPrompt string
}

// Options configure an AgentThreads.
type Options struct {
	Capabilities
	// Store is where threads are kept: the app's, which it closes after this. A MemoryStore by default.
	Store Store
	// Harnesses are the harnesses threads can run on, by name. Claude Code ("claude") and Codex
	// ("codex") by default.
	Harnesses map[string]Harness
	// Spawner says how harness processes are started: as child processes (Direct) by default, which
	// end with the backend. With Shim they outlive it: call Recover when the app starts, to
	// re-attach.
	Spawner Spawner
	// OnError is called with errors that aren't any command's: a store that fails, a subscriber that
	// panics. They're logged by default.
	OnError func(error)
	// LateAnswers keeps questions still open when their turn ends (it was interrupted, say) open,
	// rather than cancelling them: an answer is sent to the agent as the user's next message, unless
	// the conversation has moved on first (a turn started, or a message was queued). Secret ones are
	// cancelled still.
	LateAnswers bool
	// Raw fills in raw on events, items and requests: the harness message each came from. It's off
	// by default; it's saved with the events, so they take more room.
	Raw bool
	// OnHarnessMessage is called with every line a thread's harness process writes, once its driver
	// has dealt with it: for what the protocol leaves out (Claude Code's system messages and rate
	// limit events, Codex's token usage...). It runs on the thread's goroutine as the output is read,
	// so it should be quick, and mustn't call the AgentThreads and wait. A panic is reported to
	// OnError.
	OnHarnessMessage func(HarnessMessage)
}

// CreateOptions are a new thread's.
type CreateOptions struct {
	Capabilities
	// Harness is the harness to run on: the only one configured, or "claude", by default.
	Harness        string
	Model          string
	Effort         string
	PermissionMode protocol.PermissionMode
	// Cwd is the working directory; the process's by default.
	Cwd   string
	Title string
	// Metadata is the app's own data about the thread (e.g. the user it's for), as JSON values or
	// values that marshal to them; tools and the policy get it.
	Metadata map[string]any
	// ID is the thread's id; a new one by default.
	ID string
	// StandingAnswers stand from the start (from the app's own rules, say), as answers given with
	// "always" do.
	StandingAnswers []protocol.StandingAnswer
	// Launch is how its harness process is started (args, environment, directories, config
	// directory), on top of the harness's options. It's stored with the thread, but not sent to
	// clients.
	Launch LaunchOptions
}

// SendOptions are a message's attachments and the client's id for it.
type SendOptions struct {
	Attachments []protocol.Attachment
	ClientID    string
}

// ThreadOptions are the options SetOptions changes; nil ones stay as they are, and "" clears one.
type ThreadOptions struct {
	Model          *string
	Effort         *string
	PermissionMode *protocol.PermissionMode
	// StandingAnswers replaces the thread's standing answers when it isn't nil; an empty one clears
	// them.
	StandingAnswers []protocol.StandingAnswer
	// Launch, if it isn't nil, replaces how the thread's harness process is started, in full. Only
	// the app sets it: the set_options command doesn't.
	Launch *LaunchOptions
}

// Recovered is what Recover did.
type Recovered struct {
	// Reattached is the threads whose runs it re-attached to (including runs that ended while the
	// backend was down).
	Reattached []string
	// Lost is the threads whose runs it couldn't re-attach to, and stopped: their turns ended.
	Lost []string
}

// CommandError is a command that can't be carried out: an unknown thread, a malformed command, or
// an AgentThreads that's closed.
type CommandError struct{ Message string }

func (e *CommandError) Error() string { return e.Message }

func commandErr(format string, args ...any) error {
	return &CommandError{Message: fmt.Sprintf(format, args...)}
}

// ControlError is a control request (Control) the harness refused, or didn't answer: its process
// exited first, or the backend closed. Data is the harness's own error, when it gave one (Claude
// Code's error text, as a JSON string, or Codex's JSON-RPC error object).
type ControlError struct {
	Message string
	Data    json.RawMessage
}

func (e *ControlError) Error() string { return e.Message }

// pruneEvery is how often the shim spawner's finished runs are pruned.
const pruneEvery = time.Hour

// AgentThreads runs threads. Its methods may be called from any goroutine.
type AgentThreads struct {
	store     Store
	harnesses map[string]Harness
	spawner   Spawner
	options   Options

	mu       sync.Mutex
	threads  map[string]*threadRuntime
	loading  map[string]*loadCall
	configs  map[string]Capabilities
	closed   bool
	stopping chan struct{}
	stopErr  error
	pruner   *time.Ticker
	prunerCh chan struct{}

	events *dispatcher
}

type loadCall struct {
	done chan struct{}
	rt   *threadRuntime
	err  error
}

// New is an AgentThreads with the options.
func New(options Options) *AgentThreads {
	a := &AgentThreads{
		store:     options.Store,
		harnesses: options.Harnesses,
		spawner:   options.Spawner,
		options:   options,
		threads:   map[string]*threadRuntime{},
		loading:   map[string]*loadCall{},
		configs:   map[string]Capabilities{},
	}
	if a.store == nil {
		a.store = NewMemoryStore()
	}
	if a.harnesses == nil {
		a.harnesses = map[string]Harness{"claude": ClaudeCode(ClaudeOptions{}), "codex": Codex(CodexOptions{})}
	}
	if a.spawner == nil {
		a.spawner = Direct()
	}
	a.events = newDispatcher(a.reportError)
	return a
}

// Store is the store threads are kept in.
func (a *AgentThreads) Store() Store { return a.store }

// Spawner is the spawner harness processes are started with.
func (a *AgentThreads) Spawner() Spawner { return a.spawner }

// ---------- threads ----------

// Create makes a thread, and sends a thread.updated with it.
func (a *AgentThreads) Create(ctx context.Context, o CreateOptions) (protocol.Thread, error) {
	if err := a.open(); err != nil {
		return protocol.Thread{}, err
	}
	harness := o.Harness
	if harness == "" {
		harness = a.defaultHarness()
	}
	if _, ok := a.harnesses[harness]; !ok || harness == "" {
		return protocol.Thread{}, commandErr("there's no harness %q", harness)
	}
	cwd := o.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	mode := o.PermissionMode
	if mode == "" {
		mode = protocol.PermissionModeDefault
	}
	id := o.ID
	if id == "" {
		id = NewID("th")
	}
	thread := protocol.Thread{
		ID: id, Harness: harness, Status: protocol.ThreadStatusIdle, Title: o.Title, Model: o.Model,
		Effort: o.Effort, PermissionMode: mode, Cwd: cwd, CreatedAt: now(), StandingAnswers: o.StandingAnswers,
	}
	if len(o.Metadata) > 0 {
		thread.Metadata = map[string]json.RawMessage{}
		for k, v := range o.Metadata {
			data, err := json.Marshal(v)
			if err != nil {
				return protocol.Thread{}, commandErr("the metadata's %s isn't JSON: %v", k, err)
			}
			thread.Metadata[k] = data
		}
	}
	// Until the thread's live (its first event made), a command for it waits, as for one loading.
	a.mu.Lock()
	if a.threads[id] != nil || a.loading[id] != nil {
		a.mu.Unlock()
		return protocol.Thread{}, NewStoreError(StoreErrExists, "thread %s exists", id)
	}
	l := &loadCall{done: make(chan struct{})}
	a.loading[id] = l
	a.configs[id] = o.Capabilities
	a.mu.Unlock()
	rt, err := a.createRuntime(ctx, thread, clone(o.Launch))
	a.mu.Lock()
	if err == nil {
		a.threads[id] = rt
	}
	delete(a.loading, id)
	l.rt, l.err = rt, err
	a.mu.Unlock()
	close(l.done)
	if err != nil {
		return protocol.Thread{}, err
	}
	if err := rt.waitSaved(ctx); err != nil {
		return protocol.Thread{}, err
	}
	return thread, nil
}

// createRuntime stores a new thread, and makes its runtime with its first event.
func (a *AgentThreads) createRuntime(ctx context.Context, thread protocol.Thread, launch LaunchOptions) (*threadRuntime, error) {
	if err := a.store.CreateThread(ctx, withLaunch(thread, launch)); err != nil {
		return nil, err
	}
	rt, err := a.runtime(protocol.InitialState(thread), launch)
	if err != nil {
		return nil, err
	}
	rt.loop.call(func() { rt.emit(&protocol.ThreadUpdatedEvent{Thread: thread}) })
	return rt, nil
}

func (a *AgentThreads) defaultHarness() string {
	if len(a.harnesses) == 1 {
		for name := range a.harnesses {
			return name
		}
	}
	if _, ok := a.harnesses["claude"]; ok {
		return "claude"
	}
	names := make([]string, 0, len(a.harnesses))
	for name := range a.harnesses {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

// Configure sets a thread's own tools, MCP servers, skills, policy or system prompt (those that
// aren't nil, and the system prompt if it isn't empty), which aren't stored: e.g. for a thread
// created before the app restarted. The policy and the tools' code change at once, even for a
// running turn; what the harness is told when its process starts (which tools there are, MCP
// servers, skills, the system prompt) changes from its next turn.
func (a *AgentThreads) Configure(ctx context.Context, threadID string, c Capabilities) error {
	if err := a.open(); err != nil {
		return err
	}
	a.mu.Lock()
	own := a.configs[threadID]
	if c.Tools != nil {
		own.Tools = c.Tools
	}
	if c.MCPServers != nil {
		own.MCPServers = c.MCPServers
	}
	if c.Skills != nil {
		own.Skills = c.Skills
	}
	if c.Permissions != nil {
		own.Permissions = c.Permissions
	}
	if c.SystemPrompt != "" {
		own.SystemPrompt = c.SystemPrompt
	}
	a.configs[threadID] = own
	rt := a.threads[threadID]
	a.mu.Unlock()
	if rt != nil {
		config, policy := a.config(threadID), a.policy(threadID)
		rt.loop.call(func() {
			rt.config, rt.policy = config, policy
			rt.session.OptionsChanged()
			// A run that outlives the backend is saved knowing it, without an event to save it with.
			rt.scheduleFlush()
		})
	}
	return nil
}

// Get is the thread, or nil if there's none.
func (a *AgentThreads) Get(ctx context.Context, threadID string) (*protocol.Thread, error) {
	if rt := a.live(threadID); rt != nil {
		t := rt.liveThread()
		return &t, nil
	}
	t, err := a.store.GetThread(ctx, threadID)
	if t != nil {
		// Its launch options aren't the client's.
		*t, _ = splitLaunch(*t)
	}
	return t, err
}

// List is every thread, oldest first.
func (a *AgentThreads) List(ctx context.Context) ([]protocol.Thread, error) {
	threads, err := a.store.ListThreads(ctx)
	if err != nil {
		return nil, err
	}
	for i, t := range threads {
		if rt := a.live(t.ID); rt != nil {
			threads[i] = rt.liveThread()
		} else {
			threads[i], _ = splitLaunch(t)
		}
	}
	return threads, nil
}

// Delete deletes a thread, stopping its harness first. It says whether there was one.
func (a *AgentThreads) Delete(ctx context.Context, threadID string) (bool, error) {
	if err := a.open(); err != nil {
		return false, err
	}
	if rt := a.live(threadID); rt != nil {
		// Not deleted while its harness is still being stopped (which its goroutine does): Delete
		// again once it has. Commands for it are refused meanwhile.
		if err := a.closeSession(ctx, rt); err != nil {
			return false, err
		}
		rt.dispose()
		a.mu.Lock()
		delete(a.threads, threadID)
		a.mu.Unlock()
	}
	a.mu.Lock()
	delete(a.configs, threadID)
	a.mu.Unlock()
	return a.store.DeleteThread(ctx, threadID)
}

// closeSession stops the thread's harness process, and waits for it (or ctx: then it goes on being
// stopped, and a later call waits for the same stop).
func (a *AgentThreads) closeSession(ctx context.Context, rt *threadRuntime) error {
	done, err := rt.closeSession(ctx)
	if err != nil || done == nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Snapshot is the thread's state now, including text streamed so far.
func (a *AgentThreads) Snapshot(ctx context.Context, threadID string) (protocol.Snapshot, error) {
	if err := a.open(); err != nil {
		return protocol.Snapshot{}, err
	}
	rt, err := a.load(ctx, threadID)
	if err != nil {
		return protocol.Snapshot{}, err
	}
	return rt.snapshot(), nil
}

// SnapshotWindow is the thread's state now, as Snapshot, but a window of it: its last limit items
// and what they need from before them, for a client that loads earlier ones with ItemsBefore
// (spec/PROTOCOL.md, "Windows"). With a negative limit, or one it's within, it's the whole state.
func (a *AgentThreads) SnapshotWindow(ctx context.Context, threadID string, limit int) (protocol.Snapshot, error) {
	snap, err := a.Snapshot(ctx, threadID)
	if err != nil {
		return protocol.Snapshot{}, err
	}
	return protocol.SnapshotWindow(snap, limit), nil
}

// ItemsBefore is the thread's items before index before (a window's start), at most limit of them,
// with the subagent calls they belong to and the requests they have: a page for a client that has
// a window to load earlier items into.
func (a *AgentThreads) ItemsBefore(ctx context.Context, threadID string, before int64, limit int) (protocol.ItemPage, error) {
	snap, err := a.Snapshot(ctx, threadID)
	if err != nil {
		return protocol.ItemPage{}, err
	}
	return protocol.ItemsBefore(snap, before, limit), nil
}

// EventsSince is the thread's saved events after seq (at most limit of them, if limit > 0), for a
// client catching up.
func (a *AgentThreads) EventsSince(ctx context.Context, threadID string, seq int64, limit int) ([]protocol.ThreadEvent, error) {
	if rt := a.live(threadID); rt != nil {
		if err := rt.waitSaved(ctx); err != nil {
			return nil, err
		}
	} else if t, err := a.store.GetThread(ctx, threadID); err != nil {
		return nil, err
	} else if t == nil {
		return nil, commandErr("there's no thread %s", threadID)
	}
	return a.store.ReadEvents(ctx, threadID, seq, limit)
}

// Subscribe calls fn with every thread's events, deltas included, in order: one at a time, on a
// goroutine of the AgentThreads' own (so fn may call its methods). It returns a function that stops
// it. fn mustn't change the events it's given.
func (a *AgentThreads) Subscribe(fn func(protocol.ThreadEvent)) (unsubscribe func()) {
	return a.events.subscribe(fn)
}

// Events is a channel of every thread's events, deltas included, in order, until ctx is done or the
// AgentThreads is closed. Events wait for the reader (however many), so read them promptly.
func (a *AgentThreads) Events(ctx context.Context) <-chan protocol.ThreadEvent {
	out := make(chan protocol.ThreadEvent)
	q := newQueue[protocol.ThreadEvent]()
	stop := a.events.subscribe(q.push)
	go func() {
		defer close(out)
		defer stop()
		for {
			e, ok := q.pop(ctx, a.events.closedCh)
			if !ok {
				return
			}
			select {
			case out <- e:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// Recover picks up the runs that were going when the backend last stopped (with the shim spawner,
// whose runs outlive it): it re-attaches to those still running, and follows those that ended while
// it was down to their end, so their threads carry on. Runs it can't re-attach to are stopped, and
// their turns end. Call it when the app starts, before taking commands; a thread a command loads
// first is re-attached then. It also prunes old runs' directories, now and every hour after.
func (a *AgentThreads) Recover(ctx context.Context) (Recovered, error) {
	out := Recovered{Reattached: []string{}, Lost: []string{}}
	if err := a.open(); err != nil {
		return out, err
	}
	runs, err := a.store.ActiveRuns(ctx)
	if err != nil {
		return out, err
	}
	for _, run := range runs {
		rt, err := a.load(ctx, run.ThreadID)
		if err != nil {
			a.reportError(err)
			continue
		}
		var current *protocol.Run
		var reattached, lost string
		rt.loop.call(func() { current, reattached, lost = rt.state.Thread.Run, rt.reattachedRun, rt.lostRun })
		// Re-attached when it was loaded (the run may have ended since, if it ended while the backend
		// was down, and the thread have gone on).
		if reattached == run.ID {
			out.Reattached = append(out.Reattached, run.ThreadID)
			continue
		}
		if current != nil && current.ID == run.ID {
			continue
		}
		if lost == run.ID {
			out.Lost = append(out.Lost, run.ThreadID)
		}
		// Not the thread's run (any more): nothing follows it.
		if now, err := a.store.GetRun(ctx, run.ID); err == nil && now != nil && now.Active() {
			a.abandon(ctx, *now)
		}
	}
	a.startPruning()
	return out, nil
}

func (a *AgentThreads) startPruning() {
	d, ok := a.spawner.(DurableSpawner)
	a.mu.Lock()
	if !ok || a.pruner != nil || a.closed {
		a.mu.Unlock()
		return
	}
	a.pruner = time.NewTicker(pruneEvery)
	a.prunerCh = make(chan struct{})
	ticker, stop := a.pruner, a.prunerCh
	a.mu.Unlock()
	prune := func() {
		if _, err := d.Prune(background, a.store); err != nil {
			a.reportError(err)
		}
	}
	go func() {
		prune()
		for {
			select {
			case <-ticker.C:
				prune()
			case <-stop:
				return
			}
		}
	}()
}

// abandon stops a run nothing follows, and records that the backend is done with it.
func (a *AgentThreads) abandon(ctx context.Context, run RunRecord) {
	if d, ok := a.spawner.(DurableSpawner); ok {
		d.StopRun(run)
	}
	run.EndedAt = now()
	if err := a.store.PutRun(ctx, run); err != nil {
		a.reportError(err)
	}
}

// ---------- commands ----------

// Handle carries out a command from a client. It returns a *CommandError for one it can't (an
// unknown thread, a malformed command), and changes nothing then.
func (a *AgentThreads) Handle(ctx context.Context, command protocol.Command) error {
	if problems := protocol.ValidateValue(command, "Command"); len(problems) > 0 {
		return invalid(problems)
	}
	switch c := command.Value.(type) {
	case *protocol.SendCommand:
		return a.Send(ctx, c.ThreadID, c.Text, SendOptions{Attachments: c.Attachments, ClientID: c.ClientID})
	case *protocol.InterruptCommand:
		return a.Interrupt(ctx, c.ThreadID)
	case *protocol.RespondCommand:
		return a.Respond(ctx, c.ThreadID, c.RequestID, c.Resolution)
	case *protocol.SetOptionsCommand:
		var o ThreadOptions
		if c.Model != "" {
			o.Model = &c.Model
		}
		if c.Effort != "" {
			o.Effort = &c.Effort
		}
		if c.PermissionMode != "" {
			o.PermissionMode = &c.PermissionMode
		}
		// Given (even empty, which clears them), they replace the thread's.
		if c.StandingAnswers != nil {
			o.StandingAnswers = append([]protocol.StandingAnswer{}, *c.StandingAnswers...)
		}
		return a.SetOptions(ctx, c.ThreadID, o)
	}
	return commandErr("that isn't a command")
}

// HandleJSON is Handle for a command as JSON, which is checked against the protocol's schema first.
func (a *AgentThreads) HandleJSON(ctx context.Context, data []byte) error {
	if problems := protocol.Validate(data, "Command"); len(problems) > 0 {
		return invalid(problems)
	}
	var c protocol.Command
	if err := json.Unmarshal(data, &c); err != nil {
		return commandErr("that isn't a valid command: %v", err)
	}
	// "" given for an option clears it, which the typed command can't say.
	if sc, ok := c.Value.(*protocol.SetOptionsCommand); ok {
		var raw map[string]json.RawMessage
		json.Unmarshal(data, &raw)
		var o ThreadOptions
		for k, p := range map[string]**string{"model": &o.Model, "effort": &o.Effort} {
			if v, ok := raw[k]; ok {
				var s string
				json.Unmarshal(v, &s)
				*p = &s
			}
		}
		if sc.PermissionMode != "" {
			o.PermissionMode = &sc.PermissionMode
		}
		if sc.StandingAnswers != nil {
			o.StandingAnswers = append([]protocol.StandingAnswer{}, *sc.StandingAnswers...)
		}
		return a.SetOptions(ctx, sc.ThreadID, o)
	}
	return a.Handle(ctx, c)
}

func invalid(problems []string) error {
	if len(problems) > 5 {
		problems = problems[:5]
	}
	return commandErr("that isn't a valid command: %s", strings.Join(problems, "; "))
}

// Send sends the agent a message: it starts a turn, or steers the running one.
func (a *AgentThreads) Send(ctx context.Context, threadID, text string, o SendOptions) error {
	return a.do(ctx, threadID, func(rt *threadRuntime) {
		rt.send(outgoing{text: text, attachments: o.Attachments, clientID: o.ClientID})
	})
}

// Interrupt stops the running turn, if there is one.
func (a *AgentThreads) Interrupt(ctx context.Context, threadID string) error {
	return a.do(ctx, threadID, func(rt *threadRuntime) { rt.interrupt() })
}

// Respond answers an open request; it does nothing if it isn't open.
func (a *AgentThreads) Respond(ctx context.Context, threadID, requestID string, res protocol.Resolution) error {
	if problems := protocol.ValidateValue(res, "Resolution"); len(problems) > 0 {
		return invalid(problems)
	}
	return a.do(ctx, threadID, func(rt *threadRuntime) { rt.respond(requestID, res) })
}

// SetOptions changes the thread's model, effort, permission mode or launch options, from its next
// turn, or its standing answers. Open permission requests the new mode or standing answers answer
// (bypass allows them, dont_ask denies them) are answered at once.
func (a *AgentThreads) SetOptions(ctx context.Context, threadID string, o ThreadOptions) error {
	if o.PermissionMode != nil {
		if problems := protocol.ValidateValue(*o.PermissionMode, "PermissionMode"); len(problems) > 0 {
			return invalid(problems)
		}
	}
	for _, s := range o.StandingAnswers {
		if problems := protocol.ValidateValue(s, "StandingAnswer"); len(problems) > 0 {
			return invalid(problems)
		}
	}
	return a.do(ctx, threadID, func(rt *threadRuntime) {
		before := rt.state.Thread
		rt.SetThread(func(t *protocol.Thread) {
			if o.Model != nil {
				t.Model = *o.Model
			}
			if o.Effort != nil {
				t.Effort = *o.Effort
			}
			if o.PermissionMode != nil {
				t.PermissionMode = *o.PermissionMode
			}
			if o.StandingAnswers != nil {
				t.StandingAnswers = append([]protocol.StandingAnswer(nil), o.StandingAnswers...)
			}
		})
		after := rt.state.Thread
		if before.Model != after.Model || before.Effort != after.Effort || before.PermissionMode != after.PermissionMode {
			rt.session.OptionsChanged()
		}
		if o.Launch != nil {
			rt.setLaunch(*o.Launch)
		}
		rt.settle()
	})
}

// do runs fn on the live thread a command is for, once the AgentThreads is known to be open.
func (a *AgentThreads) do(ctx context.Context, threadID string, fn func(rt *threadRuntime)) error {
	if err := a.open(); err != nil {
		return err
	}
	rt, err := a.load(ctx, threadID)
	if err != nil {
		return err
	}
	if err := a.open(); err != nil {
		return err
	}
	var refused error
	if err := rt.loop.callCtx(ctx, func() {
		// Its harness is being stopped: a command for it would start a run that can't go anywhere.
		if rt.sessionClosing() {
			if refused = a.open(); refused == nil {
				refused = commandErr("thread %s is being deleted", threadID)
			}
			return
		}
		fn(rt)
	}); err != nil {
		if errors.Is(err, errLoopStopped) {
			return commandErr("this AgentThreads is closed")
		}
		return err
	}
	return refused
}

// Control sends the thread's running harness process a request of the app's own, and returns its
// answer: for Claude Code a control request's request (e.g. {"subtype": "get_context_usage"}),
// answered with the control response's response; for Codex {"method": ..., "params": ...}, answered
// with the JSON-RPC result. It returns a *CommandError if the thread has no running process or its
// harness takes no requests, a *ControlError if the harness refuses it or its process exits (or the
// backend closes) before it answers, and ctx's error if ctx is done first. It mustn't be used for
// what the driver does itself (starting turns, answering the harness's requests...).
func (a *AgentThreads) Control(ctx context.Context, threadID string, request json.RawMessage) (json.RawMessage, error) {
	type answer struct {
		result json.RawMessage
		err    error
	}
	answers := make(chan answer, 1)
	var refused error
	var rt *threadRuntime
	err := a.do(ctx, threadID, func(r *threadRuntime) {
		rt = r
		cs, ok := r.session.(ControlSession)
		if !ok {
			refused = commandErr("thread %s runs on %s, which doesn't take control requests", threadID, r.state.Thread.Harness)
			return
		}
		refused = cs.Control(request, func(result json.RawMessage, err error) { answers <- answer{result, err} })
	})
	if err != nil {
		return nil, err
	}
	if refused != nil {
		return nil, refused
	}
	select {
	case a := <-answers:
		return a.result, a.err
	case <-rt.loop.stoppedCh:
		// The thread let go of its process without saying (it was closed).
		select {
		case a := <-answers:
			return a.result, a.err
		default:
			return nil, &ControlError{Message: "the backend closed before the harness answered"}
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Close stops every harness process, saves everything, and returns once the subscribers have had
// every event. With a durable spawner (Shim), runs are
// left going instead (their turns too), for Recover to re-attach to when the app starts again; a
// driver that can't re-attach has its runs stopped. It returns an error if some thread's events
// can't be saved (the store is failing): they're kept, and calling Close again tries again. After
// it, commands, snapshots and changes to threads are refused with a CommandError; Get, List and
// EventsSince still read the store, which is the app's to close.
func (a *AgentThreads) Close(ctx context.Context) error { return a.shutdown(ctx, false) }

// Stop is Close, but it stops the runs of a durable spawner too, rather than leaving them going.
func (a *AgentThreads) Stop(ctx context.Context) error { return a.shutdown(ctx, true) }

func (a *AgentThreads) shutdown(ctx context.Context, stop bool) error {
	a.mu.Lock()
	first := a.stopping == nil
	if first {
		a.stopping = make(chan struct{})
		a.closed = true
		if a.pruner != nil {
			a.pruner.Stop()
			close(a.prunerCh)
		}
	}
	stopping := a.stopping
	a.mu.Unlock()
	if first {
		a.stopAll(ctx, stop)
		close(stopping)
	}
	select {
	case <-stopping:
	case <-ctx.Done():
		return ctx.Err()
	}
	err := a.saveAll(ctx)
	if d, ok := a.spawner.(DurableSpawner); ok {
		// Runs being stopped are stopped before the backend goes.
		if werr := d.Wait(ctx); werr != nil && err == nil {
			err = werr
		}
	}
	if err == nil {
		// Every event is delivered before it returns.
		a.events.close()
		select {
		case <-a.events.closedCh:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}

// stopAll stops every thread's harness, once.
func (a *AgentThreads) stopAll(ctx context.Context, stop bool) {
	a.mu.Lock()
	loading := make([]*loadCall, 0, len(a.loading))
	for _, l := range a.loading {
		loading = append(loading, l)
	}
	a.mu.Unlock()
	for _, l := range loading {
		<-l.done
	}
	_, durable := a.spawner.(DurableSpawner)
	var wg sync.WaitGroup
	for _, rt := range a.liveThreads() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			left := false
			rt.loop.call(func() {
				// Left going, saved as it is now, to be re-attached to (saveAll reports a failure). One
				// already being stopped (by a Delete whose context ran out) goes on being stopped.
				if d, ok := rt.session.(DurableSession); !stop && durable && ok && !rt.sessionClosing() && d.Detach() {
					left = true
					rt.markDetached()
					rt.scheduleFlush()
					return
				}
				// A turn cut short by shutting down ends as an interrupted one.
				rt.closing = true
				if rt.turn != nil {
					rt.turn.Interrupted = true
				}
			})
			if left {
				return
			}
			// One that's still being stopped when ctx is done is waited for by saveAll.
			a.closeSession(ctx, rt)
			rt.loop.call(func() {
				if rt.turn != nil {
					rt.endTurn(TurnEnd{}, false)
				}
			})
		}()
	}
	wg.Wait()
}

// saveAll saves every thread's events and a snapshot; it returns the failures if any can't be saved.
func (a *AgentThreads) saveAll(ctx context.Context) error {
	var errs []error
	for _, rt := range a.liveThreads() {
		if rt.isDisposed() {
			continue
		}
		// Its harness is stopped first: its goroutine is what stops it.
		if err := a.closeSession(ctx, rt); err != nil && !rt.detachedRun() {
			errs = append(errs, fmt.Errorf("thread %s's harness is still being stopped: %w", rt.id, err))
			continue
		}
		rt.loop.call(func() { rt.saveSnapshot() })
		if err := rt.waitSaved(ctx); err != nil {
			errs = append(errs, err)
			continue
		}
		rt.dispose()
	}
	if len(errs) > 0 {
		return fmt.Errorf("%d thread(s) aren't closed yet (Close again to finish): %w", len(errs), errors.Join(errs...))
	}
	return nil
}

func (rt *threadRuntime) isDisposed() bool {
	rt.wmu.Lock()
	defer rt.wmu.Unlock()
	return rt.disposed
}

// ---------- internals ----------

func (a *AgentThreads) open() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return commandErr("this AgentThreads is closed")
	}
	return nil
}

func (a *AgentThreads) live(id string) *threadRuntime {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.threads[id]
}

func (a *AgentThreads) liveThreads() []*threadRuntime {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]*threadRuntime, 0, len(a.threads))
	for _, rt := range a.threads {
		out = append(out, rt)
	}
	return out
}

func (a *AgentThreads) config(threadID string) ThreadConfig {
	a.mu.Lock()
	own := a.configs[threadID]
	a.mu.Unlock()
	all := a.options.Capabilities
	var tools []Tool
	at := map[string]int{}
	for _, t := range append(append([]Tool(nil), all.Tools...), own.Tools...) {
		if i, ok := at[t.Name()]; ok {
			tools[i] = t
			continue
		}
		at[t.Name()] = len(tools)
		tools = append(tools, t)
	}
	servers := map[string]MCPServer{}
	for k, v := range all.MCPServers {
		servers[k] = v
	}
	for k, v := range own.MCPServers {
		servers[k] = v
	}
	var prompts []string
	for _, p := range []string{all.SystemPrompt, own.SystemPrompt} {
		if p != "" {
			prompts = append(prompts, p)
		}
	}
	return ThreadConfig{
		Tools:        tools,
		MCPServers:   servers,
		Skills:       append(append([]Skill(nil), all.Skills...), own.Skills...),
		SystemPrompt: strings.Join(prompts, "\n\n"),
	}
}

func (a *AgentThreads) policy(threadID string) PermissionPolicy {
	a.mu.Lock()
	own := a.configs[threadID].Permissions
	a.mu.Unlock()
	if own != nil {
		return own
	}
	if a.options.Permissions != nil {
		return a.options.Permissions
	}
	return Ask
}

func (a *AgentThreads) runtime(state protocol.Snapshot, launch LaunchOptions) (*threadRuntime, error) {
	id := state.Thread.ID
	harness := a.harnesses[state.Thread.Harness]
	if harness == nil {
		return nil, commandErr("thread %s runs on %s, which isn't configured", id, state.Thread.Harness)
	}
	// Not live yet: the caller makes it so (in a.threads) once it's ready to take commands.
	rt := newRuntime(a, state, a.config(id), launch, a.policy(id))
	rt.loop.call(func() { rt.session = harness.Open(rt) })
	return rt, nil
}

// load is the live thread, loaded from the store if it isn't yet.
func (a *AgentThreads) load(ctx context.Context, threadID string) (*threadRuntime, error) {
	a.mu.Lock()
	if rt := a.threads[threadID]; rt != nil {
		a.mu.Unlock()
		return rt, nil
	}
	l := a.loading[threadID]
	if l == nil {
		l = &loadCall{done: make(chan struct{})}
		a.loading[threadID] = l
		go func() {
			rt, err := a.fromStore(background, threadID)
			// Live once it's been recovered, and not before: a command that comes meanwhile waits.
			a.mu.Lock()
			if err == nil {
				a.threads[threadID] = rt
			}
			delete(a.loading, threadID)
			l.rt, l.err = rt, err
			a.mu.Unlock()
			close(l.done)
		}()
	}
	a.mu.Unlock()
	select {
	case <-l.done:
		return l.rt, l.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *AgentThreads) fromStore(ctx context.Context, threadID string) (*threadRuntime, error) {
	thread, err := a.store.GetThread(ctx, threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, commandErr("there's no thread %s", threadID)
	}
	// Its launch options are kept with it in the store, but aren't part of its state.
	stored, launch := splitLaunch(*thread)
	thread = &stored
	snap, err := a.store.LoadSnapshot(ctx, threadID)
	if err != nil {
		return nil, err
	}
	state := protocol.InitialState(*thread)
	if snap != nil {
		state = *snap
	}
	events, err := a.store.ReadEvents(ctx, threadID, state.Seq, 0)
	if err != nil {
		return nil, err
	}
	state = protocol.ApplyEvents(state, events)
	if state.Seq == 0 {
		state = protocol.InitialState(*thread)
	}
	// The run it had, read first: a store that can't say leaves the thread to be loaded again later,
	// rather than taking a run that may still be going for lost.
	var record *RunRecord
	if run := state.Thread.Run; run != nil && run.Spawner != protocol.RunSpawnerDirect {
		r, err := a.store.GetRun(ctx, run.ID)
		if err != nil {
			return nil, err
		}
		if r != nil && r.Active() {
			record = r
		}
	}
	rt, err := a.runtime(state, launch)
	if err != nil {
		return nil, err
	}
	var abandon *RunRecord
	rt.loop.call(func() {
		ok, stop := a.reattach(rt, record)
		if ok {
			return
		}
		abandon = stop
		// The process that ran its turn went with the backend before this one, or can't be followed.
		s := rt.state.Thread.Status
		if s == protocol.ThreadStatusRunning || s == protocol.ThreadStatusWaiting || rt.state.Thread.Run != nil {
			if rt.state.Thread.Run != nil {
				rt.lostRun = rt.state.Thread.Run.ID
			}
			recoverLost(rt)
		} else {
			// Questions kept open after their turns ended are taken up again (or cancelled, if they
			// can't be any more).
			rt.takeUpRequests(false)
		}
	})
	if abandon != nil {
		a.abandon(ctx, *abandon)
	}
	return rt, nil
}

// reattach re-attaches a thread just loaded to its run (record), if it has one that outlived the
// backend before: its turn and open requests are as they were when the run was last saved, and the
// session carries on reading the run from there. It says whether it did; if it couldn't, it returns
// the run, to be stopped.
func (a *AgentThreads) reattach(rt *threadRuntime, record *RunRecord) (bool, *RunRecord) {
	if record == nil {
		return false, nil
	}
	run := rt.state.Thread.Run
	var data struct {
		Turn json.RawMessage `json:"turn"`
	}
	json.Unmarshal(record.Data, &data)
	s := rt.state.Thread.Status
	if s == protocol.ThreadStatusRunning || s == protocol.ThreadStatusWaiting {
		var t turnState
		switch {
		case len(data.Turn) == 0:
			// A run saved before runs had their turn has the last one.
			rt.turn = &turnState{ID: lastTurn(rt.state.Items)}
		case string(data.Turn) == "null" || json.Unmarshal(data.Turn, &t) != nil:
			// Saved with no turn running: it may be waiting only on a background subagent's request.
			rt.turn = nil
		default:
			rt.turn = &t
		}
	}
	rt.adoptRun(*record)
	_, durable := a.spawner.(DurableSpawner)
	session, ok := rt.session.(DurableSession)
	if !durable || record.Spawner != a.spawner.Name() || !ok || !session.Reattach(*record) {
		rt.turn = nil
		return false, record
	}
	// Requests the session didn't take up again can't be answered by the harness: questions kept
	// open after their turns (or given up by an interrupted one) stay open, the others are cancelled.
	rt.takeUpRequests(false)
	open := rt.openRequestIDs()
	// With none left (one answered before the restart is closed, say), the turn runs on, or the
	// thread is idle if none was running.
	if len(open) == 0 && rt.state.Thread.Status == protocol.ThreadStatusWaiting {
		status := protocol.ThreadStatusIdle
		if rt.turn != nil {
			status = protocol.ThreadStatusRunning
		}
		rt.SetThread(func(t *protocol.Thread) { t.Status = status })
	}
	rt.reattachedRun = record.ID
	reattached := *run
	reattached.ReattachedAt = now()
	rt.SetThread(func(t *protocol.Thread) { t.Run = &reattached })
	if rt.turn != nil {
		rt.AddItem(&protocol.Notice{
			ID: NewID("n"), Level: protocol.NoticeLevelInfo, Code: "run.reattached",
			Text: "The backend restarted while this turn was running, and picked it up again.",
		})
	}
	return true, nil
}

func lastTurn(items []protocol.Item) string {
	for i := len(items) - 1; i >= 0; i-- {
		if t := items[i].TurnID(); t != "" {
			return t
		}
	}
	return NewID("turn")
}

// openTurn is the turn a thread's items say is still running: its last, if it has no turn_result
// ("" if none is; a thread waiting with none running is waiting on a background subagent's request).
func openTurn(items []protocol.Item) string {
	last := ""
	for i := len(items) - 1; i >= 0 && last == ""; i-- {
		last = items[i].TurnID()
	}
	for _, it := range items {
		if r, ok := it.Value.(*protocol.TurnResult); ok && r.TurnID == last {
			return ""
		}
	}
	return last
}

// recoverLost ends a turn whose process was lost when the backend stopped, and stops the subagents
// that went with it (a background one may be running with no turn).
func recoverLost(rt *threadRuntime) {
	s := rt.state.Thread.Status
	open := openTurn(rt.state.Items)
	turn := s == protocol.ThreadStatusRunning || (s == protocol.ThreadStatusWaiting && open != "")
	if turn {
		if open == "" {
			open = NewID("turn")
		}
		rt.turn = &turnState{ID: open}
	}
	var running []string
	for _, it := range rt.state.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok && c.Subagent != nil && c.Subagent.Status == protocol.SubagentStatusRunning {
			running = append(running, c.ID)
		}
	}
	rt.StopSubagents(running)
	// Its open requests can't be answered now (but for questions that can be answered late).
	rt.takeUpRequests(true)
	if turn {
		rt.AddItem(&protocol.Notice{
			ID: NewID("n"), Level: protocol.NoticeLevelWarning, Code: "run.lost",
			Text: "The backend stopped while this turn was running, and couldn't pick its run up again.",
		})
		// Not carried over: loading a thread starts no process. Its queued messages go with the next.
		rt.endTurn(TurnEnd{Error: "The backend stopped while this turn was running."}, false)
	} else if rt.state.Thread.Status == protocol.ThreadStatusWaiting {
		rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusIdle })
	}
	rt.SetThread(func(t *protocol.Thread) { t.Run = nil })
}

func (a *AgentThreads) publish(e protocol.ThreadEvent) { a.events.push(e) }

func (a *AgentThreads) reportError(err error) {
	if a.options.OnError != nil {
		a.options.OnError(err)
		return
	}
	log.Printf("agent-threads: %v", err)
}

// ---------- events ----------

// dispatcher sends events to the subscribers, in order, one at a time, on a goroutine of its own.
type dispatcher struct {
	q        *queue[protocol.ThreadEvent]
	mu       sync.Mutex
	subs     map[int]func(protocol.ThreadEvent)
	next     int
	onError  func(error)
	closedCh chan struct{}
	once     sync.Once
}

func newDispatcher(onError func(error)) *dispatcher {
	d := &dispatcher{q: newQueue[protocol.ThreadEvent](), subs: map[int]func(protocol.ThreadEvent){}, onError: onError, closedCh: make(chan struct{})}
	go d.run()
	return d
}

func (d *dispatcher) push(e protocol.ThreadEvent) { d.q.push(e) }

func (d *dispatcher) subscribe(fn func(protocol.ThreadEvent)) func() {
	d.mu.Lock()
	id := d.next
	d.next++
	d.subs[id] = fn
	d.mu.Unlock()
	return func() {
		d.mu.Lock()
		delete(d.subs, id)
		d.mu.Unlock()
	}
}

func (d *dispatcher) run() {
	for {
		e, ok := d.q.pop(background, nil)
		if !ok {
			close(d.closedCh)
			return
		}
		d.mu.Lock()
		ids := make([]int, 0, len(d.subs))
		for id := range d.subs {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		fns := make([]func(protocol.ThreadEvent), 0, len(ids))
		for _, id := range ids {
			fns = append(fns, d.subs[id])
		}
		d.mu.Unlock()
		for _, fn := range fns {
			d.call(fn, e)
		}
	}
}

func (d *dispatcher) call(fn func(protocol.ThreadEvent), e protocol.ThreadEvent) {
	defer func() {
		if r := recover(); r != nil {
			d.onError(fmt.Errorf("agentthreads: a subscriber panicked: %v", r))
		}
	}()
	fn(e)
}

// close ends the dispatcher once the events sent so far are delivered.
func (d *dispatcher) close() { d.once.Do(d.q.close) }

// queue is an unbounded FIFO queue.
type queue[T any] struct {
	mu     sync.Mutex
	items  []T
	wake   chan struct{}
	closed bool
}

func newQueue[T any]() *queue[T] { return &queue[T]{wake: make(chan struct{}, 1)} }

func (q *queue[T]) push(v T) {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.items = append(q.items, v)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *queue[T]) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// pop is the next item, waiting for one; false once the queue is closed and empty, or ctx or stop
// is done.
func (q *queue[T]) pop(ctx context.Context, stop <-chan struct{}) (T, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			v := q.items[0]
			var zero T
			q.items[0] = zero
			q.items = q.items[1:]
			q.mu.Unlock()
			return v, true
		}
		closed := q.closed
		q.mu.Unlock()
		var zero T
		if closed {
			return zero, false
		}
		select {
		case <-q.wake:
		case <-ctx.Done():
			return zero, false
		case <-stop:
			return zero, false
		}
	}
}

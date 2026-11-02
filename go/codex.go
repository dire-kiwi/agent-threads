package agentthreads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// The Codex driver: it runs `codex app-server` (JSON-RPC over stdio), one process per thread
// (started at its first message, kept between turns), and translates its items into the thread's
// events by the rules in spec/fixtures/README.md. A message is turn/start (or turn/steer while a
// turn runs); the server's approval and question requests go through the permission policy; the
// app's tools are dynamic tools answered over item/tool/call, or (where Codex can't take those) a
// loopback MCP server. With a spawner whose runs outlive the backend, it checkpoints what it needs
// to carry on reading a run (the JSON-RPC client's pending requests, Codex's open ones, the turn,
// what it streamed) and re-attaches to it after a restart.

// CodexOptions configure the Codex harness.
type CodexOptions struct {
	// Bin is the codex binary ("codex" on the PATH by default).
	Bin string
	// BinArgs are arguments before Codex's own: e.g. the script, when Bin is node.
	BinArgs []string
	// Args are more arguments, after app-server.
	Args []string
	// Env is added to the backend's environment.
	Env map[string]string
	// Home is the app's CODEX_HOME, where Codex keeps the app's sessions (resuming a thread needs
	// them), so it should last as long as the threads do. ~/.agent-threads/codex by default.
	Home string
	// Login is the CODEX_HOME whose login (auth.json) is linked into Home if it has none of its own:
	// the user's ($CODEX_HOME, or ~/.codex) by default.
	Login string
	// NoLogin links no login into Home.
	NoLogin bool
	// UserConfig runs with the user's own CODEX_HOME, and so their config, MCP servers and skills.
	// Off by default: a thread sees only the app's.
	UserConfig bool
	// AppToolsOverMCP gives the app's tools to Codex on a loopback MCP server rather than as dynamic
	// tools (experimental in Codex; the default). A Codex that refuses dynamic tools gets the MCP
	// server anyway.
	AppToolsOverMCP bool
	// Config is more config for thread/start (Codex's config.toml keys, dotted), under the driver's own.
	Config map[string]any
	// StopGrace is how long an interrupted turn has to end before the process is stopped. 10s by
	// default.
	StopGrace time.Duration
	// CloseGrace is how long a process has to exit after its input is closed before it's sent
	// SIGTERM. 5s by default.
	CloseGrace time.Duration
}

// Codex is the Codex harness.
func Codex(o CodexOptions) Harness { return codexHarness{o} }

type codexHarness struct{ o CodexOptions }

func (codexHarness) Name() string { return "codex" }

func (h codexHarness) Open(ctx ThreadContext) Session { return &codexSession{ctx: ctx, o: h.o} }

// appToolTimeoutSec is how long a thread's MCP tools (the app's, on the loopback server) may take:
// the policy may ask the user.
const appToolTimeoutSec = 3600

// codexOpen is a request of Codex's not yet answered: the turn it came in, the request, and
// whether we've started on it (an app tool that's running isn't run again after a restart).
type codexOpen struct {
	Turn    string `json:"turn,omitempty"`
	Msg     jmap   `json:"msg"`
	Started bool   `json:"started,omitempty"`
}

// codexSent is a message sent (by turn/start or turn/steer), by what Codex echoes when it takes it in.
type codexSent struct {
	IDs []string `json:"ids"`
	Key string   `json:"key"`
}

type mcpCall struct {
	ID     string          `json:"id"`
	Server string          `json:"server"`
	Name   string          `json:"name"`
	Args   json.RawMessage `json:"args"`
	Thread string          `json:"thread,omitempty"`
}

type mcpEndpoint struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// codexRunState is what a run's checkpoint holds: what's needed to carry on reading it, as of the
// offset saved with it.
type codexRunState struct {
	V              int             `json:"v"`
	ThreadID       string          `json:"threadId"`
	TurnID         string          `json:"turnId,omitempty"`
	Starting       bool            `json:"starting"`
	Compacting     bool            `json:"compacting"`
	Reported       bool            `json:"reported,omitempty"`
	Used           *protocol.Usage `json:"used,omitempty"`
	Error          *string         `json:"error"`
	Home           string          `json:"home"`
	Dynamic        []toolSpec      `json:"dynamic"`
	MCPApp         bool            `json:"mcpApp"`
	HiddenSkills   []string        `json:"hiddenSkills"`
	NoticedServers bool            `json:"noticedServers"`
	SkillsDir      string          `json:"skillsDir,omitempty"`
	MCP            *mcpEndpoint    `json:"mcp,omitempty"`
	Streamed       []string        `json:"streamed"`
	SummaryPart    [][2]any        `json:"summaryPart"`
	Children       [][2]string     `json:"children"`
	LastChild      [][2]string     `json:"lastChild"`
	MCPCalls       []mcpCall       `json:"mcpCalls"`
	Open           [][2]any        `json:"open"`
	Asked          [][2]any        `json:"asked"`
	Sent           []codexSent     `json:"sent"`
	Held           []string        `json:"held"`
	RPC            rpcState        `json:"rpc"`
	Launched       *launched       `json:"launched,omitempty"`
	Stale          bool            `json:"stale,omitempty"`
	StopAt         *int64          `json:"stopAt,omitempty"`
	raw            json.RawMessage `json:"-"`
}

// codexRun is one codex app-server process, and what's needed to read it.
type codexRun struct {
	id       string
	proc     Process
	rpc      *rpcClient
	exited   bool
	retired  bool
	detached bool
	finished bool
	onDone   []func()
	stderr   []string
	toolCtx  context.Context
	abort    context.CancelFunc
	// ready: Codex's thread id once the thread is started or resumed, or why it couldn't be.
	readyDone    bool
	readyID      string
	readyErr     error
	readyWaiters []func(string, error)
	// threadID is Codex's thread: the thread's own, as against its subagents'.
	threadID string
	// turnID is the Codex turn running on the thread, once its id is known.
	turnID string
	// starting says a turn/start (or compaction) was sent and its turn hasn't ended.
	starting    bool
	turnWaiters []func(string)
	compacting  bool
	// reported says Codex has reported the thread's tokens in this run (so its turns' usage is known).
	reported bool
	// used is what the running turn has used: each model call's tokens (tokenUsage.last), summed
	// from its turn/started on. Codex's running totals aren't used: for a session the thread adopted
	// they include what came before, and a revert doesn't take them back.
	used *protocol.Usage
	// errText is the running turn's last error that won't be retried.
	errText *string
	home    string
	// dynamic is the dynamic tools Codex has for the session (it keeps those it was started with);
	// nil if they aren't known (the session was started elsewhere).
	dynamic []toolSpec
	// mcpApp says some of the app's tools are on the loopback MCP server.
	mcpApp bool
	// hiddenSkills is the skills Codex found that aren't the app's (the user's, the project's):
	// they're turned off.
	hiddenSkills   []string
	noticedServers bool
	mcp            *loopbackMCP
	// mcpEndpoint is where Codex was told the loopback MCP server is, which it is (or, re-attached,
	// is about to be) for as long as the process runs.
	mcpEndpoint *mcpEndpoint
	skillsDir   string
	// What's needed to translate its output.
	streamed    map[string]bool
	summaryPart map[string]int    // reasoning item -> the summary part its deltas are in
	children    map[string]string // child thread -> the spawnAgent call it's for
	lastChild   map[string]string // child thread -> its last message
	// mcpCalls is the MCP tool calls running: for an elicitation (which only names its server) and
	// the app's MCP tools.
	mcpCalls []mcpCall
	// open is the server's requests not yet answered, by their ids' JSON.
	open      map[string]*codexOpen
	openOrder []string
	asked     map[string]string // the server's request -> our request
	// sent is the messages sent, oldest first, by the text inputs Codex echoes in its userMessage item.
	sent []*codexSent
	// held is the queued messages this process has (it was sent them, and didn't refuse them).
	held     map[string]bool
	launched *launched
}

func newCodexRun(id string) *codexRun {
	if id == "" {
		id = NewID("run")
	}
	ctx, cancel := context.WithCancel(background)
	return &codexRun{
		id: id, toolCtx: ctx, abort: cancel, streamed: map[string]bool{}, summaryPart: map[string]int{},
		children: map[string]string{}, lastChild: map[string]string{}, open: map[string]*codexOpen{},
		asked: map[string]string{}, held: map[string]bool{},
	}
}

func (r *codexRun) write(msg any) {
	if !r.exited && !r.detached && r.proc != nil {
		r.proc.Write(string(mustJSON(msg)))
	}
}

func (r *codexRun) whenReady(fn func(threadID string, err error)) {
	if r.readyDone {
		fn(r.readyID, r.readyErr)
		return
	}
	r.readyWaiters = append(r.readyWaiters, fn)
}

func (r *codexRun) setReady(id string, err error) {
	if r.readyDone {
		return
	}
	r.readyDone, r.readyID, r.readyErr = true, id, err
	waiters := r.readyWaiters
	r.readyWaiters = nil
	for _, fn := range waiters {
		fn(id, err)
	}
}

func (r *codexRun) whenDone(fn func()) {
	if r.finished {
		fn()
		return
	}
	r.onDone = append(r.onDone, fn)
}

func (r *codexRun) finish() {
	if r.finished {
		return
	}
	r.finished = true
	for _, fn := range r.onDone {
		fn()
	}
	r.onDone = nil
}

func (r *codexRun) dynamicTool(name string) (toolSpec, bool) {
	for _, t := range r.dynamic {
		if t.Name == name {
			return t, true
		}
	}
	return toolSpec{}, false
}

func (r *codexRun) setOpen(key string, o *codexOpen) {
	if _, ok := r.open[key]; !ok {
		r.openOrder = append(r.openOrder, key)
	}
	r.open[key] = o
}

func (r *codexRun) dropOpen(key string) bool {
	if _, ok := r.open[key]; !ok {
		return false
	}
	delete(r.open, key)
	r.openOrder = without(r.openOrder, key)
	return true
}

// state is what a checkpoint needs; nil while it's starting (Codex's thread isn't known yet).
func (r *codexRun) state() *codexRunState {
	if r.threadID == "" {
		return nil
	}
	st := &codexRunState{
		V: 1, ThreadID: r.threadID, TurnID: r.turnID, Starting: r.starting, Compacting: r.compacting, Reported: r.reported, Used: r.used,
		Error: r.errText, Home: r.home, Dynamic: r.dynamic, MCPApp: r.mcpApp,
		HiddenSkills: orEmptyList(r.hiddenSkills), NoticedServers: r.noticedServers, SkillsDir: r.skillsDir, MCP: r.mcpEndpoint,
		Streamed: sortedKeys(r.streamed), MCPCalls: append([]mcpCall{}, r.mcpCalls...), RPC: r.rpc.state(), Launched: r.launched,
		SummaryPart: [][2]any{}, Children: [][2]string{}, LastChild: [][2]string{}, Open: [][2]any{}, Asked: [][2]any{}, Sent: []codexSent{}, Held: sortedKeys(r.held),
	}
	for _, k := range sortedKeys(r.summaryPart) {
		st.SummaryPart = append(st.SummaryPart, [2]any{k, r.summaryPart[k]})
	}
	for _, k := range sortedKeys(r.children) {
		st.Children = append(st.Children, [2]string{k, r.children[k]})
	}
	for _, k := range sortedKeys(r.lastChild) {
		st.LastChild = append(st.LastChild, [2]string{k, r.lastChild[k]})
	}
	for _, k := range r.openOrder {
		st.Open = append(st.Open, [2]any{json.RawMessage(k), r.open[k]})
	}
	for _, k := range sortedKeys(r.asked) {
		st.Asked = append(st.Asked, [2]any{json.RawMessage(k), r.asked[k]})
	}
	for _, s := range r.sent {
		st.Sent = append(st.Sent, *s)
	}
	return st
}

// restore takes up a checkpoint's state (all but the JSON-RPC client's, which the session restores).
func (r *codexRun) restore(st codexRunState) {
	r.threadID, r.turnID, r.starting, r.compacting = st.ThreadID, st.TurnID, st.Starting, st.Compacting
	r.reported, r.used, r.errText, r.home, r.dynamic, r.mcpApp = st.Reported, st.Used, st.Error, st.Home, st.Dynamic, st.MCPApp
	r.hiddenSkills, r.noticedServers, r.skillsDir, r.mcpEndpoint = st.HiddenSkills, st.NoticedServers, st.SkillsDir, st.MCP
	for _, k := range st.Streamed {
		r.streamed[k] = true
	}
	for _, kv := range st.SummaryPart {
		k, _ := kv[0].(string)
		n, _ := kv[1].(float64)
		r.summaryPart[k] = int(n)
	}
	for _, kv := range st.Children {
		r.children[kv[0]] = kv[1]
	}
	for _, kv := range st.LastChild {
		r.lastChild[kv[0]] = kv[1]
	}
	r.mcpCalls = st.MCPCalls
	for _, kv := range st.Open {
		var o codexOpen
		json.Unmarshal(mustJSON(kv[1]), &o)
		r.setOpen(canonical(mustJSON(kv[0])), &o)
	}
	for _, kv := range st.Asked {
		id, _ := kv[1].(string)
		r.asked[canonical(mustJSON(kv[0]))] = id
	}
	for _, s := range st.Sent {
		s := s
		r.sent = append(r.sent, &s)
	}
	for _, id := range st.Held {
		r.held[id] = true
	}
	r.launched = st.Launched
	r.readyDone, r.readyID = true, st.ThreadID
}

// withTurn calls fn with the running turn's id once it's known, or "" if none is coming.
func (r *codexRun) withTurn(fn func(string)) {
	switch {
	case r.turnID != "":
		fn(r.turnID)
	case r.starting && !r.exited:
		r.turnWaiters = append(r.turnWaiters, fn)
	default:
		fn("")
	}
}

func (r *codexRun) setTurn(id string) {
	r.turnID = id
	waiters := r.turnWaiters
	r.turnWaiters = nil
	for _, fn := range waiters {
		fn(id)
	}
}

func (r *codexRun) turnEnded() {
	r.turnID, r.starting, r.compacting = "", false, false
	waiters := r.turnWaiters
	r.turnWaiters = nil
	for _, fn := range waiters {
		fn("")
	}
}

type codexSession struct {
	ctx       ThreadContext
	o         CodexOptions
	run       *codexRun
	last      *codexRun
	stopping  stopper
	stale     bool
	stopTimer *loopTimer
	tmp       string
	closed    bool
}

// ---------- the core's side ----------

func (s *codexSession) Start(messages []Message) {
	if len(messages) == 1 && strings.TrimSpace(messages[0].Text) == "/compact" && len(messages[0].Attachments) == 0 {
		s.Compact()
		return
	}
	s.turnStart(s.ensure(true), messages)
}

func (s *codexSession) Compact() {
	run := s.ensure(true)
	run.starting, run.compacting = true, true
	run.whenReady(func(threadID string, err error) {
		if err != nil {
			s.turnFailed(run, err)
			return
		}
		run.rpc.request("thread/compact/start", map[string]any{"threadId": threadID}, nil, nil, func(e error) { s.turnFailed(run, e) })
	})
}

func (s *codexSession) RewindPoint(sessions []*protocol.TurnSession, index int) (RewindPoint, error) {
	return RevertPoint(sessions, index)
}

func (s *codexSession) Steer(m Message) {
	run := s.live()
	// With no process, there's no turn to steer: the message stays queued, and the turn's end
	// carries it over.
	if run == nil {
		return
	}
	input := s.input([]Message{m})
	sent := s.sentAs(run, []string{m.ID}, input)
	run.withTurn(func(turnID string) {
		if turnID == "" {
			s.refused(run, sent)
			return
		}
		params := map[string]any{"threadId": run.threadID, "expectedTurnId": turnID, "input": input}
		// The turn ended first: the message is still queued, and goes with the next.
		run.rpc.request("turn/steer", params, map[string]any{"sent": sent}, nil, func(error) { s.refused(run, sent) })
	})
}

func (s *codexSession) CarryOver(messages []Message) {
	run := s.live()
	if run == nil || s.stale {
		// The next turn runs with the options as they are now, so in a new process if they changed.
		if run != nil {
			s.stop(run, true, true, nil)
		}
		s.Start(messages)
		return
	}
	s.turnStart(run, messages)
}

func (s *codexSession) Interrupt() {
	run := s.live()
	if run == nil {
		return
	}
	s.stopAfter(run, orDuration(s.o.StopGrace, 10*time.Second))
	turn := s.ctx.TurnID()
	send := func(error) {
		if s.live() != run || run.detached || s.ctx.TurnID() != turn {
			return
		}
		run.withTurn(func(turnID string) {
			if turnID != "" && !run.exited {
				run.rpc.request("turn/interrupt", map[string]any{"threadId": run.threadID, "turnId": turnID}, nil, nil, nil)
			}
		})
	}
	// A run that outlives the backend is saved first, its turn interrupted and when it's stopped if
	// the turn doesn't end: after a restart, one that Codex ignores the interrupt in is still stopped.
	if _, durable := s.ctx.Spawner().(DurableSpawner); durable {
		s.ctx.Persist(send)
		return
	}
	send(nil)
}

// stopAfter stops the run if the turn running now hasn't ended in d.
func (s *codexSession) stopAfter(run *codexRun, d time.Duration) {
	turn := s.ctx.TurnID()
	s.clearStop()
	s.stopTimer = startTimer(s.ctx, d, func() {
		s.stopTimer = nil
		if s.ctx.TurnID() == turn && !run.exited {
			s.stop(run, false, false, nil)
		}
	})
}

func (s *codexSession) clearStop() {
	s.stopTimer.stop()
	s.stopTimer = nil
}

func (s *codexSession) OptionsChanged() { s.stale = true }

func (s *codexSession) Live() bool { return s.live() != nil }

func (s *codexSession) Release() {
	run := s.live()
	if run == nil {
		return
	}
	// A process that has the messages is stopped, so it can't act on them unseen.
	for _, m := range s.ctx.Queued() {
		if run.held[m.ID] {
			s.stop(run, true, true, nil)
			return
		}
	}
}

func (s *codexSession) Close(done func()) {
	s.closed = true
	s.clearStop()
	finish := func() {
		s.stopping.then(func() {
			if s.tmp != "" {
				os.RemoveAll(s.tmp)
				s.tmp = ""
			}
			done()
		})
	}
	if run := s.run; run != nil {
		s.stop(run, false, false, finish)
		return
	}
	finish()
}

func (s *codexSession) Checkpoint() *RunCheckpoint {
	// The last run, until another starts: one that has exited is saved once more, as it ended.
	run := s.run
	if run == nil {
		run = s.last
	}
	if run == nil || run.retired || run.proc == nil {
		return nil
	}
	dp, ok := run.proc.(DurableProcess)
	if !ok {
		return nil
	}
	// While it's starting there's nothing to carry on with: a restart then stops it.
	var state any
	if st := run.state(); st != nil {
		st.Stale = s.stale
		st.StopAt = s.stopTimer.pending()
		state = st
	}
	input := dp.InputOffset()
	return &RunCheckpoint{ID: run.id, Offset: dp.Offset(), Dir: dp.Dir(), Input: &input, State: state, Ended: run.exited}
}

func (s *codexSession) Reattach(record RunRecord) bool {
	var data struct {
		State *codexRunState `json:"state"`
	}
	json.Unmarshal(record.Data, &data)
	st := data.State
	ctx := s.ctx
	spawner, ok := ctx.Spawner().(DurableSpawner)
	if st == nil || st.V != 1 || !ok || s.run != nil {
		return false
	}
	run := newCodexRun(record.ID)
	run.restore(*st)
	run.rpc = newRPC(run.write)
	// Our requests still unanswered: their answers do what they would have.
	run.rpc.restore(st.RPC, func(p rpcPendingState) (func(jmap), func(error)) {
		var meta struct {
			Sent *codexSent `json:"sent"`
		}
		json.Unmarshal(p.Meta, &meta)
		var mine *codexSent
		if meta.Sent != nil {
			for _, x := range run.sent {
				if x.Key == meta.Sent.Key && strings.Join(x.IDs, ",") == strings.Join(meta.Sent.IDs, ",") {
					mine = x
					break
				}
			}
		}
		refused := func() {
			if mine != nil {
				s.refused(run, mine)
			}
		}
		switch p.Method {
		case "turn/start":
			return func(r jmap) {
				if id := r.obj("turn").str("id"); id != "" && run.starting && run.turnID == "" {
					run.setTurn(id)
				}
			}, func(e error) { refused(); s.turnFailed(run, e) }
		case "turn/steer":
			return func(jmap) {}, func(error) { refused() }
		case "thread/compact/start":
			return func(jmap) {}, func(e error) { s.turnFailed(run, e) }
		}
		return func(jmap) {}, func(error) {}
	})
	s.run = run
	proc, err := spawner.Attach(record, s.handlers(run), ctx.Post)
	if err != nil {
		s.run = nil
		ctx.Error(err)
		return false
	}
	run.proc = proc
	// The app's tools on the loopback MCP server, where Codex was told they are.
	if st.MCP != nil {
		mcp, err := serveTools(appServer, s.toolServer(run), st.MCP.Port, st.MCP.Token)
		if err != nil {
			s.notice("The app's tools aren't available to this turn any more: " + err.Error())
		} else {
			run.mcp = mcp
		}
	}
	// A process started with other options than the thread's now is replaced at the next turn.
	l := st.Launched
	s.stale = st.Stale || l == nil || *l != *launchedOf(ctx.Thread())
	// Codex's requests that were open: the user's questions are taken up again, an app tool that was
	// running is answered (not run again), and the rest are dealt with again. One answered before the
	// restart, though that wasn't saved, is closed: Codex has its answer.
	for _, key := range append([]string(nil), run.openOrder...) {
		if s.answered(run, json.RawMessage(key)) {
			run.dropOpen(key)
		} else if o := run.open[key]; o != nil {
			s.reopen(run, key, o)
		}
	}
	if st.StopAt != nil {
		s.stopAfter(run, time.Duration(max(0, *st.StopAt-time.Now().UnixMilli()))*time.Millisecond)
	}
	return true
}

func (s *codexSession) Detach() bool {
	run := s.live()
	if run == nil {
		return false
	}
	dp, ok := run.proc.(DurableProcess)
	if !ok {
		return false
	}
	s.closed = true
	// Its deadline stays in the checkpoint saved after this, for the backend that re-attaches.
	s.stopTimer.pause()
	run.detached = true
	dp.Detach()
	run.abort()
	run.mcp.close()
	return true
}

// answered says whether an answer to Codex's request id was written before the backend restarted.
func (s *codexSession) answered(run *codexRun, id json.RawMessage) bool {
	dp, ok := run.proc.(DurableProcess)
	return ok && dp.Answered(rpcIDString(id))
}

// reopen deals with a request of Codex's that was open when the backend restarted.
func (s *codexSession) reopen(run *codexRun, key string, o *codexOpen) {
	if o.Started {
		run.dropOpen(key)
		// It went with the backend, and isn't run again, since it may have done what it does.
		run.rpc.respond(o.Msg.raw("id"), map[string]any{
			"contentItems": []any{map[string]any{"type": "inputText", "text": "The app restarted while this tool was running, so it may or may not have finished."}},
			"success":      false,
		})
		return
	}
	s.request(run, o.Msg, &codexResume{turn: o.Turn, existing: run.asked[key]})
}

func (s *codexSession) dir() (string, error) {
	if s.tmp == "" {
		d, err := os.MkdirTemp("", "agent-threads-")
		if err != nil {
			return "", err
		}
		s.tmp = d
	}
	return s.tmp, nil
}

// input is messages as a turn's input: their text and attachments, one after the other.
func (s *codexSession) input(messages []Message) []map[string]any {
	out := []map[string]any{}
	for _, m := range messages {
		for _, p := range messageParts(m, s.dir) {
			switch {
			case p.kind == partText:
				out = append(out, map[string]any{"type": "text", "text": p.text, "text_elements": []any{}})
			case p.kind == partImage:
				out = append(out, map[string]any{"type": "image", "url": "data:" + p.mediaType + ";base64," + p.data})
			case p.fileKind == protocol.AttachmentKindImage:
				out = append(out, map[string]any{"type": "localImage", "path": p.path})
			default:
				out = append(out, map[string]any{"type": "text", "text": pathText(p), "text_elements": []any{}})
			}
		}
	}
	return out
}

// turnStart starts a Codex turn with the messages.
func (s *codexSession) turnStart(run *codexRun, messages []Message) {
	input := s.input(messages)
	sent := s.sentAs(run, messageIDs(messages), input)
	run.starting = true
	effort := s.ctx.Thread().Effort
	run.whenReady(func(threadID string, err error) {
		fail := func(e error) {
			s.refused(run, sent)
			s.turnFailed(run, e)
		}
		if err != nil {
			fail(err)
			return
		}
		params := map[string]any{"threadId": threadID, "input": input}
		if effort != "" {
			params["effort"] = effort
		}
		run.rpc.request("turn/start", params, map[string]any{"sent": sent}, func(r jmap) {
			if id := r.obj("turn").str("id"); id != "" && run.starting && run.turnID == "" {
				run.setTurn(id)
			}
		}, fail)
	})
}

// sentAs records that messages are being sent to the process, as this input.
func (s *codexSession) sentAs(run *codexRun, ids []string, input []map[string]any) *codexSent {
	sent := &codexSent{IDs: ids, Key: codexEchoKey(mustJSON(input))}
	run.sent = append(run.sent, sent)
	for _, id := range ids {
		run.held[id] = true
	}
	return sent
}

// refused says Codex refused messages it was sent.
func (s *codexSession) refused(run *codexRun, sent *codexSent) {
	var rest []*codexSent
	for _, x := range run.sent {
		if x != sent {
			rest = append(rest, x)
		}
	}
	run.sent = rest
	for _, id := range sent.IDs {
		still := false
		for _, x := range run.sent {
			for _, y := range x.IDs {
				still = still || y == id
			}
		}
		if !still {
			delete(run.held, id)
		}
	}
}

// turnFailed ends a turn that couldn't be started, with the error.
func (s *codexSession) turnFailed(run *codexRun, err error) {
	if run.exited || run.retired || run != s.run {
		return
	}
	at := run.turnID
	run.turnEnded()
	if s.ctx.TurnID() != "" {
		s.ctx.EndTurn(TurnEnd{Error: err.Error(), SessionAt: at})
	}
}

// ---------- the process ----------

func (s *codexSession) live() *codexRun {
	if r := s.run; r != nil && !r.exited && !r.retired {
		return r
	}
	return nil
}

// ensure is the running process, or a new one. A new turn (fresh) restarts it if the options changed.
func (s *codexSession) ensure(fresh bool) *codexRun {
	live := s.live()
	if live != nil && !(fresh && s.stale) {
		return live
	}
	if live != nil {
		s.stop(live, true, false, nil)
	}
	s.stale = false
	run := newCodexRun("")
	s.run = run
	run.rpc = newRPC(run.write)
	s.stopping.then(func() { s.spawn(run) })
	return run
}

// stop stops a run: it closes its input, then signals it if it doesn't exit; or signals it
// straight away (now), when it has messages that are going to another process instead.
func (s *codexSession) stop(run *codexRun, retire, now bool, done func()) {
	if retire {
		run.retired = true
	}
	if done != nil {
		run.whenDone(done)
	}
	if run.exited || run.finished {
		return
	}
	stopRun(s.ctx, run.proc, orDuration(s.o.CloseGrace, 5*time.Second), now, run.whenDone)
	if retire {
		s.stopping.add(run)
		run.whenDone(func() { s.stopping.done(run) })
	}
}

// spawn starts the process and the thread: initialize, skills, thread/start or thread/resume.
func (s *codexSession) spawn(run *codexRun) {
	if s.closed || run.retired {
		run.exited = true
		run.finish()
		run.setReady("", errors.New("the session is closed"))
		return
	}
	ctx := s.ctx
	var home string
	var err error
	if s.o.UserConfig {
		home = userCodexHome()
	} else {
		h := s.o.Home
		if h == "" {
			h = defaultCodexHome()
		}
		login := s.o.Login
		if login == "" && !s.o.NoLogin {
			login = userCodexHome()
		}
		if s.o.NoLogin {
			login = ""
		}
		home, err = prepareCodexHome(h, login)
	}
	if err != nil {
		s.exited(run, ExitStatus{Err: err})
		run.setReady("", err)
		return
	}
	bin := s.o.Bin
	if bin == "" {
		bin = "codex"
	}
	args := append(append(append([]string{}, s.o.BinArgs...), "app-server"), s.o.Args...)
	env := mergeEnv(mergeEnv(os.Environ(), s.o.Env), map[string]string{"CODEX_HOME": home})
	proc, err := ctx.Spawner().Spawn(SpawnOptions{
		Command: bin, Args: args, Cwd: ctx.Thread().Cwd, Env: env, ThreadID: ctx.ThreadID(), RunID: run.id, Post: ctx.Post,
	}, s.handlers(run))
	if err != nil {
		s.exited(run, ExitStatus{Err: err})
		run.setReady("", err)
		return
	}
	run.proc = proc
	run.launched = launchedOf(ctx.Thread())
	ctx.SetThread(func(t *protocol.Thread) {
		t.Run = &protocol.Run{ID: run.id, Spawner: protocol.RunSpawner(ctx.Spawner().Name()), StartedAt: now()}
	})

	// The thread can't run: the process is stopped (and its end ends nothing), and the turn ends with why.
	fail := func(e error) {
		if !run.exited && run == s.run && !run.retired {
			s.stop(run, true, true, nil)
			if ctx.TurnID() != "" {
				ctx.EndTurn(TurnEnd{Error: "Codex couldn't start the thread: " + e.Error()})
			}
		}
		run.setReady("", e)
	}
	started := func(r jmap) {
		run.threadID = r.obj("thread").str("id")
		// A rewind's resume_at was for the session it had, which this isn't if it couldn't be resumed.
		if ctx.Thread().SessionID != run.threadID {
			ctx.SetThread(func(t *protocol.Thread) { t.SessionID, t.ResumeAt = run.threadID, "" })
		}
		run.setReady(run.threadID, nil)
	}
	afterSkills := func() {
		run.home = home
		listed := func(hidden []string) {
			run.hiddenSkills = hidden
			s.startThread(run, started, fail)
		}
		if s.o.UserConfig {
			listed(nil)
			return
		}
		s.ambientSkills(run, listed, fail)
	}
	run.rpc.request("initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "agent-threads", "title": "agent-threads", "version": "0.0.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, nil, func(jmap) {
		run.rpc.notify("initialized", nil)
		skills := ctx.Config().Skills
		if len(skills) == 0 {
			afterSkills()
			return
		}
		dir, err := s.dir()
		if err == nil {
			run.skillsDir, err = writeSkills(filepath.Join(dir, "skills-"+run.id), skills)
		}
		if err != nil {
			fail(err)
			return
		}
		run.rpc.request("skills/extraRoots/set", map[string]any{"extraRoots": []string{run.skillsDir}}, nil, func(jmap) { afterSkills() }, func(e error) {
			s.notice("Codex couldn't load the app's skills: " + e.Error())
			afterSkills()
		})
	}, fail)
}

// ambientSkills is the skills Codex finds that aren't the app's: the user's ($HOME/.agents/skills...),
// the project's and the machine's, which a separate CODEX_HOME doesn't keep it from loading. (Its own
// built-in ones stay.)
func (s *codexSession) ambientSkills(run *codexRun, done func([]string), fail func(error)) {
	cwds := []string{}
	if cwd := s.ctx.Thread().Cwd; cwd != "" {
		cwds = append(cwds, cwd)
	}
	run.rpc.request("skills/list", map[string]any{"cwds": cwds, "forceReload": true}, nil, func(r jmap) {
		// Codex reports paths with symlinks resolved (the temporary directory often is one: /var on
		// macOS), so the app's are told apart by their real paths.
		own := ""
		if run.skillsDir != "" {
			own = canonicalPath(run.skillsDir) + string(filepath.Separator)
		}
		seen := map[string]bool{}
		hidden := []string{}
		for _, entry := range r.arr("data") {
			for _, raw := range parseObj(entry).arr("skills") {
				sk := parseObj(raw)
				path := sk.str("path")
				if sk.str("scope") == "system" || (own != "" && strings.HasPrefix(canonicalPath(path), own)) || seen[path] {
					continue
				}
				seen[path] = true
				hidden = append(hidden, path)
			}
		}
		done(hidden)
	}, func(e error) {
		fail(fmt.Errorf("Codex couldn't list its skills, to leave out the user's: %w", e))
	})
}

var resumeMissing = regexp.MustCompile(`(?i)not found|no rollout|unknown thread|does not exist`)
var noDynamicTools = regexp.MustCompile(`(?i)dynamic.?tools|experimental`)

// startThread is thread/resume for a thread that has a session, or thread/start (also if Codex hasn't
// the session).
func (s *codexSession) startThread(run *codexRun, ok func(jmap), fail func(error)) {
	session := s.ctx.Thread().SessionID
	if session == "" {
		s.newThread(run, ok, fail)
		return
	}
	// Codex keeps the dynamic tools the session started with, and resuming can't change them.
	if state := readSessionState(run.home, session); state != nil {
		run.dynamic = state.DynamicTools
	} else {
		run.dynamic = nil
	}
	params, err := s.threadParams(run, false)
	if err != nil {
		fail(err)
		return
	}
	params["threadId"] = session
	params["excludeTurns"] = true
	resumed := func(r jmap) {
		// After a rewind: the session as it was before the turn it went back to before.
		at := s.ctx.Thread().ResumeAt
		if at == "" {
			ok(r)
			return
		}
		run.rpc.request("thread/revert", map[string]any{"threadId": session, "beforeTurnId": at}, nil, func(jmap) {
			if s.ctx.Thread().ResumeAt == at {
				s.ctx.SetThread(func(t *protocol.Thread) { t.ResumeAt = "" })
			}
			ok(r)
		}, fail)
	}
	run.rpc.request("thread/resume", params, nil, resumed, func(e error) {
		var re *rpcError
		if !errors.As(e, &re) || !resumeMissing.MatchString(re.message) {
			fail(e)
			return
		}
		s.notice(fmt.Sprintf("Codex couldn't resume its session (%s), so this is a new one: it doesn't remember the thread so far.", re.message))
		s.newThread(run, ok, fail)
	})
}

// newThread is thread/start: a new session, with the app's tools as dynamic tools (or on the MCP server).
func (s *codexSession) newThread(run *codexRun, ok func(jmap), fail func(error)) {
	run.dynamic = []toolSpec{}
	if !s.o.AppToolsOverMCP {
		for _, t := range s.ctx.Config().Tools {
			run.dynamic = append(run.dynamic, specOf(t))
		}
	}
	started := func(r jmap) {
		s.saveState(run, r.obj("thread").str("id"))
		ok(r)
	}
	start := func(retry func(error)) {
		params, err := s.threadParams(run, true)
		if err != nil {
			fail(err)
			return
		}
		run.rpc.request("thread/start", params, nil, started, retry)
	}
	start(func(e error) {
		// A Codex without dynamic tools gets the app's tools on the MCP server instead.
		var re *rpcError
		if len(run.dynamic) == 0 || !errors.As(e, &re) || !noDynamicTools.MatchString(re.message) {
			fail(e)
			return
		}
		run.dynamic = []toolSpec{}
		start(fail)
	})
}

// saveState records the session's dynamic tools, where they're known.
func (s *codexSession) saveState(run *codexRun, session string) {
	if run.dynamic == nil {
		return
	}
	if err := writeSessionState(run.home, session, codexSessionState{DynamicTools: run.dynamic}); err != nil {
		s.ctx.Error(err)
	}
}

// mcpTools is the app's tools that go on the MCP server: those the session hasn't as dynamic tools,
// as they are now.
func (s *codexSession) mcpTools(run *codexRun) []Tool {
	var out []Tool
	for _, t := range s.ctx.Config().Tools {
		if spec, ok := run.dynamicTool(t.Name()); ok && run.dynamic != nil && sameSpec(spec, specOf(t)) {
			continue
		}
		out = append(out, t)
	}
	return out
}

func (s *codexSession) toolServer(run *codexRun) toolServerHandlers {
	return toolServerHandlers{
		tools: func(ctx context.Context) []Tool {
			var out []Tool
			onLoop(ctx, s.ctx, func() { out = s.mcpTools(run) })
			return out
		},
		call: func(ctx context.Context, name string, args json.RawMessage) ToolOutput {
			result := make(chan ToolOutput, 1)
			s.ctx.Post(func() { s.mcpAppTool(run, name, args, func(out ToolOutput) { result <- out }) })
			select {
			case out := <-result:
				return out
			case <-ctx.Done():
				return ToolOutput{Text: "The app stopped before the tool finished.", IsError: true}
			}
		},
	}
}

// onLoop runs fn on the thread's goroutine and waits for it (or ctx).
func onLoop(ctx context.Context, tc ThreadContext, fn func()) {
	done := make(chan struct{})
	tc.Post(func() {
		fn()
		close(done)
	})
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// threadParams is thread/start's (fresh) or thread/resume's parameters.
func (s *codexSession) threadParams(run *codexRun, fresh bool) (map[string]any, error) {
	ctx := s.ctx
	t := ctx.Thread()
	cfg := ctx.Config()
	servers := map[string]any{}
	for _, name := range sortedKeys(cfg.MCPServers) {
		c, unsupported := mcpServerConfig(cfg.MCPServers[name])
		if unsupported == "" {
			servers[name] = c
		} else if !run.noticedServers {
			s.notice(fmt.Sprintf("The MCP server %s isn't available: %s.", name, unsupported))
		}
	}
	run.noticedServers = true
	run.mcpApp = len(s.mcpTools(run)) > 0
	if run.mcpApp {
		if run.mcp == nil {
			mcp, err := serveTools(appServer, s.toolServer(run), 0, "")
			if err != nil {
				return nil, err
			}
			run.mcp = mcp
			run.mcpEndpoint = &mcpEndpoint{Port: mcp.port, Token: mcp.token}
		}
		// The policy decides on the app's tools when they're called, so Codex needn't ask.
		servers[appServer] = map[string]any{
			"url": run.mcp.url, "http_headers": map[string]string{"Authorization": "Bearer " + run.mcp.token},
			"default_tools_approval_mode": "approve", "tool_timeout_sec": appToolTimeoutSec,
		}
	}
	config := map[string]any{}
	for k, v := range s.o.Config {
		config[k] = v
	}
	// So the agent can ask the user questions outside plan mode.
	config["features.default_mode_request_user_input"] = true
	config["suppress_unstable_features_warning"] = true
	if len(servers) > 0 {
		config["mcp_servers"] = servers
	}
	if len(run.hiddenSkills) > 0 {
		var list []any
		for _, p := range run.hiddenSkills {
			list = append(list, map[string]any{"path": p, "enabled": false})
		}
		config["skills"] = map[string]any{"config": list}
	}
	approval, sandbox := codexPolicy(t.PermissionMode)
	params := map[string]any{"approvalPolicy": approval, "sandbox": sandbox, "config": config}
	if t.Cwd != "" {
		params["cwd"] = t.Cwd
	}
	if t.Model != "" {
		params["model"] = t.Model
	}
	if fresh && len(run.dynamic) > 0 {
		var tools []any
		for _, d := range run.dynamic {
			tools = append(tools, map[string]any{"type": "function", "name": d.Name, "description": d.Description, "inputSchema": d.InputSchema})
		}
		params["dynamicTools"] = tools
	}
	if cfg.SystemPrompt != "" {
		params["developerInstructions"] = cfg.SystemPrompt
	}
	return params, nil
}

func (s *codexSession) handlers(run *codexRun) ProcessHandlers {
	return ProcessHandlers{
		Line: func(line string) { s.line(run, line) },
		Stderr: func(line string) {
			run.stderr = append(run.stderr, line)
			if len(run.stderr) > 20 {
				run.stderr = run.stderr[1:]
			}
		},
		Exit: func(status ExitStatus) { s.exited(run, status) },
		Unanswered: func() []string {
			out := make([]string, len(run.openOrder))
			for i, k := range run.openOrder {
				out[i] = rpcIDString(json.RawMessage(k))
			}
			return out
		},
	}
}

// rpcIDString is a JSON-RPC id as the shim compares answers: a string's text, a number's digits.
func rpcIDString(id json.RawMessage) string {
	if isStr(id) {
		return rawStr(id)
	}
	return string(id)
}

func (s *codexSession) exited(run *codexRun, status ExitStatus) {
	if run.exited || run.detached {
		return
	}
	run.exited = true
	run.abort()
	run.rpc.close(errors.New(codexExitError(status, run.stderr, false)))
	at := run.turnID
	run.turnEnded()
	run.mcp.close()
	if run.skillsDir != "" {
		os.RemoveAll(run.skillsDir)
	}
	ctx := s.ctx
	if s.run == run {
		s.run = nil
		s.last = run
	}
	if r := ctx.Thread().Run; r != nil && r.ID == run.id {
		ctx.SetThread(func(t *protocol.Thread) { t.Run = nil })
	}
	// A run that ends while its turn is running ends the turn (as interrupted, if it was).
	if !run.retired && ctx.TurnID() != "" {
		s.clearStop()
		ctx.EndTurn(TurnEnd{Error: codexExitError(status, run.stderr, true), SessionAt: at})
	}
	run.finish()
}

func (s *codexSession) notice(text string) {
	s.ctx.AddItem(&protocol.Notice{ID: NewID("n"), Level: protocol.NoticeLevelWarning, Text: text})
}

// ---------- what Codex says ----------

func (s *codexSession) line(run *codexRun, line string) {
	m := parseObj([]byte(line))
	if m == nil {
		return // Not a message: the app server writes only JSON-RPC to stdout, but be safe.
	}
	if run.rpc.take(m) {
		return
	}
	if run.retired || run != s.run {
		// A run being stopped: its requests go unanswered.
		if id := m.raw("id"); id != nil {
			run.rpc.respondError(id, "this session is being stopped", -32000)
		}
		return
	}
	if id := m.raw("id"); id != nil {
		// A request read again after a restart, and answered before it (though that wasn't saved):
		// Codex has its answer, and the user isn't asked again.
		if !s.answered(run, id) {
			s.request(run, m, nil)
		}
	} else {
		s.notification(run, m)
	}
}

// parent is the subagent call a message from a child thread belongs to: "" and own for the thread's
// own, and !known for a thread it doesn't know.
func (s *codexSession) parent(run *codexRun, threadID json.RawMessage) (parent string, own, known bool) {
	if !isStr(threadID) || run.threadID == "" || rawStr(threadID) == run.threadID {
		return "", true, true
	}
	p, ok := run.children[rawStr(threadID)]
	return p, false, ok
}

func (s *codexSession) notification(run *codexRun, m jmap) {
	ctx := s.ctx
	p := orObj(m.obj("params"))
	parent, own, known := s.parent(run, p.raw("threadId"))
	if !known {
		return // A thread it doesn't know.
	}
	switch method := m.str("method"); method {
	case "item/started", "item/completed":
		child := ""
		if !own {
			child = p.str("threadId")
		}
		s.item(run, p.obj("item"), method == "item/completed", parent, child)
	case "item/agentMessage/delta", "item/plan/delta":
		s.delta(run, p.str("itemId"), protocol.DeltaEventKindText, p.raw("delta"), parent)
	case "item/reasoning/summaryTextDelta":
		// Summary parts are joined by a blank line, as the completed item's text is.
		itemID := p.str("itemId")
		index, hasIndex := p.int("summaryIndex")
		if part, ok := run.summaryPart[itemID]; ok && hasIndex && int(index) > part && p.str("delta") != "" {
			s.delta(run, itemID, protocol.DeltaEventKindReasoning, mustJSON("\n\n"), parent)
		}
		if hasIndex {
			run.summaryPart[itemID] = int(index)
		}
		s.delta(run, itemID, protocol.DeltaEventKindReasoning, p.raw("delta"), parent)
	case "item/reasoning/textDelta":
		s.delta(run, p.str("itemId"), protocol.DeltaEventKindReasoning, p.raw("delta"), parent)
	case "turn/plan/updated":
		s.plan(p, parent)
	case "turn/started":
		if id := p.obj("turn").str("id"); own && id != "" {
			run.starting = true
			run.errText = nil
			run.setTurn(id)
			run.used = zeroUsage()
		}
	case "turn/completed":
		if own {
			s.turnCompleted(run, p.obj("turn"))
		} else {
			s.childDone(run, p.str("threadId"), p.obj("turn"), parent)
		}
	case "thread/tokenUsage/updated":
		if !own || !p.has("tokenUsage") {
			break
		}
		run.reported = true
		// A report outside a turn (a resumed session's totals, say) isn't any turn's.
		if last := p.obj("tokenUsage").raw("last"); run.used != nil && last != nil {
			var t codexTokens
			if json.Unmarshal(last, &t) == nil {
				run.used = addUsage(run.used, callUsage(t))
			}
		}
	case "warning":
		if own && p.str("threadId") != "" && p.str("message") != "" {
			s.notice(p.str("message"))
		}
	case "error":
		if !own {
			return
		}
		msg := p.obj("error").str("message")
		if p.bool("willRetry") {
			if msg == "" {
				msg = "Codex is retrying."
			}
			ctx.AddItem(&protocol.Notice{ID: NewID("n"), Level: protocol.NoticeLevelWarning, Code: "retry", Text: msg})
		} else if p.obj("error").has("message") {
			run.errText = &msg
		} else {
			run.errText = nil
		}
	case "mcpServer/startupStatus/updated":
		name := p.str("name")
		_, configured := ctx.Config().MCPServers[name]
		if own && p.str("status") == "failed" && (configured || name == appServer) {
			text := fmt.Sprintf("The MCP server %s didn't start.", name)
			if e := p.str("error"); e != "" {
				text = fmt.Sprintf("The MCP server %s didn't start: %s", name, e)
			}
			s.notice(text)
		}
	case "serverRequest/resolved":
		// Codex no longer wants an answer (it answered itself, or gave up).
		key := canonical(p.raw("requestId"))
		if !run.dropOpen(key) {
			return
		}
		if id := run.asked[key]; id != "" {
			ctx.CancelRequest(id)
		}
	}
}

func (s *codexSession) delta(run *codexRun, itemID string, kind protocol.DeltaEventKind, text json.RawMessage, parent string) {
	if !isStr(text) || rawStr(text) == "" {
		return
	}
	if !run.streamed[itemID] {
		run.streamed[itemID] = true
		if kind == protocol.DeltaEventKindText {
			s.ctx.AddItem(&protocol.AssistantMessage{ID: itemID, Text: "", ParentID: parent})
		} else {
			s.ctx.AddItem(&protocol.Reasoning{ID: itemID, Text: "", ParentID: parent})
		}
	}
	s.ctx.Delta(itemID, kind, rawStr(text))
}

func (s *codexSession) item(run *codexRun, item jmap, done bool, parent, child string) {
	ctx := s.ctx
	if item == nil {
		return
	}
	id := item.str("id")
	switch typ := item.str("type"); typ {
	case "userMessage":
		// A message taken in; a child's first one is its prompt, which isn't an item.
		if child == "" && !done {
			s.tookIn(run, codexEchoKey(item.raw("content")))
		}
		return
	case "agentMessage", "plan", "reasoning":
		if !done {
			return
		}
		var text string
		if typ == "reasoning" {
			var summary, content []string
			json.Unmarshal(item.raw("summary"), &summary)
			json.Unmarshal(item.raw("content"), &content)
			text = strings.Join(summary, "\n\n")
			if text == "" {
				text = strings.Join(content, "\n\n")
			}
		} else {
			text = item.str("text")
		}
		if child != "" && typ == "agentMessage" {
			run.lastChild[child] = text
		}
		if run.streamed[id] {
			ctx.UpdateItem(id, Patch{"text": text})
		} else if text != "" {
			if typ == "reasoning" {
				ctx.AddItem(&protocol.Reasoning{ID: id, Text: text, ParentID: parent})
			} else {
				ctx.AddItem(&protocol.AssistantMessage{ID: id, Text: text, ParentID: parent})
			}
		}
		return
	case "collabAgentToolCall":
		if item.str("tool") != "spawnAgent" {
			return // wait, sendInput... aren't items of their own.
		}
		if !done {
			if _, ok := ctx.Item(id); !ok {
				prompt := item.str("prompt")
				ctx.AddItem(&protocol.ToolCall{ID: id, Name: "spawnAgent", Kind: protocol.ToolKindSubagent, Input: mustJSON(map[string]any{"prompt": prompt}), Status: protocol.ToolStatusRunning, Title: prompt, ParentID: parent})
			}
			return
		}
		var receivers []string
		json.Unmarshal(item.raw("receiverThreadIds"), &receivers)
		for _, t := range receivers {
			run.children[t] = id
		}
		if item.str("status") == "failed" {
			ctx.UpdateItem(id, Patch{"status": protocol.ToolStatusFailed})
		}
		return
	case "contextCompaction":
		if _, ok := ctx.Item(id); !done && !ok {
			trigger := protocol.CompactionTriggerAuto
			if run.compacting {
				trigger = protocol.CompactionTriggerManual
			}
			ctx.AddItem(&protocol.Compaction{ID: id, Trigger: trigger, ParentID: parent})
		}
		return
	}
	if !isToolItem(item.str("type")) {
		return
	}
	fields := codexTool(item, run.mcpApp)
	if item.str("type") == "mcpToolCall" {
		var calls []mcpCall
		for _, c := range run.mcpCalls {
			if c.ID != id {
				calls = append(calls, c)
			}
		}
		run.mcpCalls = calls
		if !done {
			thread := child
			if thread == "" {
				thread = run.threadID
			}
			run.mcpCalls = append(run.mcpCalls, mcpCall{ID: id, Server: item.str("server"), Name: item.str("tool"), Args: orEmpty(item.raw("arguments")), Thread: thread})
		}
	}
	it, exists := ctx.Item(id)
	fields.ID, fields.Status, fields.ParentID = id, protocol.ToolStatusRunning, parent
	if !done {
		if !exists {
			ctx.AddItem(fields)
		}
		return
	}
	if !exists {
		// Added complete: the call with its end applied.
		data, _ := json.Marshal(fields)
		var all map[string]any
		json.Unmarshal(data, &all)
		for k, v := range codexDone(item, false) {
			all[k] = v
		}
		var c protocol.ToolCall
		json.Unmarshal(mustJSON(all), &c)
		ctx.AddItem(&c)
		return
	}
	call, _ := it.Value.(*protocol.ToolCall)
	ctx.UpdateItem(id, codexDone(item, call != nil && call.Status == protocol.ToolStatusDenied))
}

// plan is a plan update: the turn's todo list, one item per turn and thread.
func (s *codexSession) plan(p jmap, parent string) {
	ctx := s.ctx
	id := fmt.Sprintf("plan-%s-%s", p.str("threadId"), p.str("turnId"))
	in := map[string]any{"plan": p.raw("plan")}
	if e := p.str("explanation"); e != "" {
		in["explanation"] = e
	}
	input := mustJSON(in)
	todos := codexTodos(p.arr("plan"))
	if _, ok := ctx.Item(id); ok {
		ctx.UpdateItem(id, Patch{"input": input, "todos": todos})
		return
	}
	ctx.AddItem(&protocol.ToolCall{ID: id, Name: "update_plan", Kind: protocol.ToolKindTodo, Input: input, Todos: todos, Status: protocol.ToolStatusCompleted, ParentID: parent})
}

func (s *codexSession) tookIn(run *codexRun, key string) {
	var match *codexSent
	for _, x := range run.sent {
		if x.Key == key {
			match = x
			break
		}
	}
	if match == nil {
		return
	}
	ids := map[string]bool{}
	for _, id := range match.IDs {
		ids[id] = true
	}
	// Sent more than once (steered, then carried over), they're all taken in now.
	var rest []*codexSent
	for _, x := range run.sent {
		shared := false
		for _, id := range x.IDs {
			shared = shared || ids[id]
		}
		if !shared {
			rest = append(rest, x)
		}
	}
	run.sent = rest
	for _, id := range match.IDs {
		delete(run.held, id)
		s.ctx.TookIn(id)
	}
}

func (s *codexSession) turnCompleted(run *codexRun, turn jmap) {
	ctx := s.ctx
	errText := run.errText
	at := turn.str("id")
	if at == "" {
		at = run.turnID
	}
	run.turnEnded()
	run.errText = nil
	// The turn's requests are moot now; its open ones are cancelled with it.
	run.open, run.openOrder = map[string]*codexOpen{}, nil
	var usage *protocol.Usage
	if run.reported {
		usage = run.used
		if usage == nil {
			usage = zeroUsage()
		}
	}
	run.used = nil
	if ctx.TurnID() == "" {
		return
	}
	s.clearStop()
	end := TurnEnd{OK: turn.str("status") == "completed", Usage: usage, SessionAt: at}
	if turn.str("status") == "failed" {
		end.Error = turn.obj("error").str("message")
		if end.Error == "" && errText != nil {
			end.Error = *errText
		}
		if end.Error == "" {
			end.Error = "The turn failed."
		}
	}
	if d, ok := turn.num("durationMs"); ok {
		n := int64(d)
		end.DurationMs = &n
	}
	ctx.EndTurn(end)
}

// childDone says a subagent's turn ended: so did its call, with the subagent's last message.
func (s *codexSession) childDone(run *codexRun, child string, turn jmap, callID string) {
	status := protocol.ToolStatusFailed
	switch turn.str("status") {
	case "completed":
		status = protocol.ToolStatusCompleted
	case "interrupted":
		status = protocol.ToolStatusCancelled
	}
	content := run.lastChild[child]
	if status == protocol.ToolStatusFailed {
		if msg := turn.obj("error").str("message"); turn.obj("error").has("message") {
			content = msg
		}
	}
	s.ctx.UpdateItem(callID, Patch{"status": status, "result": protocol.ToolResult{Content: content}})
}

// ---------- the server's requests ----------

// codexResume is a request that was open when the backend restarted: the turn it came in, and the
// request the user was asked with, which is taken up again.
type codexResume struct {
	turn, existing string
}

func (s *codexSession) request(run *codexRun, m jmap, resume *codexResume) {
	id := m.raw("id")
	key := canonical(id)
	p := orObj(m.obj("params"))
	parent, _, _ := s.parent(run, p.raw("threadId"))
	ctx := s.ctx
	turn := ctx.TurnID()
	existing := ""
	if resume != nil {
		turn, existing = resume.turn, resume.existing
	}
	run.setOpen(key, &codexOpen{Turn: turn, Msg: m})
	// Whether Codex still wants this answered: not resolved, its turn not over, its run not gone. (Not
	// once it's left running as the backend shuts down: what's open stays as it was saved.)
	wanted := func() bool {
		_, open := run.open[key]
		return open && !run.exited && !run.retired && !run.detached && s.run == run && ctx.TurnID() == turn
	}
	answer := func(result any) {
		if !wanted() {
			return
		}
		run.dropOpen(key)
		run.rpc.respond(id, result)
	}
	decision := func(ok bool) any {
		if ok {
			return map[string]any{"decision": "accept"}
		}
		return map[string]any{"decision": "decline"}
	}
	switch method := m.str("method"); method {
	case "item/commandExecution/requestApproval":
		itemID := p.str("itemId")
		t, ok := s.callFields(itemID)
		if !ok {
			t = &protocol.ToolCall{Name: "commandExecution", Kind: protocol.ToolKindShell, Input: rawObject("command", p.raw("command"), "cwd", p.raw("cwd")), Command: unwrapCommand(p.str("command"))}
		}
		s.permit(run, key, s.query(t, itemID, p.str("reason"), parent), wanted, func(ok bool, _ string) { answer(decision(ok)) }, existing)
	case "item/fileChange/requestApproval":
		itemID := p.str("itemId")
		t, ok := s.callFields(itemID)
		if !ok {
			grant := p.raw("grantRoot")
			if grant == nil {
				grant = json.RawMessage("null")
			}
			t = &protocol.ToolCall{Name: "fileChange", Kind: protocol.ToolKindEdit, Input: mustJSON(map[string]any{"grantRoot": grant})}
		}
		s.permit(run, key, s.query(t, itemID, p.str("reason"), parent), wanted, func(ok bool, _ string) { answer(decision(ok)) }, existing)
	case "item/permissions/requestApproval":
		title := p.str("reason")
		if title == "" {
			title = "More permissions"
		}
		in := map[string]any{"permissions": p.raw("permissions"), "cwd": p.raw("cwd")}
		if r := p.str("reason"); r != "" {
			in["reason"] = r
		}
		t := &protocol.ToolCall{Name: "permissions", Kind: protocol.ToolKindOther, Input: mustJSON(in), Title: title}
		s.permit(run, key, s.query(t, p.str("itemId"), p.str("reason"), parent), wanted, func(ok bool, _ string) {
			perms := json.RawMessage("{}")
			if ok {
				perms = orEmpty(p.raw("permissions"))
			}
			answer(map[string]any{"permissions": perms, "scope": "turn"})
		}, existing)
	case "mcpServer/elicitation/request":
		s.elicitation(run, key, p, wanted, answer, parent, existing)
	case "item/tool/requestUserInput":
		s.userInput(run, key, p, answer, parent, existing)
	case "item/tool/call":
		s.dynamicCall(run, key, p, wanted, answer, parent, existing)
	default:
		run.dropOpen(key)
		run.rpc.respondError(id, "agent-threads doesn't handle "+method, -32601)
	}
}

// callFields is the tool_call item itemID, if the thread has it.
func (s *codexSession) callFields(itemID string) (*protocol.ToolCall, bool) {
	if itemID == "" {
		return nil, false
	}
	it, ok := s.ctx.Item(itemID)
	c, isCall := it.Value.(*protocol.ToolCall)
	return c, ok && isCall
}

// query is a permission query about a call (the item, or what the request says about it).
func (s *codexSession) query(t *protocol.ToolCall, itemID, reason, parent string) PermissionQuery {
	q := PermissionQuery{Name: t.Name, Kind: t.Kind, Input: t.Input, Title: t.Title, Server: t.Server, Reason: reason, ParentID: parent}
	if t.Kind == protocol.ToolKindShell {
		q.Command = t.Command
	}
	if q.Title == "" {
		q.Title = toolTitle(t)
	}
	if _, ok := s.ctx.Item(itemID); ok && itemID != "" {
		q.ToolCallID = itemID
	}
	return q
}

// permit asks the policy (and, if it says so, the user) about a call, and calls done with the
// answer while wanted holds. key is Codex's request it's for, if there is one.
func (s *codexSession) permit(run *codexRun, key string, q PermissionQuery, wanted func() bool, done func(ok bool, message string), existing string) {
	ctx := s.ctx
	call := q.ToolCallID
	denied := func() {
		if call != "" {
			ctx.UpdateItem(call, Patch{"status": protocol.ToolStatusDenied})
		}
	}
	// The user was asked before the backend restarted: they still are.
	d := Ask
	if existing == "" {
		d = ctx.Decide(q)
	}
	// A policy may answer after Codex stopped asking.
	if !wanted() {
		return
	}
	switch {
	case d.IsAllow():
		done(true, "")
	case d.IsAsk():
		answered := func(res protocol.Resolution) {
			if !wanted() {
				return
			}
			if res.Outcome == protocol.ResolutionOutcomeAllow {
				done(true, "")
				if call != "" {
					ctx.UpdateItem(call, Patch{"status": protocol.ToolStatusRunning})
				}
				return
			}
			msg := res.Message
			if msg == "" {
				msg = "The user didn't allow this."
			}
			done(false, msg)
			denied()
		}
		standing := permissionKey(q.Kind, q.Server, q.Name)
		id := existing
		if existing == "" || !ctx.Reopen(existing, answered, standing) {
			id = ctx.Ask(&protocol.PermissionRequest{Name: q.Name, Kind: q.Kind, Input: q.Input, Title: q.Title, Reason: q.Reason}, call, answered, standing)
		}
		if key != "" {
			run.asked[key] = id
		}
	default:
		msg := d.Message()
		if msg == "" {
			msg = "The app's permission policy doesn't allow this."
		}
		done(false, msg)
		denied()
	}
}

var namedTool = regexp.MustCompile(`tool "([^"]+)"`)

// elicitation is an MCP server asking: Codex asks this way whether a tool on it may be called.
func (s *codexSession) elicitation(run *codexRun, key string, p jmap, wanted func() bool, answer func(any), parent, existing string) {
	server := p.str("serverName")
	fields := len(p.obj("requestedSchema").obj("properties"))
	// Only an elicitation that needs nothing filled in ("may it call this tool?") can be answered.
	if p.str("mode") != "form" || fields > 0 {
		answer(map[string]any{"action": "decline"})
		return
	}
	// The app's own tools are decided on when they're called.
	if server == appServer && run.mcpApp {
		answer(map[string]any{"action": "accept", "content": map[string]any{}})
		return
	}
	// The policy is asked about the tool and arguments the elicitation names. The running call is
	// only taken to be the one it's about if it's the only one that matches it.
	message := p.str("message")
	named := ""
	if m := namedTool.FindStringSubmatch(message); m != nil {
		named = m[1]
	}
	params := p.obj("_meta").raw("tool_params")
	thread := p.str("threadId")
	if thread == "" {
		thread = run.threadID
	}
	var matching []mcpCall
	if named != "" {
		for _, c := range run.mcpCalls {
			if c.Server == server && c.Thread == thread && c.Name == named && (params == nil || sameCanonical(c.Args, params)) {
				matching = append(matching, c)
			}
		}
	}
	var it *protocol.ToolCall
	if len(matching) == 1 {
		it, _ = s.callFields(matching[0].ID)
	}
	name := named
	if name == "" {
		name = "elicitation"
	}
	t := &protocol.ToolCall{Name: name, Kind: protocol.ToolKindMCP, Server: server, Input: params}
	if params == nil {
		t.Input = json.RawMessage("{}")
		if it != nil {
			t.Input = it.Input
		}
	}
	itemID := ""
	if it != nil {
		itemID = it.ID
	} else {
		t.Title = message
	}
	s.permit(run, key, s.query(t, itemID, "", parent), wanted, func(ok bool, _ string) {
		if ok {
			answer(map[string]any{"action": "accept", "content": map[string]any{}})
		} else {
			answer(map[string]any{"action": "decline"})
		}
	}, existing)
}

// userInput is a question for the user: a request_user_input call, and a question request for it.
func (s *codexSession) userInput(run *codexRun, key string, p jmap, answer func(any), parent, existing string) {
	ctx := s.ctx
	qs := codexQuestions(p.arr("questions"))
	itemID := p.str("itemId")
	if _, ok := ctx.Item(itemID); !ok {
		questions := p.raw("questions")
		if questions == nil {
			questions = json.RawMessage("null")
		}
		ctx.AddItem(&protocol.ToolCall{ID: itemID, Name: "request_user_input", Kind: protocol.ToolKindOther, Input: mustJSON(map[string]any{"questions": questions}), Status: protocol.ToolStatusPending, ParentID: parent})
	}
	if len(qs) == 0 {
		answer(map[string]any{"answers": map[string]any{}})
		ctx.UpdateItem(itemID, Patch{"status": protocol.ToolStatusCompleted, "result": protocol.ToolResult{Content: ""}})
		return
	}
	answered := func(res protocol.Resolution) {
		if res.Outcome != protocol.ResolutionOutcomeAnswer {
			answer(map[string]any{"answers": map[string]any{}})
			ctx.UpdateItem(itemID, Patch{"status": protocol.ToolStatusDenied})
			return
		}
		secret := map[string]bool{}
		for _, q := range qs {
			if q.Secret {
				secret[q.ID] = true
			}
		}
		answers := map[string]any{}
		var lines []string
		for _, q := range sortedKeys(res.Answers) {
			a := res.Answers[q]
			if a == nil {
				a = []string{}
			}
			answers[q] = map[string]any{"answers": a}
			// The real answer goes only to Codex; the call's result is shown and saved.
			shown := strings.Join(a, ", ")
			if secret[q] && len(a) > 0 {
				shown = secretText
			}
			lines = append(lines, q+": "+shown)
		}
		answer(map[string]any{"answers": answers})
		ctx.UpdateItem(itemID, Patch{"status": protocol.ToolStatusCompleted, "result": protocol.ToolResult{Content: strings.Join(lines, "\n")}})
	}
	rid := existing
	if existing == "" || !ctx.Reopen(existing, answered, "") {
		rid = ctx.Ask(&protocol.QuestionRequest{Questions: qs}, itemID, answered, "")
	}
	run.asked[key] = rid
}

// dynamicCall is item/tool/call: one of the app's tools, given as a dynamic tool.
func (s *codexSession) dynamicCall(run *codexRun, key string, p jmap, wanted func() bool, answer func(any), parent, existing string) {
	reply := func(text string, ok bool) {
		answer(map[string]any{"contentItems": []any{map[string]any{"type": "inputText", "text": text}}, "success": ok})
	}
	name := p.str("tool")
	tool := findTool(s.ctx.Config().Tools, name)
	// Codex keeps a session's dynamic tools as they were: one that has gone or changed since is
	// answered with where the app's tools are now.
	elsewhere := func() string {
		var names []string
		for _, t := range s.mcpTools(run) {
			names = append(names, t.Name())
		}
		if len(names) == 0 {
			return ""
		}
		return fmt.Sprintf(" The app's other tools are on its %s MCP server: %s.", appServer, strings.Join(names, ", "))
	}
	was, known := run.dynamicTool(name)
	if tool == nil {
		if known {
			reply(fmt.Sprintf("The tool %s isn't available any more.%s", name, elsewhere()), false)
		} else {
			reply(fmt.Sprintf("There's no tool %s.", name), false)
		}
		return
	}
	if run.dynamic != nil && !(known && sameSpec(was, specOf(tool))) {
		reply(fmt.Sprintf("The tool %s has changed: call it on the %s MCP server instead.", name, appServer), false)
		return
	}
	args := orEmpty(p.raw("arguments"))
	callID := p.str("callId")
	t := &protocol.ToolCall{Name: name, Kind: protocol.ToolKindApp, Input: args, Title: name}
	s.permit(run, key, s.query(t, callID, "", parent), wanted, func(ok bool, message string) {
		if !ok {
			reply(message, false)
			return
		}
		// Saved as running before it runs, so a backend that restarts while it does answers it rather
		// than run it again (see reopen).
		if o := run.open[key]; o != nil {
			o.Started = true
		}
		s.ctx.Persist(func(err error) {
			if err != nil {
				reply("The app couldn't save its state, so it didn't run this tool.", false)
				return
			}
			if !wanted() || run.detached {
				return
			}
			s.runApp(run, name, args, callID, func(out ToolOutput) {
				// The backend shut down while it ran (and cancelled it): it's left open, as saved, for
				// the backend that re-attaches to answer.
				if run.detached {
					return
				}
				reply(out.Text, !out.IsError)
				// Saved as answered, though no event says so: a restart doesn't answer it again.
				s.ctx.Persist(func(error) {})
			})
		})
	}, existing)
}

// mcpAppTool is tools/call on the loopback MCP server: one of the app's tools.
func (s *codexSession) mcpAppTool(run *codexRun, name string, args json.RawMessage, done func(ToolOutput)) {
	ctx := s.ctx
	found := false
	for _, t := range s.mcpTools(run) {
		found = found || t.Name() == name
	}
	if !found {
		done(ToolOutput{Text: fmt.Sprintf("There's no tool %s.", name), IsError: true})
		return
	}
	// The call it is, if only one running call matches it.
	var matching []mcpCall
	for _, c := range run.mcpCalls {
		if c.Server == appServer && c.Name == name && sameCanonical(c.Args, args) {
			matching = append(matching, c)
		}
	}
	var it *protocol.ToolCall
	if len(matching) == 1 {
		it, _ = s.callFields(matching[0].ID)
	}
	turn := ctx.TurnID()
	wanted := func() bool {
		return !run.exited && !run.retired && !run.detached && s.run == run && ctx.TurnID() == turn
	}
	t := &protocol.ToolCall{Name: name, Kind: protocol.ToolKindApp, Input: args, Title: name}
	itemID, parent := "", ""
	if it != nil {
		itemID, parent = it.ID, it.ParentID
	}
	answered := false
	s.permit(run, "", s.query(t, itemID, "", parent), wanted, func(ok bool, message string) {
		answered = true
		if !ok {
			done(ToolOutput{Text: message, IsError: true})
			return
		}
		s.runApp(run, name, args, itemID, done)
	}, "")
	if !answered && !wanted() {
		done(ToolOutput{Text: "The turn ended before the tool could run.", IsError: true})
	}
}

// runApp runs one of the app's tools, off the thread's goroutine, and calls done with what it
// returned, on it.
func (s *codexSession) runApp(run *codexRun, name string, args json.RawMessage, toolCallID string, done func(ToolOutput)) {
	ctx := s.ctx
	tool := findTool(ctx.Config().Tools, name)
	if tool == nil {
		done(ToolOutput{Text: fmt.Sprintf("There's no tool %s.", name), IsError: true})
		return
	}
	t := ctx.Thread()
	call := ToolContext{ThreadID: ctx.ThreadID(), Metadata: metadataOf(t), ToolCallID: toolCallID}
	go func() {
		out := runTool(run.toolCtx, tool, args, call)
		ctx.Post(func() {
			if toolCallID != "" && !run.detached {
				ctx.ToolOutput(toolCallID, out.Structured)
			}
			done(out)
		})
	}()
}

// canonicalPath is a path with its symlinks resolved, where it exists.
func canonicalPath(path string) string {
	if p, err := filepath.EvalSymlinks(path); err == nil {
		return p
	}
	if p, err := filepath.Abs(path); err == nil {
		return p
	}
	return path
}

// codexEchoKey is what identifies a message in Codex's userMessage item: its text inputs and how
// many images it has.
func codexEchoKey(input json.RawMessage) string {
	var parts []jmap
	json.Unmarshal(input, &parts)
	texts := []string{}
	images := 0
	for _, p := range parts {
		switch p.str("type") {
		case "text":
			texts = append(texts, p.str("text"))
		case "image", "localImage":
			images++
		}
	}
	return string(mustJSON([]any{texts, images}))
}

func codexExitError(status ExitStatus, stderr []string, duringTurn bool) string {
	if status.Err != nil {
		return "Codex couldn't be started: " + status.Err.Error()
	}
	during := ""
	if duringTurn {
		during = " during the turn"
	}
	return "Codex " + exitHow(status) + during + "." + stderrTail(stderr)
}

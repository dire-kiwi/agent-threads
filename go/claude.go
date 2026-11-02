package agentthreads

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// The Claude Code driver: it runs `claude -p` in stream-json mode, one process per thread (started
// at its first message, kept between turns), and translates what it says into the thread's events
// by the rules in spec/fixtures/README.md. Permissions come in as can_use_tool control requests,
// the app's tools are an in-process MCP server answered over mcp_message, and steered messages go
// in over stdin and join the turn when Claude echoes them back.

// ClaudeOptions configure the Claude Code harness.
type ClaudeOptions struct {
	// Bin is the claude binary ("claude" on the PATH by default).
	Bin string
	// BinArgs are arguments before Claude's own: e.g. the script, when Bin is node.
	BinArgs []string
	// Args are more arguments, after the driver's.
	Args []string
	// Env is added to the backend's environment.
	Env map[string]string
	// ConfigDir is Claude Code's config directory (CLAUDE_CONFIG_DIR), for a login of the app's own.
	ConfigDir string
	// UserSettings lets threads see the user's own Claude Code settings, MCP servers and skills. Off
	// by default: a thread sees only the app's.
	UserSettings bool
	// StopGrace is how long an interrupted turn has to end before the process is stopped. 10s by
	// default.
	StopGrace time.Duration
	// SteerGrace is how long Claude has, after a turn ends, to take in steered messages it hasn't
	// yet; then the process is restarted with them. 30s by default.
	SteerGrace time.Duration
	// CloseGrace is how long a process has to exit after its input is closed before it's sent
	// SIGTERM. 5s by default.
	CloseGrace time.Duration
}

// ClaudeCode is the Claude Code harness.
func ClaudeCode(o ClaudeOptions) Harness { return claudeHarness{o} }

type claudeHarness struct{ o ClaudeOptions }

func (claudeHarness) Name() string { return "claude" }

func (h claudeHarness) Open(ctx ThreadContext) Session {
	return &claudeSession{ctx: ctx, o: h.o}
}

func orDuration(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// claudeOpen is a request of Claude's not yet answered: the turn it came in, and the request.
type claudeOpen struct {
	Turn    string `json:"turn,omitempty"`
	Request jmap   `json:"request"`
}

type sentMessage struct {
	IDs  []string `json:"ids"`
	Echo string   `json:"echo"`
}

// launched is the thread's options a process is started with: a different one needs another.
type launched struct {
	Model          string         `json:"model,omitempty"`
	Effort         string         `json:"effort,omitempty"`
	PermissionMode string         `json:"permission_mode,omitempty"`
	Launch         *LaunchOptions `json:"launch,omitempty"`
}

func launchedOf(ctx ThreadContext) *launched {
	t := ctx.Thread()
	l := &launched{Model: t.Model, Effort: t.Effort, PermissionMode: string(t.PermissionMode)}
	if launch := ctx.Launch(); !launch.IsEmpty() {
		l.Launch = &launch
	}
	return l
}

// stale says whether a process started with l (as its checkpoint says) has other options than the
// thread's now.
func (l *launched) stale(ctx ThreadContext) bool {
	return l == nil || !sameJSONValue(l, launchedOf(ctx))
}

// claudeRunState is what a run's checkpoint holds (see DurableSession.Checkpoint): what's needed to
// carry on reading its output, as of the offset saved with it.
type claudeRunState struct {
	V       int         `json:"v"`
	Ready   bool        `json:"ready"`
	Waiting []string    `json:"waiting"`
	Pending [][2]string `json:"pending"` // our control requests not yet answered: [id, subtype]
	Next    int         `json:"next"`
	// MsgOfParent is [parent_tool_use_id (null for the thread's own), the streamed message's id].
	MsgOfParent [][2]*string    `json:"msgOfParent"`
	BlockCount  [][2]any        `json:"blockCount"`
	Streamed    []string        `json:"streamed"`
	SummaryNext *string         `json:"summaryNext"`
	Asked       [][2]string     `json:"asked"`
	Open        [][2]any        `json:"open"`
	Sent        []sentMessage   `json:"sent"`
	Tasks       [][2]string     `json:"tasks,omitempty"`  // [a subagent's task id, its call's id]
	Agents      []string        `json:"agents,omitempty"` // the calls whose subagents it ran
	AutoTurn    string          `json:"autoTurn,omitempty"`
	HeldUsage   *protocol.Usage `json:"heldUsage,omitempty"`
	PluginDir   string          `json:"pluginDir,omitempty"`
	At          string          `json:"at,omitempty"`       // the running turn's mark: the main conversation's last message in it
	ResumeAt    string          `json:"resumeAt,omitempty"` // the thread's resume_at it was started with
	Launched    *launched       `json:"launched,omitempty"`
	Stale       bool            `json:"stale,omitempty"`
	SteerAt     *int64          `json:"steerAt,omitempty"`
	StopAt      *int64          `json:"stopAt,omitempty"`
	raw         json.RawMessage `json:"-"`
}

type pendingControl struct {
	subtype string
	resolve func(jmap) // nil: refused, or the process went
	// full, for the app's requests, is given the whole control response (nil: the process went).
	full func(jmap)
}

// claudeRun is one claude process, and what's needed to read it.
type claudeRun struct {
	id   string
	proc Process
	// ready says Claude answered initialize, so messages can go in.
	ready        bool
	waiting      []string
	pending      map[string]*pendingControl
	pendingOrder []string
	nextRequest  int
	exited       bool
	// retired says it was stopped on purpose (to restart), so its end doesn't end the turn.
	retired bool
	// detached says it was left running when the backend shut down: nothing more is read or written.
	detached bool
	finished bool
	onDone   []func()
	stderr   []string
	toolCtx  context.Context
	abort    context.CancelFunc
	// What's needed to translate its output.
	msgOfParent map[string]string // parent_tool_use_id ("" for none) -> the streamed message's id
	blockCount  map[string]int    // message id -> blocks seen in assistant messages
	streamed    map[string]bool   // items that got deltas
	summaryNext string            // a compaction waiting for its summary
	asked       map[string]string // Claude's request id -> our request's
	// open is Claude's requests not yet answered, with the turn each came in.
	open      map[string]*claudeOpen
	openOrder []string
	// sent is the messages sent, oldest first, by what Claude echoes when it takes one in.
	sent []sentMessage
	// tasks is its subagents' task ids (which some task_* messages name them by) -> their calls'
	// ids, and agents the calls whose subagents it ran, which are stopped when it ends.
	tasks  map[string]string
	agents []string
	// autoTurn is the turn it started by itself (BeginTurn), and heldUsage the usage of turns
	// Claude made by itself while one of the user's waited, for that turn's.
	autoTurn  string
	heldUsage *protocol.Usage
	// pluginDir is the generated plugin with the thread's skills, for this run only.
	pluginDir string
	// at is the running turn's mark: the uuid of the main conversation's last message in it.
	at string
	// resumeAt is the message it was started to resume its session at (--resume-session-at).
	resumeAt string
	launched *launched
}

func newClaudeRun(id string) *claudeRun {
	if id == "" {
		id = NewID("run")
	}
	ctx, cancel := context.WithCancel(background)
	return &claudeRun{
		id: id, pending: map[string]*pendingControl{}, nextRequest: 1, toolCtx: ctx, abort: cancel,
		msgOfParent: map[string]string{}, blockCount: map[string]int{}, streamed: map[string]bool{},
		asked: map[string]string{}, open: map[string]*claudeOpen{}, tasks: map[string]string{},
	}
}

// addAgent notes a call whose subagent the run runs.
func (r *claudeRun) addAgent(id string) {
	for _, a := range r.agents {
		if a == id {
			return
		}
	}
	r.agents = append(r.agents, id)
}

func (r *claudeRun) write(msg any) {
	if r.exited || r.detached || r.proc == nil {
		return
	}
	r.proc.Write(string(mustJSON(msg)))
}

// send writes a user message (of the items ids), once Claude is ready for one.
func (r *claudeRun) send(ids []string, msg map[string]any) {
	content, _ := msg["message"].(map[string]any)["content"].([]map[string]any)
	r.sent = append(r.sent, sentMessage{IDs: ids, Echo: echoKeyBlocks(content)})
	line := string(mustJSON(msg))
	if r.ready {
		if !r.exited && !r.detached && r.proc != nil {
			r.proc.Write(line)
		}
	} else {
		r.waiting = append(r.waiting, line)
	}
}

func (r *claudeRun) control(request map[string]any, resolve func(jmap)) {
	id := fmt.Sprintf("req_%d", r.nextRequest)
	r.nextRequest++
	subtype, _ := request["subtype"].(string)
	r.pending[id] = &pendingControl{subtype: subtype, resolve: resolve}
	r.pendingOrder = append(r.pendingOrder, id)
	r.write(map[string]any{"type": "control_request", "request_id": id, "request": request})
}

func (r *claudeRun) takePending(id string) *pendingControl {
	p := r.pending[id]
	if p != nil {
		delete(r.pending, id)
		r.pendingOrder = without(r.pendingOrder, id)
	}
	return p
}

func (r *claudeRun) setOpen(id string, o *claudeOpen) {
	if _, ok := r.open[id]; !ok {
		r.openOrder = append(r.openOrder, id)
	}
	r.open[id] = o
}

func (r *claudeRun) dropOpen(id string) bool {
	if _, ok := r.open[id]; !ok {
		return false
	}
	delete(r.open, id)
	r.openOrder = without(r.openOrder, id)
	return true
}

func without(list []string, x string) []string {
	for i, v := range list {
		if v == x {
			return append(list[:i:i], list[i+1:]...)
		}
	}
	return list
}

func (r *claudeRun) state() claudeRunState {
	st := claudeRunState{V: 1, Ready: r.ready, Waiting: append([]string{}, r.waiting...), Next: r.nextRequest, Streamed: []string{}, Sent: append([]sentMessage{}, r.sent...), PluginDir: r.pluginDir, At: r.at, ResumeAt: r.resumeAt, Launched: r.launched}
	st.Pending = [][2]string{}
	for _, id := range r.pendingOrder {
		st.Pending = append(st.Pending, [2]string{id, r.pending[id].subtype})
	}
	st.MsgOfParent = [][2]*string{}
	for _, k := range sortedKeys(r.msgOfParent) {
		v := r.msgOfParent[k]
		var key *string
		if k != "" {
			key = &k
		}
		st.MsgOfParent = append(st.MsgOfParent, [2]*string{key, &v})
	}
	st.BlockCount = [][2]any{}
	for _, k := range sortedKeys(r.blockCount) {
		st.BlockCount = append(st.BlockCount, [2]any{k, r.blockCount[k]})
	}
	for _, k := range sortedKeys(r.streamed) {
		st.Streamed = append(st.Streamed, k)
	}
	if r.summaryNext != "" {
		s := r.summaryNext
		st.SummaryNext = &s
	}
	st.Asked = [][2]string{}
	for _, k := range sortedKeys(r.asked) {
		st.Asked = append(st.Asked, [2]string{k, r.asked[k]})
	}
	st.Open = [][2]any{}
	for _, id := range r.openOrder {
		st.Open = append(st.Open, [2]any{id, r.open[id]})
	}
	for _, k := range sortedKeys(r.tasks) {
		st.Tasks = append(st.Tasks, [2]string{k, r.tasks[k]})
	}
	st.Agents = append([]string(nil), r.agents...)
	st.AutoTurn, st.HeldUsage = r.autoTurn, r.heldUsage
	return st
}

// restore takes up a checkpoint's state; our requests' answers go to answered.
func (r *claudeRun) restore(st claudeRunState, answered func(subtype string) func(jmap)) {
	r.ready = st.Ready
	r.waiting = append([]string{}, st.Waiting...)
	for _, p := range st.Pending {
		r.pending[p[0]] = &pendingControl{subtype: p[1], resolve: answered(p[1])}
		r.pendingOrder = append(r.pendingOrder, p[0])
	}
	r.nextRequest = st.Next
	for _, kv := range st.MsgOfParent {
		k := ""
		if kv[0] != nil {
			k = *kv[0]
		}
		if kv[1] != nil {
			r.msgOfParent[k] = *kv[1]
		}
	}
	for _, kv := range st.BlockCount {
		k, _ := kv[0].(string)
		n, _ := kv[1].(float64)
		r.blockCount[k] = int(n)
	}
	for _, k := range st.Streamed {
		r.streamed[k] = true
	}
	if st.SummaryNext != nil {
		r.summaryNext = *st.SummaryNext
	}
	for _, kv := range st.Asked {
		r.asked[kv[0]] = kv[1]
	}
	for _, kv := range st.Open {
		id, _ := kv[0].(string)
		var o claudeOpen
		data, _ := json.Marshal(kv[1])
		json.Unmarshal(data, &o)
		r.setOpen(id, &o)
	}
	r.sent = append([]sentMessage{}, st.Sent...)
	for _, kv := range st.Tasks {
		r.tasks[kv[0]] = kv[1]
	}
	r.agents = append([]string(nil), st.Agents...)
	r.autoTurn, r.heldUsage = st.AutoTurn, st.HeldUsage
	r.pluginDir = st.PluginDir
	r.at, r.resumeAt = st.At, st.ResumeAt
	r.launched = st.Launched
}

func (r *claudeRun) respond(requestID string, response any) {
	// Left running: what's open stays as it was saved, for the backend that re-attaches to answer.
	if r.detached {
		return
	}
	r.dropOpen(requestID)
	r.write(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": requestID, "response": response}})
}

func (r *claudeRun) respondError(requestID, message string) {
	r.write(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": requestID, "error": message}})
}

// whenDone calls fn once the run has finished (exited, or never started).
func (r *claudeRun) whenDone(fn func()) {
	if r.finished {
		fn()
		return
	}
	r.onDone = append(r.onDone, fn)
}

func (r *claudeRun) finish() {
	if r.finished {
		return
	}
	r.finished = true
	for _, fn := range r.onDone {
		fn()
	}
	r.onDone = nil
}

// loopTimer is a timer whose function runs on the thread's goroutine; stop cancels it. Its fields are
// the thread goroutine's.
type loopTimer struct {
	timer     *time.Timer
	at        int64
	cancelled bool
	// paused says it won't go off here (its deadline is for the next backend), though it's pending.
	paused bool
}

func startTimer(ctx ThreadContext, d time.Duration, fn func()) *loopTimer {
	return startLoopTimer(ctx.Post, d, fn)
}

func startLoopTimer(post func(func()), d time.Duration, fn func()) *loopTimer {
	t := &loopTimer{at: time.Now().Add(d).UnixMilli()}
	t.timer = time.AfterFunc(d, func() {
		post(func() {
			// Checked here, on the thread's goroutine: the timer may have gone off, and posted this,
			// before it was stopped or paused.
			if !t.cancelled && !t.paused {
				t.cancelled = true
				fn()
			}
		})
	})
	return t
}

func (t *loopTimer) stop() {
	if t != nil {
		t.cancelled = true
		t.timer.Stop()
	}
}

// pause stops the timer from going off here, but keeps its deadline for a checkpoint: for a run left
// going as the backend shuts down, whose next backend carries it on.
func (t *loopTimer) pause() {
	if t != nil {
		t.paused = true
		t.timer.Stop()
	}
}

func (t *loopTimer) pending() *int64 {
	if t == nil || t.cancelled {
		return nil
	}
	at := t.at
	return &at
}

// stopper keeps the runs being stopped, which the next must wait for.
type stopper struct {
	runs  map[any]bool
	after []func()
}

func (s *stopper) add(run any) {
	if s.runs == nil {
		s.runs = map[any]bool{}
	}
	s.runs[run] = true
}

func (s *stopper) done(run any) {
	delete(s.runs, run)
	if len(s.runs) == 0 {
		after := s.after
		s.after = nil
		for _, fn := range after {
			fn()
		}
	}
}

// then runs fn once no run is being stopped.
func (s *stopper) then(fn func()) {
	if len(s.runs) == 0 {
		fn()
		return
	}
	s.after = append(s.after, fn)
}

type claudeSession struct {
	ctx ThreadContext
	o   ClaudeOptions
	run *claudeRun
	// last is the run before, once it has exited (for its last checkpoint).
	last     *claudeRun
	stopping stopper
	// stale says the options changed since the run started: the next turn starts a new one.
	stale      bool
	steerTimer *loopTimer
	stopTimer  *loopTimer
	// tmp is a directory for the thread's generated files (skills, attached files), made when needed.
	tmp    string
	closed bool
	// controls is what fails each of the app's control requests not yet answered, when the backend
	// lets go of its run.
	controls    map[int]func(error)
	nextControl int
}

// ---------- the core's side ----------

func (s *claudeSession) Start(messages []Message) {
	run := s.ensure(true)
	// One message, however many there are: Claude makes a turn of each message waiting for it, so
	// several would run as turns of their own after this one's result.
	if len(messages) > 0 {
		run.send(messageIDs(messages), s.userMessage(messages))
	}
}

func messageIDs(ms []Message) []string {
	ids := make([]string, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	return ids
}

func (s *claudeSession) Steer(m Message) {
	s.ensure(false).send([]string{m.ID}, s.userMessage([]Message{m}))
}

func (s *claudeSession) CarryOver(messages []Message) {
	run := s.live()
	if run == nil || s.stale {
		// The next turn runs with the options as they are now, so in a new process if they changed.
		// The old one has the messages on its stdin, and mustn't act on them: it's stopped at once.
		if run != nil {
			s.stop(run, true, true, nil)
		}
		s.Start(messages)
		return
	}
	// Claude has them on its stdin, and takes them in once it's ready, which starts the next turn.
	// If it doesn't, they go to a new process.
	s.steerAfter(run, orDuration(s.o.SteerGrace, 30*time.Second))
}

func (s *claudeSession) steerAfter(run *claudeRun, d time.Duration) {
	s.steerTimer.stop()
	s.steerTimer = startTimer(s.ctx, d, func() {
		s.steerTimer = nil
		s.requeue(run)
	})
}

func (s *claudeSession) clearSteer() {
	s.steerTimer.stop()
	s.steerTimer = nil
}

func (s *claudeSession) Compact() {
	// Claude Code compacts when it's sent /compact, which is its turn.
	s.ensure(true).send([]string{}, s.userMessage([]Message{{Text: "/compact"}}))
}

func (s *claudeSession) RewindPoint(sessions []*protocol.TurnSession, index int) (RewindPoint, error) {
	return ResumeAtPoint(sessions, index)
}

func (s *claudeSession) Interrupt() {
	run := s.live()
	if run == nil {
		return
	}
	s.stopAfter(run, orDuration(s.o.StopGrace, 10*time.Second))
	turn := s.ctx.TurnID()
	send := func(error) {
		if s.live() == run && !run.detached && s.ctx.TurnID() == turn {
			run.control(map[string]any{"subtype": "interrupt"}, func(jmap) {})
		}
	}
	// A run that outlives the backend is saved first, its turn interrupted and when it's stopped if
	// the turn doesn't end: after a restart, one that Claude ignores the interrupt in is still stopped.
	if _, durable := s.ctx.Spawner().(DurableSpawner); durable {
		s.ctx.Persist(send)
		return
	}
	send(nil)
}

// stopAfter stops the run if the turn running now hasn't ended in d.
func (s *claudeSession) stopAfter(run *claudeRun, d time.Duration) {
	turn := s.ctx.TurnID()
	s.clearStop()
	s.stopTimer = startTimer(s.ctx, d, func() {
		s.stopTimer = nil
		if s.ctx.TurnID() == turn && !run.exited {
			s.stop(run, false, false, nil)
		}
	})
}

func (s *claudeSession) clearStop() {
	s.stopTimer.stop()
	s.stopTimer = nil
}

func (s *claudeSession) OptionsChanged() { s.stale = true }

func (s *claudeSession) Live() bool { return s.live() != nil }

func (s *claudeSession) Release() {
	s.clearSteer()
	// It has the messages on its stdin: stopped at once, it can't take them in unseen.
	if run := s.live(); run != nil {
		s.stop(run, true, true, nil)
	}
}

func (s *claudeSession) Close(done func()) {
	s.closed = true
	s.clearSteer()
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

func (s *claudeSession) Checkpoint() *RunCheckpoint {
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
	st := run.state()
	st.Stale = s.stale
	st.SteerAt = s.steerTimer.pending()
	st.StopAt = s.stopTimer.pending()
	input := dp.InputOffset()
	return &RunCheckpoint{ID: run.id, Offset: dp.Offset(), Dir: dp.Dir(), Input: &input, State: st, Ended: run.exited}
}

func (s *claudeSession) Reattach(record RunRecord) bool {
	var data struct {
		State *claudeRunState `json:"state"`
	}
	json.Unmarshal(record.Data, &data)
	st := data.State
	spawner, ok := s.ctx.Spawner().(DurableSpawner)
	if st == nil || st.V != 1 || !ok || s.run != nil {
		return false
	}
	run := newClaudeRun(record.ID)
	run.restore(*st, func(subtype string) func(jmap) {
		if subtype == "initialize" {
			return func(r jmap) { s.initialized(run, r) }
		}
		return func(jmap) {}
	})
	s.run = run
	proc, err := spawner.Attach(record, s.handlers(run), s.ctx.Post)
	if err != nil {
		s.run = nil
		s.ctx.Error(err)
		return false
	}
	run.proc = proc
	// A process started with other options than the thread's now is replaced at the next turn.
	s.stale = st.Stale || st.Launched.stale(s.ctx)
	// Claude's requests that were open: the user's questions are taken up again, and the rest (a
	// policy that hadn't decided, a tool that was running) are dealt with again. One answered before
	// the restart, though that wasn't saved, is closed: Claude has its answer.
	for _, id := range append([]string(nil), run.openOrder...) {
		if s.answered(run, id) {
			run.dropOpen(id)
		} else if o := run.open[id]; o != nil {
			s.reopen(run, id, o)
		}
	}
	nowMs := time.Now().UnixMilli()
	if st.SteerAt != nil {
		s.steerAfter(run, time.Duration(max(0, *st.SteerAt-nowMs))*time.Millisecond)
	}
	if st.StopAt != nil {
		s.stopAfter(run, time.Duration(max(0, *st.StopAt-nowMs))*time.Millisecond)
	}
	return true
}

func (s *claudeSession) Detach() bool {
	run := s.live()
	if run == nil {
		return false
	}
	dp, ok := run.proc.(DurableProcess)
	if !ok {
		return false
	}
	s.closed = true
	// Their deadlines stay in the checkpoint saved after this, for the backend that re-attaches.
	s.steerTimer.pause()
	s.stopTimer.pause()
	run.detached = true
	dp.Detach()
	run.abort()
	failControls(s.controls, "The backend closed before Claude Code answered.")
	return true
}

// failControls fails the app's control requests not yet answered.
func failControls(controls map[int]func(error), message string) {
	for _, n := range sortedIntKeys(controls) {
		if fail := controls[n]; fail != nil {
			fail(&ControlError{Message: message})
		}
	}
}

func sortedIntKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

// addControl keeps an app's control request's reply until it's answered or failed; it returns the
// reply to call, which does nothing after the first time.
func addControl(controls *map[int]func(error), next *int, reply func(json.RawMessage, error)) func(json.RawMessage, error) {
	if *controls == nil {
		*controls = map[int]func(error){}
	}
	n := *next
	*next++
	done := func(result json.RawMessage, err error) {
		if _, ok := (*controls)[n]; !ok {
			return
		}
		delete(*controls, n)
		reply(result, err)
	}
	(*controls)[n] = func(err error) { done(nil, err) }
	return done
}

func (s *claudeSession) Control(request json.RawMessage, reply func(json.RawMessage, error)) error {
	run := s.live()
	if run == nil || run.proc == nil || run.detached {
		return commandErr("thread %s has no running Claude Code process", s.ctx.ThreadID())
	}
	req := parseObj(request)
	if req == nil || !isStr(req.raw("subtype")) {
		return commandErr("a Claude Code control request is an object with a subtype")
	}
	done := addControl(&s.controls, &s.nextControl, reply)
	id := fmt.Sprintf("req_%d", run.nextRequest)
	run.nextRequest++
	run.pending[id] = &pendingControl{subtype: req.str("subtype"), full: func(r jmap) {
		switch {
		case r == nil:
			done(nil, &ControlError{Message: "Claude Code exited before it answered."})
		case r.str("subtype") == "error":
			msg := r.str("error")
			if msg == "" {
				msg = "Claude Code refused the request."
			}
			done(nil, &ControlError{Message: msg, Data: r.raw("error")})
		default:
			result := r.raw("response")
			if result == nil {
				result = json.RawMessage("null")
			}
			done(result, nil)
		}
	}}
	run.pendingOrder = append(run.pendingOrder, id)
	run.write(map[string]any{"type": "control_request", "request_id": id, "request": json.RawMessage(request)})
	return nil
}

// answered says whether an answer to Claude's request id was written before the backend restarted.
func (s *claudeSession) answered(run *claudeRun, id string) bool {
	dp, ok := run.proc.(DurableProcess)
	return ok && dp.Answered(id)
}

// reopen deals with a request of Claude's that was open when the backend restarted.
func (s *claudeSession) reopen(run *claudeRun, requestID string, o *claudeOpen) {
	req := o.Request
	if req.str("subtype") == "can_use_tool" {
		s.canUseTool(run, requestID, req, run.asked[requestID], true)
		return
	}
	run.dropOpen(requestID)
	if req.str("subtype") == "mcp_message" {
		// An app tool that was running: it went with the backend, and isn't run again, since it may
		// have done what it does.
		msg := req.obj("message")
		run.respond(requestID, map[string]any{"mcp_response": map[string]any{
			"jsonrpc": "2.0", "id": rpcID(msg),
			"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": "The app restarted while this tool was running, so it may or may not have finished."}}, "isError": true},
		}})
	}
}

func rpcID(msg jmap) json.RawMessage {
	if id := msg.raw("id"); id != nil {
		return id
	}
	return json.RawMessage("0")
}

// dir is the thread's directory for generated files.
func (s *claudeSession) dir() (string, error) {
	if s.tmp == "" {
		d, err := os.MkdirTemp("", "agent-threads-")
		if err != nil {
			return "", err
		}
		s.tmp = d
	}
	return s.tmp, nil
}

// userMessage is messages as one message on Claude's stdin: their content, one after the other.
func (s *claudeSession) userMessage(messages []Message) map[string]any {
	content := []map[string]any{}
	for _, m := range messages {
		content = append(content, s.content(m)...)
	}
	return map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}, "parent_tool_use_id": nil, "session_id": ""}
}

// content is a message's content as Claude takes it: images with data as images, other files as text.
func (s *claudeSession) content(m Message) []map[string]any {
	var out []map[string]any
	for _, p := range messageParts(m, s.dir) {
		switch p.kind {
		case partText:
			out = append(out, map[string]any{"type": "text", "text": p.text})
		case partImage:
			out = append(out, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": p.mediaType, "data": p.data}})
		default:
			out = append(out, map[string]any{"type": "text", "text": pathText(p)})
		}
	}
	return out
}

// ---------- the process ----------

func (s *claudeSession) live() *claudeRun {
	if r := s.run; r != nil && !r.exited && !r.retired {
		return r
	}
	return nil
}

// ensure is the running process, or a new one. A new turn (fresh) restarts it if the options changed.
func (s *claudeSession) ensure(fresh bool) *claudeRun {
	live := s.live()
	if live != nil && !(fresh && s.stale) {
		return live
	}
	if live != nil {
		s.stop(live, true, false, nil)
	}
	s.stale = false
	run := newClaudeRun("")
	s.run = run
	s.stopping.then(func() { s.spawn(run) })
	return run
}

// stop stops a run: it closes its input, then signals it if it doesn't exit; or signals it straight
// away (now), when it has messages on its stdin that are going to another process instead. done,
// if given, is called once it has finished.
func (s *claudeSession) stop(run *claudeRun, retire, now bool, done func()) {
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

// stopRun stops a process: with a durable process's Stop (written down, so a restart carries on
// with it), or by closing its input, then SIGTERM after grace and SIGKILL after twice that.
func stopRun(ctx ThreadContext, proc Process, grace time.Duration, now bool, whenDone func(func())) {
	if proc == nil {
		return
	}
	if dp, ok := proc.(DurableProcess); ok {
		dp.Stop(grace.Milliseconds(), now)
		return
	}
	proc.CloseInput()
	if now {
		proc.Kill(syscall.SIGTERM)
	}
	term := startTimer(ctx, grace, func() { proc.Kill(syscall.SIGTERM) })
	kill := startTimer(ctx, grace*2, func() { proc.Kill(syscall.SIGKILL) })
	whenDone(func() {
		term.stop()
		kill.stop()
	})
}

// requeue sends steered messages Claude didn't take in after its turn to a new process.
func (s *claudeSession) requeue(run *claudeRun) {
	if s.run != run || run.exited || len(s.ctx.Queued()) == 0 {
		return
	}
	s.stop(run, true, true, nil)
	next := s.ensure(false)
	var queued []Message
	for _, m := range s.ctx.Queued() {
		queued = append(queued, toMessage(m))
	}
	if len(queued) > 0 {
		next.send(messageIDs(queued), s.userMessage(queued))
	}
}

func (s *claudeSession) spawn(run *claudeRun) {
	if s.closed || run.retired {
		run.exited = true
		run.finish()
		return
	}
	ctx := s.ctx
	thread := ctx.Thread()
	cfg := ctx.Config()
	bin := s.o.Bin
	if bin == "" {
		bin = "claude"
	}
	args, err := s.args(run)
	if err != nil {
		s.exited(run, ExitStatus{Err: err})
		return
	}
	launch := ctx.Launch()
	env := launch.applyEnv(mergeEnv(os.Environ(), s.o.Env))
	configDir := launch.ConfigDir
	if configDir == "" {
		configDir = s.o.ConfigDir
	}
	if configDir != "" {
		env = mergeEnv(env, map[string]string{"CLAUDE_CONFIG_DIR": configDir})
	}
	proc, err := ctx.Spawner().Spawn(SpawnOptions{
		Command: bin, Args: append(append([]string{}, s.o.BinArgs...), args...), Cwd: thread.Cwd, Env: env,
		ThreadID: ctx.ThreadID(), RunID: run.id, Post: ctx.Post,
	}, s.handlers(run))
	if err != nil {
		s.exited(run, ExitStatus{Err: err})
		return
	}
	run.proc = proc
	run.launched = launchedOf(ctx)
	ctx.SetThread(func(t *protocol.Thread) {
		t.Run = &protocol.Run{ID: run.id, Spawner: protocol.RunSpawner(ctx.Spawner().Name()), StartedAt: now()}
	})
	init := map[string]any{"subtype": "initialize"}
	if len(cfg.Tools) > 0 {
		init["sdkMcpServers"] = []string{appServer}
	}
	run.control(init, func(r jmap) { s.initialized(run, r) })
}

// mergeEnv is env with vars set (replacing any already there).
func mergeEnv(env []string, vars map[string]string) []string {
	if len(vars) == 0 {
		return env
	}
	out := make([]string, 0, len(env)+len(vars))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := vars[k]; !ok {
			out = append(out, kv)
		}
	}
	for _, k := range sortedKeys(vars) {
		out = append(out, k+"="+vars[k])
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortStrings(s []string) { sort.Strings(s) }

func (s *claudeSession) handlers(run *claudeRun) ProcessHandlers {
	return ProcessHandlers{
		Line: func(line string) { s.ctx.FromHarness(run.id, line, func() { s.line(run, line) }) },
		Stderr: func(line string) {
			run.stderr = append(run.stderr, line)
			if len(run.stderr) > 20 {
				run.stderr = run.stderr[1:]
			}
		},
		Exit:       func(status ExitStatus) { s.exited(run, status) },
		Unanswered: func() []string { return append([]string(nil), run.openOrder...) },
	}
}

// initialized is Claude's answer to initialize (nil: it refused).
func (s *claudeSession) initialized(run *claudeRun, r jmap) {
	if run.exited || run.detached {
		return
	}
	if r == nil {
		// It refused: messages can't go in, so stop it, which ends the turn.
		run.stderr = append(run.stderr, "Claude Code refused the initialize request.")
		s.stop(run, false, false, nil)
		return
	}
	run.ready = true
	waiting := run.waiting
	run.waiting = nil
	for _, line := range waiting {
		if run.proc != nil {
			run.proc.Write(line)
		}
	}
}

func (s *claudeSession) args(run *claudeRun) ([]string, error) {
	t := s.ctx.Thread()
	cfg := s.ctx.Config()
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--input-format", "stream-json"}
	args = append(args, "--replay-user-messages", "--permission-prompt-tool", "stdio")
	if !s.o.UserSettings {
		args = append(args, "--setting-sources", "", "--strict-mcp-config")
	}
	args = append(args, "--forward-subagent-text", "--include-hook-events")
	if t.Model != "" {
		args = append(args, "--model", t.Model)
	}
	if t.Effort != "" {
		args = append(args, "--effort", t.Effort)
	}
	if mode := claudePermissionMode(t.PermissionMode); mode != "" {
		args = append(args, "--permission-mode", mode)
	}
	if t.SessionID != "" {
		args = append(args, "--resume", t.SessionID)
	}
	// After a rewind: the session as it was at the end of the turn it went back to.
	run.resumeAt = ""
	if t.SessionID != "" {
		run.resumeAt = t.ResumeAt
	}
	if run.resumeAt != "" {
		args = append(args, "--resume-session-at", run.resumeAt)
	}
	servers := map[string]any{}
	if len(cfg.Tools) > 0 {
		servers[appServer] = map[string]any{"type": "sdk", "name": appServer}
	}
	for name, sv := range cfg.MCPServers {
		if sv.URL != "" {
			typ := sv.Type
			if typ == "" || typ == "stdio" {
				typ = "http"
			}
			c := map[string]any{"type": typ, "url": sv.URL}
			if len(sv.Headers) > 0 {
				c["headers"] = sv.Headers
			}
			servers[name] = c
		} else {
			c := map[string]any{"type": "stdio", "command": sv.Command, "args": orEmptyList(sv.Args)}
			if len(sv.Env) > 0 {
				c["env"] = sv.Env
			}
			servers[name] = c
		}
	}
	if len(servers) > 0 {
		args = append(args, "--mcp-config", string(mustJSON(map[string]any{"mcpServers": servers})))
	}
	if len(cfg.Skills) > 0 {
		// A plugin of the run's own, made from the skills as they are now: Claude finds a plugin's
		// skills (as app:<name>) even with --setting-sources "", which hides .claude/skills directories.
		dir, err := s.dir()
		if err != nil {
			return nil, err
		}
		run.pluginDir, err = writePlugin(filepath.Join(dir, "plugin-"+run.id), cfg.Skills)
		if err != nil {
			return nil, err
		}
		args = append(args, "--plugin-dir", run.pluginDir)
	}
	if cfg.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", cfg.SystemPrompt)
	}
	launch := s.ctx.Launch()
	for _, d := range launch.AddDirs {
		args = append(args, "--add-dir", d)
	}
	args = append(args, s.o.Args...)
	return append(args, launch.Args...), nil
}

func orEmptyList(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (s *claudeSession) exited(run *claudeRun, status ExitStatus) {
	if run.exited || run.detached {
		return
	}
	run.exited = true
	run.abort()
	if run.pluginDir != "" {
		os.RemoveAll(run.pluginDir)
	}
	pending := run.pending
	order := run.pendingOrder
	run.pending, run.pendingOrder = map[string]*pendingControl{}, nil
	for _, id := range order {
		if p := pending[id]; p != nil && p.full != nil {
			p.full(nil)
		} else if p != nil && p.resolve != nil {
			p.resolve(nil)
		}
	}
	ctx := s.ctx
	if s.run == run {
		s.run = nil
		s.last = run
	}
	if r := ctx.Thread().Run; r != nil && r.ID == run.id {
		ctx.SetThread(func(t *protocol.Thread) { t.Run = nil })
	}
	// Its subagents end with it.
	ctx.StopSubagents(run.agents)
	// A run that ends while its turn is running ends the turn (as interrupted, if it was).
	if !run.retired && ctx.TurnID() != "" {
		s.clearStop()
		s.clearSteer()
		ctx.EndTurn(TurnEnd{Error: claudeExitError(status, run.stderr), SessionAt: run.at})
	}
	run.finish()
}

// ---------- what Claude says ----------

func (s *claudeSession) line(run *claudeRun, line string) {
	m := parseObj([]byte(line))
	if m == nil {
		return // Not a message: Claude Code doesn't write anything else to stdout, but be safe.
	}
	if m.str("type") == "control_response" {
		// Claude echoes our own responses back too; those aren't for a request of ours.
		r := m.obj("response")
		if p := run.takePending(r.str("request_id")); p != nil && p.full != nil {
			p.full(r)
		} else if p != nil && p.resolve != nil {
			if r.str("subtype") == "error" {
				p.resolve(nil)
			} else if resp := r.obj("response"); resp != nil {
				p.resolve(resp)
			} else {
				p.resolve(jmap{})
			}
		}
		return
	}
	if run.retired || run != s.run {
		return
	}
	s.message(run, m)
}

func (s *claudeSession) message(run *claudeRun, m jmap) {
	ctx := s.ctx
	parent := m.str("parent_tool_use_id")
	// A message refused for the usage limit says which limit, before anything else it leads to.
	if t := m.str("type"); (t == "assistant" || t == "user" || t == "result") && m.str("api_error") == "usage_limit_reached" {
		if info := m.obj("api_error_params").obj("rate_limit_info"); info != nil {
			ctx.RateLimits(claudeRateLimits(info))
		}
	}
	// The main conversation's messages (replayed ones too): the turn's last is where a rewind to after
	// it resumes the session.
	if typ := m.str("type"); (typ == "user" || typ == "assistant") && parent == "" && m.str("uuid") != "" {
		run.at = m.str("uuid")
	}
	switch m.str("type") {
	case "rate_limit_event":
		if info := m.obj("rate_limit_info"); info != nil {
			ctx.RateLimits(claudeRateLimits(info))
		}
	case "system":
		// Claude starts a turn by itself to tell the agent that a background subagent has ended.
		if m.str("subtype") == "init" && ctx.TurnID() == "" {
			ctx.BeginTurn()
			run.autoTurn = ctx.TurnID()
		}
		if m.str("subtype") == "init" {
			// The session it runs in; and a rewind's resume_at is done with once it has resumed there.
			thread := ctx.Thread()
			sid := m.str("session_id")
			setSession := sid != "" && sid != thread.SessionID
			doneAt := run.resumeAt != "" && thread.ResumeAt == run.resumeAt
			if setSession || doneAt {
				ctx.SetThread(func(t *protocol.Thread) {
					if setSession {
						t.SessionID = sid
					}
					if doneAt {
						t.ResumeAt = ""
					}
				})
			}
		}
		if m.str("subtype") == "api_retry" {
			ctx.AddItem(&protocol.Notice{ID: NewID("n"), Level: protocol.NoticeLevelWarning, Code: "retry", Text: retryText(m), ParentID: parent})
		}
		if m.str("subtype") == "hook_response" {
			if n := hookNotice(m); n != nil {
				n.ID, n.Code, n.ParentID = NewID("n"), "hook", parent
				ctx.AddItem(n)
			}
		}
		if strings.HasPrefix(m.str("subtype"), "task_") {
			s.task(run, m)
		}
		if m.str("subtype") == "compact_boundary" {
			meta := m.obj("compact_metadata")
			c := &protocol.Compaction{ID: m.str("uuid"), ParentID: parent}
			if tr := meta.str("trigger"); tr == "auto" || tr == "manual" {
				c.Trigger = protocol.CompactionTrigger(tr)
			}
			if n, ok := meta.int("pre_tokens"); ok {
				c.TokensBefore = &n
			}
			ctx.AddItem(c)
			run.summaryNext = m.str("uuid")
		}
	case "stream_event":
		ev := m.obj("event")
		if ev.str("type") == "message_start" {
			run.msgOfParent[parent] = ev.obj("message").str("id")
		}
		if ev.str("type") != "content_block_delta" {
			return
		}
		d := ev.obj("delta")
		var kind protocol.DeltaEventKind
		var text string
		switch d.str("type") {
		case "text_delta":
			kind, text = protocol.DeltaEventKindText, d.str("text")
		case "thinking_delta":
			kind, text = protocol.DeltaEventKindReasoning, d.str("thinking")
		default:
			return
		}
		if text == "" {
			return
		}
		msgID := m.str("api_message_id")
		if msgID == "" {
			msgID = run.msgOfParent[parent]
		}
		index, _ := ev.int("index")
		key := fmt.Sprintf("%s:%d", msgID, index)
		if !run.streamed[key] {
			run.streamed[key] = true
			if kind == protocol.DeltaEventKindText {
				ctx.AddItem(&protocol.AssistantMessage{ID: key, Text: "", ParentID: parent})
			} else {
				ctx.AddItem(&protocol.Reasoning{ID: key, Text: "", ParentID: parent})
			}
		}
		ctx.Delta(key, kind, text)
	case "assistant":
		msg := m.obj("message")
		msgID := msg.str("id")
		for _, raw := range msg.arr("content") {
			block := parseObj(raw)
			index := run.blockCount[msgID]
			run.blockCount[msgID] = index + 1
			key := fmt.Sprintf("%s:%d", msgID, index)
			switch block.str("type") {
			case "text", "thinking":
				// The <synthetic> model's messages are Claude Code's own (an API error, say), which the
				// result has.
				if msg.str("model") == "<synthetic>" {
					continue
				}
				field := "text"
				if block.str("type") == "thinking" {
					field = "thinking"
				}
				text := block.str(field)
				if run.streamed[key] {
					ctx.UpdateItem(key, Patch{"text": text})
				} else if text != "" {
					if field == "text" {
						ctx.AddItem(&protocol.AssistantMessage{ID: key, Text: text, ParentID: parent})
					} else {
						ctx.AddItem(&protocol.Reasoning{ID: key, Text: text, ParentID: parent})
					}
				}
			case "tool_use":
				t := claudeTool(block.str("name"), block.raw("input"))
				t.ID, t.Status, t.ParentID = block.str("id"), protocol.ToolStatusRunning, parent
				ctx.AddItem(t)
			}
		}
	case "user":
		s.user(run, m)
	case "control_request":
		// Read again after a restart, and answered before it (though that wasn't saved): Claude has
		// its answer, and the user isn't asked again.
		if s.answered(run, m.str("request_id")) {
			return
		}
		s.controlRequest(run, m.str("request_id"), orObj(m.obj("request")))
	case "control_cancel_request":
		// It no longer wants an answer, including one a policy is still working out.
		id := m.str("request_id")
		run.dropOpen(id)
		if ours := run.asked[id]; ours != "" {
			ctx.CancelRequest(ours)
		}
	case "result":
		// The turn's requests are moot now; its open questions are cancelled with it. A background
		// subagent's carry on.
		for _, id := range append([]string(nil), run.openOrder...) {
			if call := toolUseOf(run.open[id].Request); call == "" || !inBackground(ctx.Item, call) {
				run.dropOpen(id)
			}
		}
		// Its messages are done with: what was kept to translate them needn't be any more, unless a
		// background subagent is still sending its own.
		background := false
		for _, id := range run.agents {
			if it, ok := ctx.Item(id); ok && runningInBackground(it) {
				background = true
			}
		}
		if !background {
			run.msgOfParent, run.blockCount, run.streamed = map[string]string{}, map[string]int{}, map[string]bool{}
		}
		if ctx.TurnID() == "" {
			run.at = ""
			return
		}
		// The end of a turn Claude made by itself (to tell the agent a background subagent ended)
		// while a turn of the user's waited for it: the user's goes on to its own result, which gets
		// this one's usage too.
		if m.obj("origin").str("kind") == "task-notification" && ctx.TurnID() != run.autoTurn {
			run.heldUsage = addUsage(run.heldUsage, claudeUsage(m))
			return
		}
		// The turn's mark: its last message, the one Claude made by itself in it included.
		at := run.at
		run.at = ""
		s.clearStop()
		failed := m.bool("is_error")
		end := TurnEnd{OK: !failed, Usage: addUsage(run.heldUsage, claudeUsage(m)), SessionAt: at}
		run.heldUsage = nil
		if failed {
			end.Error = m.str("result")
			if end.Error == "" {
				var errs []string
				json.Unmarshal(m.raw("errors"), &errs)
				end.Error = strings.Join(errs, "\n")
			}
			if end.Error == "" {
				end.Error = m.str("subtype")
			}
		}
		if d, ok := m.num("duration_ms"); ok {
			n := int64(d)
			end.DurationMs = &n
		}
		ctx.EndTurn(end)
	}
}

func orObj(m jmap) jmap {
	if m == nil {
		return jmap{}
	}
	return m
}

func (s *claudeSession) user(run *claudeRun, m jmap) {
	ctx := s.ctx
	msg := m.obj("message")
	content := msg.raw("content")
	if m.bool("isReplay") {
		// Claude took in a message: if it was a steered one, it's no longer queued. Claude echoes a
		// message as it was sent: match it with the first sent like that.
		echo := echoKey(content)
		for i, sent := range run.sent {
			if sent.Echo != echo {
				continue
			}
			run.sent = append(run.sent[:i:i], run.sent[i+1:]...)
			for _, id := range sent.IDs {
				ctx.TookIn(id)
			}
			// It's taking its messages in, and its turn for this one may run past the grace: the grace
			// is for a Claude that takes none in. The turn's result carries over what's still queued,
			// which starts it again.
			if run == s.run {
				s.clearSteer()
			}
			return
		}
		return
	}
	if isStr(content) {
		if run.summaryNext != "" && m.bool("isSynthetic") {
			ctx.UpdateItem(run.summaryNext, Patch{"summary": rawStr(content)})
			run.summaryNext = ""
		}
		return
	}
	var blocks []jmap
	json.Unmarshal(content, &blocks)
	for _, b := range blocks {
		if b.str("type") != "tool_result" {
			continue
		}
		it, ok := ctx.Item(b.str("tool_use_id"))
		call, isCall := it.Value.(*protocol.ToolCall)
		if !ok || !isCall {
			continue
		}
		patch := Patch{}
		// A denied call stays denied; its result is what the agent was told.
		if call.Status != protocol.ToolStatusDenied {
			switch {
			case !b.bool("is_error"):
				patch["status"] = protocol.ToolStatusCompleted
			case ctx.Interrupted():
				patch["status"] = protocol.ToolStatusCancelled
			default:
				patch["status"] = protocol.ToolStatusFailed
			}
		}
		patch["result"] = slim(resultText(b.raw("content")))
		if tur := m.obj("tool_use_result"); call.Kind == protocol.ToolKindEdit && tur != nil && !b.bool("is_error") {
			path := ""
			if len(call.Changes) > 0 {
				path = call.Changes[0].Path
			}
			if change := editChange(tur, path); change != nil {
				patch["changes"] = []protocol.FileChange{*change}
			}
		}
		result := patch["result"].(protocol.ToolResult)
		if sub := subagentResult(call, b.bool("is_error"), ctx.Interrupted(), m.obj("tool_use_result"), result.Content); sub != nil {
			patch["subagent"] = sub
			run.addAgent(call.ID)
		}
		ctx.UpdateItem(call.ID, patch)
	}
}

// task takes Claude's task_* messages about a subagent: an Agent call's, or a skill's forked one
// (whose Skill call becomes a subagent call). Other tasks (a command run in the background) aren't.
func (s *claudeSession) task(run *claudeRun, m jmap) {
	ctx := s.ctx
	if m.str("subtype") == "task_started" && m.str("task_type") == "local_agent" && m.str("tool_use_id") != "" {
		it, ok := ctx.Item(m.str("tool_use_id"))
		call, isCall := it.Value.(*protocol.ToolCall)
		if !ok || !isCall {
			return
		}
		if t := m.str("task_id"); t != "" {
			run.tasks[t] = call.ID
		}
		run.addAgent(call.ID)
		patch := Patch{"subagent": subagentStarted(call, m)}
		if call.Kind != protocol.ToolKindSubagent {
			patch["kind"] = protocol.ToolKindSubagent
			if d := m.str("description"); call.Title == "" && d != "" {
				patch["title"] = d
			}
		}
		ctx.UpdateItem(call.ID, patch)
		return
	}
	id := m.str("tool_use_id")
	if id == "" {
		id = run.tasks[m.str("task_id")]
	}
	it, ok := ctx.Item(id)
	call, isCall := it.Value.(*protocol.ToolCall)
	if id == "" || !ok || !isCall || call.Subagent == nil {
		return
	}
	ctx.UpdateItem(call.ID, Patch{"subagent": subagentTask(*call.Subagent, m)})
}

// toolUseOf is the tool call a request of Claude's is about: a can_use_tool's, or an app tool's
// mcp_message.
func toolUseOf(req jmap) string {
	if id := req.str("tool_use_id"); id != "" {
		return id
	}
	return req.obj("message").obj("params").obj("_meta").str("claudecode/toolUseId")
}

func (s *claudeSession) controlRequest(run *claudeRun, requestID string, req jmap) {
	switch req.str("subtype") {
	case "can_use_tool":
		s.canUseTool(run, requestID, req, "", false)
	case "mcp_message":
		s.mcp(run, requestID, req)
	default:
		run.respondError(requestID, fmt.Sprintf("agent-threads doesn't handle %s requests", req.str("subtype")))
	}
}

// canUseTool decides on a tool Claude wants to use: the policy decides, or the user is asked.
// existing (with resumed) is the request the user was asked with before the backend restarted,
// which is taken up again.
func (s *claudeSession) canUseTool(run *claudeRun, requestID string, req jmap, existing string, resumed bool) {
	ctx := s.ctx
	toolUseID := req.str("tool_use_id")
	input := orEmpty(req.raw("input"))
	turn := ctx.TurnID()
	if resumed {
		if o := run.open[requestID]; o != nil {
			turn = o.Turn
		} else {
			turn = ""
		}
	}
	run.setOpen(requestID, &claudeOpen{Turn: turn, Request: req})
	ask := func(request protocol.ThreadRequestValue, toolCallID string, answered func(protocol.Resolution), standing string) string {
		if existing != "" && ctx.Reopen(existing, answered, standing) {
			return existing
		}
		return ctx.Ask(request, toolCallID, answered, standing)
	}
	// Whether Claude still wants this answered: not cancelled, its turn not over (unless it's a
	// background subagent's, which carries on after it), its run not gone.
	wanted := func() bool {
		_, open := run.open[requestID]
		return open && !run.exited && !run.retired && !run.detached && s.run == run &&
			(ctx.TurnID() == turn || (toolUseID != "" && inBackground(ctx.Item, toolUseID)))
	}
	allow := func(updated json.RawMessage) {
		if wanted() {
			run.respond(requestID, map[string]any{"behavior": "allow", "updatedInput": updated})
		}
	}
	deny := func(message string) {
		if wanted() {
			run.respond(requestID, map[string]any{"behavior": "deny", "message": message})
		}
	}
	denied := func() {
		if toolUseID != "" {
			ctx.UpdateItem(toolUseID, Patch{"status": protocol.ToolStatusDenied})
		}
	}

	if req.str("tool_name") == "AskUserQuestion" {
		qs := askQuestions(input)
		if len(qs) == 0 {
			allow(input)
			return
		}
		id := ask(&protocol.QuestionRequest{Questions: qs}, toolUseID, func(res protocol.Resolution) {
			if res.Outcome == protocol.ResolutionOutcomeAnswer {
				answers := map[string]string{}
				for q, a := range res.Answers {
					answers[q] = strings.Join(a, ", ")
				}
				with := parseObj(input)
				if with == nil {
					with = jmap{}
				}
				with["answers"] = mustJSON(answers)
				allow(mustJSON(with))
				if toolUseID != "" {
					ctx.UpdateItem(toolUseID, Patch{"status": protocol.ToolStatusRunning})
				}
			} else {
				msg := res.Message
				if msg == "" {
					msg = "The user didn't answer."
				}
				deny(msg)
				denied()
			}
		}, "")
		run.asked[requestID] = id
		return
	}

	t := claudeTool(req.str("tool_name"), input)
	query := PermissionQuery{Name: t.Name, Kind: t.Kind, Input: input, Title: toolTitle(t), Server: t.Server, Reason: req.str("decision_reason"), ToolCallID: toolUseID}
	if t.Kind == protocol.ToolKindShell {
		query.Command = t.Command
	}
	if call, ok := ctx.Item(toolUseID); ok && toolUseID != "" {
		query.ParentID = call.ParentID()
	}
	// The user was asked before the backend restarted: they still are.
	d := Ask
	if !resumed {
		d = ctx.Decide(query)
	}
	// A policy may answer after Claude stopped asking.
	if !wanted() {
		return
	}
	switch {
	case d.IsAllow():
		allow(input)
	case d.IsAsk():
		id := ask(&protocol.PermissionRequest{Name: t.Name, Kind: t.Kind, Input: input, Title: toolTitle(t), Reason: req.str("decision_reason")}, toolUseID, func(res protocol.Resolution) {
			if res.Outcome == protocol.ResolutionOutcomeAllow {
				allow(input)
				if toolUseID != "" {
					ctx.UpdateItem(toolUseID, Patch{"status": protocol.ToolStatusRunning})
				}
			} else {
				msg := res.Message
				if msg == "" {
					msg = "The user didn't allow this."
				}
				deny(msg)
				denied()
			}
		}, permissionKey(query.Kind, query.Server, query.Name))
		run.asked[requestID] = id
	default:
		msg := d.Message()
		if msg == "" {
			msg = "The app's permission policy doesn't allow this."
		}
		deny(msg)
		denied()
	}
}

// mcp answers the app's tools, as an MCP server on the control channel.
func (s *claudeSession) mcp(run *claudeRun, requestID string, req jmap) {
	msg := orObj(req.obj("message"))
	reply := func(body map[string]any) {
		resp := map[string]any{"jsonrpc": "2.0", "id": rpcID(msg)}
		for k, v := range body {
			resp[k] = v
		}
		run.respond(requestID, map[string]any{"mcp_response": resp})
	}
	if name := req.str("server_name"); name != appServer {
		reply(map[string]any{"error": map[string]any{"code": -32601, "message": fmt.Sprintf("there's no MCP server %s in process", name)}})
		return
	}
	if msg.raw("id") == nil {
		reply(map[string]any{"result": map[string]any{}}) // a notification
		return
	}
	ctx := s.ctx
	tools := ctx.Config().Tools
	params := msg.obj("params")
	switch msg.str("method") {
	case "initialize":
		version := params.str("protocolVersion")
		if version == "" {
			version = "2025-06-18"
		}
		reply(map[string]any{"result": map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": appServer, "version": "1.0.0"}}})
	case "ping":
		reply(map[string]any{"result": map[string]any{}})
	case "tools/list":
		reply(map[string]any{"result": map[string]any{"tools": toolList(tools)}})
	case "tools/call":
		name := params.str("name")
		tool := findTool(tools, name)
		if tool == nil {
			reply(map[string]any{"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("There's no tool %s.", name)}}, "isError": true}})
			return
		}
		toolCallID := params.obj("_meta").str("claudecode/toolUseId")
		// Saved before it runs, so a backend that restarts while it does answers it rather than run it
		// again (see reopen).
		run.setOpen(requestID, &claudeOpen{Turn: ctx.TurnID(), Request: req})
		ctx.Persist(func(err error) {
			if err != nil {
				if run.detached {
					return
				}
				run.dropOpen(requestID)
				reply(map[string]any{"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": "The app couldn't save its state, so it didn't run this tool."}}, "isError": true}})
				return
			}
			if _, open := run.open[requestID]; !open || run.exited || run.detached {
				return
			}
			t := ctx.Thread()
			call := ToolContext{ThreadID: ctx.ThreadID(), Metadata: metadataOf(t), ToolCallID: toolCallID}
			args := orEmpty(params.raw("arguments"))
			go func() {
				out := runTool(run.toolCtx, tool, args, call)
				ctx.Post(func() {
					// The backend shut down while it ran (and cancelled it): it's left open, as saved, for
					// the backend that re-attaches to answer.
					if run.detached {
						return
					}
					if toolCallID != "" {
						ctx.ToolOutput(toolCallID, out.Structured)
					}
					reply(map[string]any{"result": mcpResult(out)})
					// Saved as answered, though no event says so: a restart doesn't answer it again.
					ctx.Persist(func(error) {})
				})
			}()
		})
	default:
		reply(map[string]any{"error": map[string]any{"code": -32601, "message": fmt.Sprintf("method %s isn't supported", msg.str("method"))}})
	}
}

func toolList(tools []Tool) []any {
	out := []any{}
	for _, t := range tools {
		out = append(out, map[string]any{"name": t.Name(), "description": t.Description(), "inputSchema": t.InputSchema()})
	}
	return out
}

func mcpResult(out ToolOutput) map[string]any {
	r := map[string]any{"content": []any{map[string]any{"type": "text", "text": out.Text}}}
	if out.IsError {
		r["isError"] = true
	}
	if out.Structured != nil {
		r["structuredContent"] = out.Structured
	}
	return r
}

// echoKey is what identifies a user message in Claude's echo of it: its text blocks and how many
// images it has (Claude echoes the content as it was sent).
func echoKey(content json.RawMessage) string {
	if isStr(content) {
		return string(mustJSON([]any{rawStr(content), 0}))
	}
	var blocks []jmap
	json.Unmarshal(content, &blocks)
	var texts []string
	images := 0
	for _, b := range blocks {
		switch b.str("type") {
		case "text":
			texts = append(texts, b.str("text"))
		case "image":
			images++
		}
	}
	return string(mustJSON([]any{strings.Join(texts, "\n"), images}))
}

func echoKeyBlocks(content []map[string]any) string {
	return echoKey(mustJSON(content))
}

func claudeExitError(status ExitStatus, stderr []string) string {
	if status.Err != nil {
		return "Claude Code couldn't be started: " + status.Err.Error()
	}
	return "Claude Code " + exitHow(status) + " during the turn." + stderrTail(stderr)
}

func exitHow(status ExitStatus) string {
	if status.Signal != "" {
		return "was stopped by " + status.Signal
	}
	if status.Code != nil {
		return fmt.Sprintf("exited with code %d", *status.Code)
	}
	return "exited with code null"
}

func stderrTail(stderr []string) string {
	tail := strings.TrimSpace(strings.Join(stderr, "\n"))
	if tail == "" {
		return ""
	}
	if len(tail) > 2000 {
		tail = tail[len(tail)-2000:]
	}
	return "\n" + tail
}

// writePlugin writes a plugin (named app) holding the skills, for --plugin-dir.
func writePlugin(dir string, skills []Skill) (string, error) {
	if err := os.MkdirAll(filepath.Join(dir, ".claude-plugin"), 0o755); err != nil {
		return "", err
	}
	manifest := mustJSON(map[string]any{"name": appServer, "version": "1.0.0", "description": "The app's skills"})
	if err := os.WriteFile(filepath.Join(dir, ".claude-plugin", "plugin.json"), manifest, 0o644); err != nil {
		return "", err
	}
	if _, err := writeSkills(filepath.Join(dir, "skills"), skills); err != nil {
		return "", err
	}
	return dir, nil
}

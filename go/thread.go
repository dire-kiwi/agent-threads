package agentthreads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// One thread, live: its state (folded from its events with protocol.ApplyEvent), the running turn,
// the steering queue and open requests. Every change is an event, numbered, applied, sent to the
// subscribers, and saved to the store in order (deltas aren't saved). All of it runs on the
// thread's loop; what's saved is handed to a writer goroutine in batches, in order.

// turnState is the running turn.
type turnState struct {
	ID          string `json:"id"`
	Interrupted bool   `json:"interrupted"`
	// Carried is how many turns in a row (this one included) are retries for messages left queued
	// that took none in: carried over from the turn before, or sent again with an explicit message.
	Carried int `json:"carried,omitempty"`
	// Progressed says the harness took in a queued message during it.
	Progressed bool `json:"progressed,omitempty"`
}

// maxCarried is how many retries in a row for queued messages may take none in.
const maxCarried = 3

// Steered messages, and who has them. A steered message is queued (its item has `queued`, and its
// id is in queue) until the harness echoes it back as taken in (TookIn); nothing else unqueues it.
// Until then it's either with the session's live process (written to its stdin) or with nobody.
// When a turn ends with messages queued, endTurn either carries them over (a new turn, which the
// live process takes them into, or a new process if there's none) or gives up on them: then the
// session releases them, stopping any process that has them so it can't act on them unseen, and
// they're sent again, first, with the next message the user sends. (The driver sends messages that
// go together as one: a harness may make a turn of each.)

type openRequest struct {
	request  protocol.ThreadRequest
	answered func(protocol.Resolution)
	// standing is the tool it's about (permissionKey), for an answer given "always".
	standing *StandingKey
	// late says it's a question kept open after its turn ended (Options.LateAnswers): its answer is
	// sent as the next message, unless the user sends one first.
	late bool
	// users is how many messages the user had sent when it was opened: one sent since means the
	// conversation has moved on, and it isn't kept open after its turn.
	users int
}

// outgoing is a message as sent: its text and attachments, and the client's id for it.
type outgoing struct {
	text        string
	attachments []protocol.Attachment
	clientID    string
}

// batch is what's saved together: events, the runs saved with them, the thread, and a snapshot.
type batch struct {
	events   []protocol.ThreadEvent
	runs     []RunRecord
	thread   *protocol.Thread
	snapshot *protocol.Snapshot
	done     []func(error)
	// count is how many takes it is.
	count int
}

type savedRun struct {
	record RunRecord
	json   string
}

type threadRuntime struct {
	sdk     *AgentThreads
	id      string
	loop    *loop
	config  ThreadConfig
	launch  LaunchOptions // how its harness process is started: stored with the thread
	policy  PermissionPolicy
	session Session
	turn    *turnState
	// closing says the backend is shutting down: a turn that ends doesn't start another.
	closing bool
	// lostRun is the run it had when it was loaded, which was lost (not re-attached to).
	lostRun string
	// reattachedRun is the run it had when it was loaded, which it re-attached to.
	reattachedRun string

	// state is the live state, with the text streamed so far: written on the loop, read anywhere.
	stateMu sync.RWMutex
	state   protocol.Snapshot
	// saved is the saved events' state, without deltas: what a change is a change to.
	saved protocol.Snapshot

	queue         []string // ids of queued user messages, oldest first
	requests      map[string]*openRequest
	requestOrder  []string
	unsaved       []protocol.ThreadEvent
	threadChanged bool
	flushQueued   bool
	snapshotDue   bool
	persists      []func(error)
	// run is the run record last taken to be saved, while its run goes on (with a durable spawner).
	run *savedRun
	// streaming is the items text has streamed into since the turn began (whose text may not be
	// saved yet).
	streaming map[string]bool
	// structured is app tools' structured output, by tool call, until the harness gives the call its
	// result.
	structured map[string]json.RawMessage

	// The writer's side: batches taken on the loop, written in order.
	wmu      sync.Mutex
	batches  []*batch
	taken    int
	written  int
	failure  error
	writing  bool
	backoff  time.Duration
	changed  chan struct{} // closed (and replaced) whenever written or failure changes
	disposed bool
	// sessionDone is closed once the session has closed (Close called it), and detached says its
	// run was left going instead.
	sessionDone chan struct{}
	detached    bool
	// raw is the harness message being handled, which events made now have as their raw (with the
	// Raw option).
	raw json.RawMessage
}

func newRuntime(sdk *AgentThreads, state protocol.Snapshot, config ThreadConfig, launch LaunchOptions, policy PermissionPolicy) *threadRuntime {
	rt := &threadRuntime{
		sdk:        sdk,
		id:         state.Thread.ID,
		state:      state,
		saved:      state,
		config:     config,
		launch:     launch,
		policy:     policy,
		requests:   map[string]*openRequest{},
		streaming:  map[string]bool{},
		structured: map[string]json.RawMessage{},
		changed:    make(chan struct{}),
	}
	// Messages left queued (by a harness that kept failing, or before a restart) go with the next.
	for _, it := range state.Items {
		if m, ok := it.Value.(*protocol.UserMessage); ok && m.Queued {
			rt.queue = append(rt.queue, m.ID)
		}
	}
	rt.loop = newLoop(rt.take, sdk.reportError)
	return rt
}

// ---------- ThreadContext ----------

func (rt *threadRuntime) ThreadID() string { return rt.id }

func (rt *threadRuntime) Thread() protocol.Thread { return rt.state.Thread }

func (rt *threadRuntime) Config() ThreadConfig { return rt.config }

func (rt *threadRuntime) Launch() LaunchOptions { return rt.launch }

func (rt *threadRuntime) Spawner() Spawner { return rt.sdk.spawner }

func (rt *threadRuntime) TurnID() string {
	if rt.turn == nil {
		return ""
	}
	return rt.turn.ID
}

func (rt *threadRuntime) Interrupted() bool { return rt.turn != nil && rt.turn.Interrupted }

func (rt *threadRuntime) Post(fn func()) { rt.loop.post(fn) }

func (rt *threadRuntime) Error(err error) { rt.sdk.reportError(err) }

// snapshot is a copy of the live state, from any goroutine.
func (rt *threadRuntime) snapshot() protocol.Snapshot {
	rt.stateMu.RLock()
	s := rt.state
	rt.stateMu.RUnlock()
	return clone(s)
}

func (rt *threadRuntime) liveThread() protocol.Thread {
	rt.stateMu.RLock()
	defer rt.stateMu.RUnlock()
	return clone(rt.state.Thread)
}

// ---------- events ----------

func (rt *threadRuntime) emit(v protocol.ThreadEventValue) {
	e := protocol.ThreadEvent{Value: v}
	// An item or request has the harness message it came from, and its event doesn't as well.
	if rt.raw != nil {
		switch x := v.(type) {
		case *protocol.ItemAddedEvent:
			x.Item.SetRaw(rt.raw)
		case *protocol.RequestOpenedEvent:
			x.Request.SetRaw(rt.raw)
		default:
			e.SetRaw(rt.raw)
		}
	}
	saved := e.Saved()
	seq := rt.state.Seq
	if saved {
		seq++
	}
	e.Number(rt.id, seq)
	next := protocol.ApplyEvent(rt.state, e)
	rt.stateMu.Lock()
	rt.state = next
	rt.stateMu.Unlock()
	if saved {
		rt.saved = protocol.ApplyEvent(rt.saved, e)
		rt.unsaved = append(rt.unsaved, e)
		rt.flushQueued = true
	}
	rt.sdk.publish(e)
}

// take runs after each of the loop's tasks: what the task saved is taken, as of now, for the writer.
func (rt *threadRuntime) take() {
	if !rt.flushQueued && !rt.snapshotDue && len(rt.persists) == 0 {
		return
	}
	rt.flushQueued = false
	b := &batch{events: rt.unsaved, done: rt.persists, count: 1}
	rt.unsaved, rt.persists = nil, nil
	// Taken at the same moment as the events, so the run's offset and state are as of them.
	b.runs = rt.runs()
	if rt.threadChanged {
		rt.threadChanged = false
		t := withLaunch(clone(rt.saved.Thread), rt.launch)
		b.thread = &t
	}
	if rt.snapshotDue {
		rt.snapshotDue = false
		s := clone(rt.saved)
		b.snapshot = &s
	}
	rt.wmu.Lock()
	rt.batches = append(rt.batches, b)
	rt.taken++
	start := !rt.writing && !rt.disposed
	if start {
		rt.writing = true
	}
	rt.wmu.Unlock()
	if start {
		go rt.write()
	}
}

// write saves the batches taken, in order, until there are none. A write that fails is tried again
// (with the batches after it), in order, so nothing is lost or numbered around a gap.
func (rt *threadRuntime) write() {
	store := rt.sdk.store
	for {
		rt.wmu.Lock()
		if len(rt.batches) == 0 || rt.disposed && rt.failure != nil {
			rt.writing = false
			rt.wmu.Unlock()
			return
		}
		// What's waiting is written as one.
		if len(rt.batches) > 1 {
			rt.batches = []*batch{merge(rt.batches)}
		}
		b := rt.batches[0]
		rt.wmu.Unlock()

		err := rt.writeBatch(store, b)

		rt.wmu.Lock()
		done := b.done
		b.done = nil
		if err == nil {
			rt.batches = rt.batches[1:]
			rt.written += b.count
			rt.failure = nil
			rt.backoff = 0
		} else {
			rt.failure = err
			rt.backoff = min(max(rt.backoff*2, 250*time.Millisecond), 30*time.Second)
		}
		close(rt.changed)
		rt.changed = make(chan struct{})
		wait := rt.backoff
		rt.wmu.Unlock()
		for _, fn := range done {
			rt.loop.post(func() { fn(err) })
		}
		if err != nil {
			rt.sdk.reportError(err)
			time.Sleep(wait)
		}
	}
}

func (rt *threadRuntime) writeBatch(store Store, b *batch) error {
	ctx := background
	if len(b.events) > 0 || len(b.runs) > 0 {
		err := store.AppendEvents(ctx, rt.id, b.events, b.runs)
		// An append reported as failed may have happened anyway: keep only what the store lacks.
		if errors.Is(err, ErrSeq) {
			last, lerr := store.LastSeq(ctx, rt.id)
			if lerr != nil {
				return lerr
			}
			var rest []protocol.ThreadEvent
			for _, e := range b.events {
				if e.Seq() > last {
					rest = append(rest, e)
				}
			}
			if len(rest) == len(b.events) {
				return err
			}
			err = store.AppendEvents(ctx, rt.id, rest, b.runs)
		}
		if err != nil {
			return err
		}
		// Written: a retry doesn't write them again.
		b.events, b.runs = nil, nil
	}
	if b.thread != nil {
		if err := store.UpdateThread(ctx, *b.thread); err != nil {
			return err
		}
		b.thread = nil
	}
	if b.snapshot != nil {
		// Not the events' concern: one that fails is reported, and a later one will do.
		if err := store.SaveSnapshot(ctx, rt.id, *b.snapshot); err != nil {
			rt.sdk.reportError(err)
		}
		b.snapshot = nil
	}
	return nil
}

// merge is the batches as one: their events in order, each run as last given, the last thread and
// snapshot. (What a batch has written already, of a write that failed after it, it has no more.)
func merge(batches []*batch) *batch {
	out := &batch{}
	at := map[string]int{}
	for _, b := range batches {
		out.count += b.count
		out.events = append(out.events, b.events...)
		for _, r := range b.runs {
			if i, ok := at[r.ID]; ok {
				out.runs[i] = r
			} else {
				at[r.ID] = len(out.runs)
				out.runs = append(out.runs, r)
			}
		}
		if b.thread != nil {
			out.thread = b.thread
		}
		if b.snapshot != nil {
			out.snapshot = b.snapshot
		}
		out.done = append(out.done, b.done...)
	}
	return out
}

// runs is, with a durable spawner, the runs to save with the events: the session's running one, if
// it changed since it was last taken, and the one before it as ended if that's done.
func (rt *threadRuntime) runs() []RunRecord {
	if _, ok := rt.sdk.spawner.(DurableSpawner); !ok {
		return nil
	}
	name := rt.sdk.spawner.Name()
	var out []RunRecord
	stamp := now()
	thread := rt.saved.Thread
	var cp *RunCheckpoint
	if d, ok := rt.session.(DurableSession); ok {
		cp = d.Checkpoint()
	} else if thread.Run != nil && string(thread.Run.Spawner) == name {
		// A driver that can't re-attach still has its run recorded, so a restart can stop it.
		cp = &RunCheckpoint{ID: thread.Run.ID}
	}
	var before *RunRecord
	if rt.run != nil {
		before = &rt.run.record
	}
	if before != nil && (cp == nil || before.ID != cp.ID) {
		if before.Active() {
			ended := *before
			ended.EndedAt = stamp
			out = append(out, ended)
		}
		rt.run = nil
		before = nil
	}
	// A run that's over is saved once more, as it ended.
	if cp == nil || (before != nil && !before.Active()) {
		return out
	}
	started := stamp
	if before != nil {
		started = before.StartedAt
	} else if thread.Run != nil && thread.Run.ID == cp.ID && thread.Run.StartedAt != "" {
		started = thread.Run.StartedAt
	}
	data := map[string]any{"turn": rt.turn, "state": cp.State}
	if cp.Dir != "" {
		data["dir"] = cp.Dir
	}
	if cp.Input != nil {
		data["input"] = *cp.Input
	}
	if live := rt.liveText(); len(live) > 0 {
		data["live"] = live
	}
	// App tools' structured output whose calls the harness hasn't given their result yet.
	if len(rt.structured) > 0 {
		data["structured"] = rt.structured
	}
	dataJSON, err := json.Marshal(data)
	if err != nil {
		rt.sdk.reportError(fmt.Errorf("agentthreads: the run's state can't be saved: %w", err))
		return out
	}
	record := RunRecord{ID: cp.ID, ThreadID: rt.id, Spawner: name, Offset: cp.Offset, StartedAt: started, Data: dataJSON}
	if cp.Ended {
		record.EndedAt = stamp
	}
	j, _ := json.Marshal(record)
	if rt.run == nil || rt.run.json != string(j) {
		out = append(out, record)
	}
	rt.run = &savedRun{record: record, json: string(j)}
	return out
}

// liveText is the text streamed into items that the saved events don't have yet (deltas aren't
// saved), by item: saved with the run, since the run's output it came from won't be read again.
func (rt *threadRuntime) liveText() map[string]string {
	var live map[string]string
	for id := range rt.streaming {
		now, ok1 := findItem(rt.state.Items, id)
		saved, ok2 := findItem(rt.saved.Items, id)
		if !ok1 || !ok2 {
			continue
		}
		a, ok3 := now.Text()
		b, ok4 := saved.Text()
		if ok3 && ok4 && a != b {
			if live == nil {
				live = map[string]string{}
			}
			live[id] = a
		}
	}
	return live
}

// adoptRun takes the run record saved last, for a backend that re-attached to it, with the text
// that had streamed in as of it: shown again, as deltas, before the run's output is read on.
func (rt *threadRuntime) adoptRun(record RunRecord) {
	j, _ := json.Marshal(record)
	rt.run = &savedRun{record: record, json: string(j)}
	var data struct {
		Live       map[string]string          `json:"live"`
		Structured map[string]json.RawMessage `json:"structured"`
	}
	json.Unmarshal(record.Data, &data)
	rt.structured = map[string]json.RawMessage{}
	for id, v := range data.Structured {
		rt.structured[id] = v
	}
	for id, text := range data.Live {
		item, ok := rt.Item(id)
		if !ok {
			continue
		}
		have, ok := item.Text()
		if !ok || len(text) < len(have) || text[:len(have)] != have {
			continue
		}
		kind := protocol.DeltaEventKindReasoning
		if item.Type() == "assistant_message" {
			kind = protocol.DeltaEventKindText
		}
		rt.Delta(id, kind, text[len(have):])
	}
}

// Persist saves the run's checkpoint now, with whatever events there are, and calls done once it's
// saved (with a durable spawner; otherwise at once).
func (rt *threadRuntime) Persist(done func(error)) {
	if _, ok := rt.sdk.spawner.(DurableSpawner); !ok {
		rt.loop.post(func() { done(nil) })
		return
	}
	rt.persists = append(rt.persists, done)
	rt.flushQueued = true
}

// scheduleFlush has the run saved after this task, though no event says so.
func (rt *threadRuntime) scheduleFlush() { rt.flushQueued = true }

// waitSaved waits until everything taken so far is saved; it returns the store's error if it
// can't be. Not on the loop: after loop.call, so what the call did has been taken.
func (rt *threadRuntime) waitSaved(ctx context.Context) error {
	rt.wmu.Lock()
	target := rt.taken
	for rt.written < target {
		if rt.failure != nil {
			err := rt.failure
			rt.wmu.Unlock()
			return err
		}
		ch := rt.changed
		rt.wmu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
		rt.wmu.Lock()
	}
	rt.wmu.Unlock()
	return nil
}

// saveSnapshot has a snapshot saved with the next batch, so loading the thread needn't fold all its
// events.
func (rt *threadRuntime) saveSnapshot() { rt.snapshotDue = true }

// closeSession has the session close (once), and is closed when it has; nil if the thread's loop has
// stopped, or its run was left going (Detach). It gives up waiting for a busy loop to take the close
// once ctx is done (which is then still taken, and closes what it returns once it's done).
func (rt *threadRuntime) closeSession(ctx context.Context) (<-chan struct{}, error) {
	rt.wmu.Lock()
	if rt.detached {
		rt.wmu.Unlock()
		return nil, nil
	}
	if rt.sessionDone != nil {
		done := rt.sessionDone
		rt.wmu.Unlock()
		return done, nil
	}
	done := make(chan struct{})
	rt.sessionDone = done
	rt.wmu.Unlock()
	if err := rt.loop.callCtx(ctx, func() { rt.session.Close(func() { close(done) }) }); err != nil {
		if errors.Is(err, errLoopStopped) {
			close(done) // Nothing's left to stop it.
			return nil, nil
		}
		return done, err
	}
	return done, nil
}

// sessionClosing says its session is closing or closed (Close or Delete), not left going.
func (rt *threadRuntime) sessionClosing() bool {
	rt.wmu.Lock()
	defer rt.wmu.Unlock()
	return rt.sessionDone != nil
}

func (rt *threadRuntime) markDetached() {
	rt.wmu.Lock()
	rt.detached = true
	rt.wmu.Unlock()
}

func (rt *threadRuntime) detachedRun() bool {
	rt.wmu.Lock()
	defer rt.wmu.Unlock()
	return rt.detached
}

// dispose stops the thread's loop, and its writes once they've failed.
func (rt *threadRuntime) dispose() {
	rt.wmu.Lock()
	rt.disposed = true
	rt.wmu.Unlock()
	rt.loop.stop()
}

// ---------- items and the thread ----------

func findItem(items []protocol.Item, id string) (protocol.Item, bool) {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].ID() == id {
			return items[i], true
		}
	}
	return protocol.Item{}, false
}

func (rt *threadRuntime) Item(id string) (protocol.Item, bool) {
	return findItem(rt.saved.Items, id)
}

func (rt *threadRuntime) AddItem(v protocol.ItemValue) {
	item := protocol.Item{Value: v}
	if rt.turn != nil && item.TurnID() == "" {
		item.SetTurnID(rt.turn.ID)
	}
	rt.emit(&protocol.ItemAddedEvent{Item: item})
}

func (rt *threadRuntime) UpdateItem(id string, patch Patch) {
	item, ok := rt.Item(id)
	if !ok {
		return
	}
	if structured, ok := rt.structured[id]; ok && patch["result"] != nil {
		var result map[string]json.RawMessage
		if json.Unmarshal(mustJSON(patch["result"]), &result) == nil {
			if _, has := result["structured"]; !has {
				result["structured"] = structured
			}
			next := Patch{}
			for k, v := range patch {
				next[k] = v
			}
			next["result"] = result
			patch = next
		}
		delete(rt.structured, id)
	}
	fields := itemFields(item)
	changed := map[string]json.RawMessage{}
	for k, v := range patch {
		if k == "id" || k == "type" {
			continue
		}
		if v == nil {
			if _, has := fields[k]; has {
				changed[k] = json.RawMessage("null")
			}
			continue
		}
		data, err := json.Marshal(v)
		if err != nil {
			rt.sdk.reportError(fmt.Errorf("agentthreads: an item's %s can't be written: %w", k, err))
			continue
		}
		if old, has := fields[k]; !has || !sameJSON(old, data) {
			changed[k] = data
		}
	}
	if len(changed) > 0 {
		rt.emit(&protocol.ItemUpdatedEvent{ItemID: id, Patch: changed})
	}
}

func itemFields(item protocol.Item) map[string]json.RawMessage {
	data, _ := json.Marshal(item)
	var fields map[string]json.RawMessage
	json.Unmarshal(data, &fields)
	return fields
}

func (rt *threadRuntime) ToolOutput(toolCallID string, structured any) {
	if structured == nil {
		return
	}
	data, err := json.Marshal(structured)
	if err != nil {
		rt.sdk.reportError(fmt.Errorf("agentthreads: a tool's structured output isn't JSON: %w", err))
		return
	}
	rt.structured[toolCallID] = data
}

func (rt *threadRuntime) Delta(itemID string, kind protocol.DeltaEventKind, text string) {
	if text == "" {
		return
	}
	rt.streaming[itemID] = true
	// Where it goes: the length of the item's text so far, the deltas before it included.
	var offset int64
	if item, ok := findItem(rt.state.Items, itemID); ok {
		if t, ok := item.Text(); ok {
			offset = protocol.TextLen(t)
		}
	}
	rt.emit(&protocol.DeltaEvent{ItemID: itemID, Kind: kind, Offset: offset, Text: text})
}

func (rt *threadRuntime) SetThread(change func(*protocol.Thread)) {
	before := rt.state.Thread
	next := clone(before)
	change(&next)
	next.ID, next.CreatedAt = before.ID, before.CreatedAt
	a, b := before, next
	a.UpdatedAt, b.UpdatedAt = "", ""
	if sameJSONValue(a, b) {
		return
	}
	next.UpdatedAt = now()
	rt.threadChanged = true
	rt.emit(&protocol.ThreadUpdatedEvent{Thread: next})
}

func (rt *threadRuntime) RateLimits(limits []protocol.RateLimit) {
	if len(limits) == 0 {
		return
	}
	rt.SetThread(func(t *protocol.Thread) {
		all := map[string]protocol.RateLimit{}
		for _, l := range t.RateLimits {
			all[l.ID] = l
		}
		for _, l := range limits {
			all[l.ID] = l
		}
		out := make([]protocol.RateLimit, 0, len(all))
		for _, id := range sortedKeys(all) {
			out = append(out, all[id])
		}
		t.RateLimits = out
	})
}

func (rt *threadRuntime) FromHarness(runID, line string, handle func()) {
	var message json.RawMessage
	if json.Valid([]byte(line)) {
		message = json.RawMessage(line)
	}
	before := rt.raw
	if rt.sdk.options.Raw && message != nil {
		rt.raw = message
	}
	func() {
		defer func() { rt.raw = before }()
		handle()
	}()
	if fn := rt.sdk.options.OnHarnessMessage; fn != nil {
		m := HarnessMessage{ThreadID: rt.id, RunID: runID, Harness: rt.state.Thread.Harness, Line: line, Message: message}
		func() {
			defer func() {
				if r := recover(); r != nil {
					rt.sdk.reportError(fmt.Errorf("agentthreads: OnHarnessMessage panicked: %v", r))
				}
			}()
			fn(m)
		}()
	}
}

// setLaunch changes how the harness process is started, from the next one; it's saved with the
// thread.
func (rt *threadRuntime) setLaunch(launch LaunchOptions) {
	if sameJSONValue(launch, rt.launch) {
		return
	}
	rt.launch = clone(launch)
	rt.threadChanged = true
	rt.flushQueued = true
	rt.session.OptionsChanged()
}

func sameJSONValue(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && sameJSON(x, y)
}

// ---------- turns ----------

// send sends a message: it starts a turn, or steers the running one.
func (rt *threadRuntime) send(m outgoing) {
	id := NewID("um")
	// The conversation moves on: questions kept open after their turns can't be answered.
	rt.cancelLate()
	if rt.turn == nil {
		// Messages still queued from before weren't delivered: they go first, in this turn, and stay
		// queued until the harness takes them in. Such a turn is a retry for them.
		left := rt.Queued()
		rt.turn = &turnState{ID: NewID("turn")}
		if len(left) > 0 {
			rt.turn.Carried = 1
		}
		for _, q := range left {
			rt.UpdateItem(q.ID, Patch{"turn_id": rt.turn.ID})
		}
		rt.AddItem(userItem(id, m, false))
		rt.emit(&protocol.TurnStartedEvent{TurnID: rt.turn.ID})
		rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusRunning; t.Error = "" })
		msgs := make([]Message, 0, len(left)+1)
		for _, q := range left {
			msgs = append(msgs, toMessage(q))
		}
		rt.session.Start(append(msgs, Message{ID: id, Text: m.text, Attachments: m.attachments}))
		return
	}
	rt.AddItem(userItem(id, m, true))
	rt.queue = append(rt.queue, id)
	rt.session.Steer(Message{ID: id, Text: m.text, Attachments: m.attachments})
}

func userItem(id string, m outgoing, steered bool) *protocol.UserMessage {
	u := &protocol.UserMessage{ID: id, Text: m.text, ClientID: m.clientID}
	if len(m.attachments) > 0 {
		u.Attachments = m.attachments
	}
	if steered {
		u.Steered, u.Queued = true, true
	}
	return u
}

func toMessage(u *protocol.UserMessage) Message {
	return Message{ID: u.ID, Text: u.Text, Attachments: u.Attachments}
}

func (rt *threadRuntime) Queued() []*protocol.UserMessage {
	var out []*protocol.UserMessage
	for _, id := range rt.queue {
		if it, ok := rt.Item(id); ok {
			if u, ok := it.Value.(*protocol.UserMessage); ok {
				out = append(out, u)
			}
		}
	}
	return out
}

func (rt *threadRuntime) TookIn(id string) bool {
	at := -1
	for i, q := range rt.queue {
		if q == id {
			at = i
			break
		}
	}
	if at < 0 {
		return false
	}
	rt.queue = append(rt.queue[:at:at], rt.queue[at+1:]...)
	rt.UpdateItem(id, Patch{"queued": nil})
	if rt.turn != nil {
		rt.turn.Progressed = true
	}
	return true
}

func (rt *threadRuntime) interrupt() {
	if rt.turn == nil || rt.turn.Interrupted {
		return
	}
	rt.turn.Interrupted = true
	rt.session.Interrupt()
	// No event says so, but a run that outlives the backend is saved with its turn.
	if _, ok := rt.sdk.spawner.(DurableSpawner); ok {
		rt.scheduleFlush()
	}
}

func (rt *threadRuntime) EndTurn(end TurnEnd) { rt.endTurn(end, true) }

// endTurn ends the running turn. Its queued messages are carried over to a new turn unless carry
// is false (shutting down, or recovering a turn the backend lost), or they've been tried enough.
func (rt *threadRuntime) endTurn(end TurnEnd, carry bool) {
	turn := rt.turn
	if turn == nil {
		return
	}
	// What a background subagent that's still running does carries on after the turn: its text
	// still streaming, its calls (and their structured output, still to go with their results)
	// and its requests.
	ending := func(id string) bool { return !inBackground(rt.Item, id) }
	// Text streamed but never finished (its process went first) is kept as it was shown.
	rt.finishText(ending)
	for id := range rt.structured {
		if ending(id) {
			delete(rt.structured, id)
		}
	}
	for _, it := range rt.state.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok && c.TurnID == turn.ID && (c.Status == protocol.ToolStatusRunning || c.Status == protocol.ToolStatusPending) && !inBackground(rt.Item, c.ID) {
			patch := Patch{"status": protocol.ToolStatusCancelled}
			// A subagent cut short (by an interrupt, or its process ending) is stopped with its call.
			if saved, ok := rt.Item(c.ID); ok {
				if s := saved.Value.(*protocol.ToolCall).Subagent; s != nil && s.Status == protocol.SubagentStatusRunning {
					stopped := *s
					stopped.Status = protocol.SubagentStatusStopped
					patch["subagent"] = stopped
				}
			}
			rt.UpdateItem(c.ID, patch)
		}
	}
	// Questions are kept open after the turn (some may be already: see CancelRequest), unless
	// messages are left queued, which a turn carries over or the next message sends: the
	// conversation has moved on.
	for _, id := range append([]string(nil), rt.requestOrder...) {
		r := rt.requests[id]
		if r == nil {
			continue
		}
		if r.late {
			if len(rt.queue) > 0 {
				rt.dropRequest(id)
				rt.emit(&protocol.RequestResolvedEvent{RequestID: id, Resolution: cancelled("")})
			}
			continue
		}
		if t := r.request.TurnID(); t != "" && t != turn.ID {
			continue
		}
		if call := r.request.ToolCallID(); call != "" && inBackground(rt.Item, call) {
			continue
		}
		rt.dropRequest(id)
		users := r.users
		if !rt.keepLate(id, r.request, &users) {
			rt.emit(&protocol.RequestResolvedEvent{RequestID: id, Resolution: cancelled("")})
		}
	}
	ok := end.OK && !turn.Interrupted
	errText := ""
	if !ok && !turn.Interrupted {
		errText = end.Error
		if errText == "" {
			errText = "The turn failed."
		}
	}
	rt.AddItem(&protocol.TurnResult{ID: NewID("tr"), OK: ok, Interrupted: turn.Interrupted, Error: errText, Usage: end.Usage, DurationMs: end.DurationMs})
	rt.emit(&protocol.TurnCompletedEvent{TurnID: turn.ID})
	rt.turn = nil
	usage := addUsage(rt.state.Thread.Usage, end.Usage)

	// Queued messages are carried over to the next turn, unless:
	// - shutting down (which closes the process that has them), or the turn was lost (its process
	//   is gone): they wait, queued, for the next message;
	// - that's been tried enough: a retry that was interrupted (the user wants it stopped), one that
	//   failed with no process left holding them, or too many in a row that took none in. Then a
	//   process that has them is stopped, and they wait too. A retry that failed while its process
	//   lives and holds them carries over again (to the limit), since that process would otherwise
	//   take them in unseen. (A process holding several makes a turn of each, so a retry that took
	//   one in has made progress.)
	left := rt.Queued()
	retry := turn.Carried > 0
	carried := turn.Carried
	if turn.Progressed {
		carried = 0
	}
	live := rt.session != nil && rt.session.Live()
	giveUp := len(left) == 0 || !carry || rt.closing || carried >= maxCarried || (retry && turn.Interrupted) || (carried > 0 && !ok && !live)
	if giveUp {
		status := protocol.ThreadStatusIdle
		if errText != "" {
			status = protocol.ThreadStatusError
		} else if rt.waiting() {
			status = protocol.ThreadStatusWaiting
		}
		rt.SetThread(func(t *protocol.Thread) { t.Status = status; t.Error = errText; t.Usage = usage })
		if len(left) > 0 && carry && !rt.closing && rt.session != nil {
			rt.session.Release()
		}
		if len(left) > 0 && !rt.closing {
			rt.undelivered(len(left))
		}
		rt.saveSnapshot()
		return
	}
	// The next turn starts straight away, so the thread doesn't go idle in between.
	rt.turn = &turnState{ID: NewID("turn"), Carried: carried + 1}
	for _, q := range left {
		rt.UpdateItem(q.ID, Patch{"turn_id": rt.turn.ID})
	}
	rt.emit(&protocol.TurnStartedEvent{TurnID: rt.turn.ID})
	rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusRunning; t.Error = ""; t.Usage = usage })
	msgs := make([]Message, 0, len(left))
	for _, q := range left {
		msgs = append(msgs, toMessage(q))
	}
	rt.session.CarryOver(msgs)
}

// finishText keeps text streamed into the items which picks, but never finished, as it was shown.
func (rt *threadRuntime) finishText(which func(id string) bool) {
	for _, it := range rt.state.Items {
		text, ok := it.Text()
		if !ok || !which(it.ID()) {
			continue
		}
		if saved, ok := rt.Item(it.ID()); ok {
			if st, _ := saved.Text(); st != text {
				rt.UpdateItem(it.ID(), Patch{"text": text})
			}
		}
	}
	for id := range rt.streaming {
		if which(id) {
			delete(rt.streaming, id)
		}
	}
}

func (rt *threadRuntime) BeginTurn() {
	if rt.turn != nil || rt.closing || rt.disposed {
		return
	}
	rt.turn = &turnState{ID: NewID("turn")}
	rt.emit(&protocol.TurnStartedEvent{TurnID: rt.turn.ID})
	rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusRunning; t.Error = "" })
}

func (rt *threadRuntime) StopSubagents(ids []string) {
	stopped := map[string]bool{}
	for _, id := range ids {
		it, ok := rt.Item(id)
		c, isCall := it.Value.(*protocol.ToolCall)
		if !ok || !isCall || c.Subagent == nil || c.Subagent.Status != protocol.SubagentStatusRunning || stopped[id] {
			continue
		}
		stopped[id] = true
		s := *c.Subagent
		s.Status = protocol.SubagentStatusStopped
		rt.UpdateItem(id, Patch{"subagent": s})
	}
	if len(stopped) == 0 {
		return
	}
	within := func(id string) bool {
		for _, a := range ancestors(rt.Item, id) {
			if stopped[a.ID()] {
				return true
			}
		}
		return false
	}
	rt.finishText(within)
	for id := range rt.structured {
		if within(id) {
			delete(rt.structured, id)
		}
	}
	for _, it := range rt.state.Items {
		if c, ok := it.Value.(*protocol.ToolCall); ok && (c.Status == protocol.ToolStatusRunning || c.Status == protocol.ToolStatusPending) && within(c.ID) {
			rt.UpdateItem(c.ID, Patch{"status": protocol.ToolStatusCancelled})
		}
	}
	for _, id := range append([]string(nil), rt.requestOrder...) {
		r := rt.requests[id]
		if r == nil || r.request.ToolCallID() == "" || !within(r.request.ToolCallID()) {
			continue
		}
		rt.dropRequest(id)
		rt.emit(&protocol.RequestResolvedEvent{RequestID: id, Resolution: protocol.Resolution{Outcome: protocol.ResolutionOutcomeCancel}})
	}
	if !rt.waiting() && rt.turn == nil && rt.state.Thread.Status == protocol.ThreadStatusWaiting {
		rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusIdle })
	}
}

// ancestors is the calls of the subagents an item is inside, innermost first.
func ancestors(item func(string) (protocol.Item, bool), id string) []protocol.Item {
	var out []protocol.Item
	seen := map[string]bool{}
	it, ok := item(id)
	for ok {
		p := it.ParentID()
		if p == "" || seen[p] {
			break
		}
		seen[p] = true
		if it, ok = item(p); ok {
			out = append(out, it)
		}
	}
	return out
}

// runningInBackground says whether an item is a background subagent's call that's still running.
func runningInBackground(it protocol.Item) bool {
	c, ok := it.Value.(*protocol.ToolCall)
	return ok && c.Subagent != nil && c.Subagent.Background && c.Subagent.Status == protocol.SubagentStatusRunning
}

// inBackground says whether an item is inside a background subagent that's still running: what it
// does carries on after the turn it was started in has ended.
func inBackground(item func(string) (protocol.Item, bool), id string) bool {
	for _, a := range ancestors(item, id) {
		if runningInBackground(a) {
			return true
		}
	}
	return false
}

func (rt *threadRuntime) undelivered(n int) {
	text := "A message wasn't delivered; it goes with the next one you send."
	if n > 1 {
		text = fmt.Sprintf("%d messages weren't delivered; they go with the next one you send.", n)
	}
	rt.AddItem(&protocol.Notice{ID: NewID("n"), Level: protocol.NoticeLevelWarning, Code: "undelivered", Text: text})
}

// ---------- requests ----------

// standingDenial is what the agent is told when a standing answer denies a call.
const standingDenial = "The user has denied this tool for the rest of the thread."

func (rt *threadRuntime) Decide(q PermissionQuery) Decision {
	if r := rt.standing(permissionKey(q.Kind, q.Server, q.Name)); r != nil {
		if r.Outcome == protocol.ResolutionOutcomeAllow {
			return Allow
		}
		return DenyWith(r.Message)
	}
	t := rt.state.Thread
	d := decide(background, rt.policy, q, PermissionContext{ThreadID: rt.id, Thread: t, Metadata: metadataOf(t)})
	return modeDecision(t.PermissionMode, d)
}

// standing is the thread's standing answer for a tool, if it has one.
func (rt *threadRuntime) standing(key *StandingKey) *protocol.Resolution {
	if key == nil {
		return nil
	}
	answers := rt.state.Thread.StandingAnswers
	for i := len(answers) - 1; i >= 0; i-- {
		if key.Matches(answers[i]) {
			if answers[i].Outcome == protocol.StandingAnswerOutcomeAllow {
				return &protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow}
			}
			return &protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Message: standingDenial}
		}
	}
	return nil
}

// settled is how a request is answered without asking the user, if it is: a permission request by
// the thread's standing answer for its tool, or else by its permission mode (bypass allows it,
// dont_ask denies it); a question by dont_ask, which dismisses it.
func (rt *threadRuntime) settled(question bool, standing *StandingKey) *protocol.Resolution {
	if !question {
		if r := rt.standing(standing); r != nil {
			return r
		}
	}
	switch rt.state.Thread.PermissionMode {
	case protocol.PermissionModeBypass:
		if !question {
			return &protocol.Resolution{Outcome: protocol.ResolutionOutcomeAllow}
		}
	case protocol.PermissionModeDontAsk:
		if !question {
			return &protocol.Resolution{Outcome: protocol.ResolutionOutcomeDeny, Message: DontAskDenial}
		}
		r := cancelled(DontAskDenial)
		return &r
	}
	return nil
}

func cancelled(message string) protocol.Resolution {
	return protocol.Resolution{Outcome: protocol.ResolutionOutcomeCancel, Message: message}
}

func (rt *threadRuntime) Ask(request protocol.ThreadRequestValue, toolCallID string, answered func(protocol.Resolution), standing *StandingKey) string {
	_, question := request.(*protocol.QuestionRequest)
	if r := rt.settled(question, standing); r != nil {
		res := *r
		rt.loop.post(func() { answered(res) })
		if question {
			return NewID("q")
		}
		return NewID("perm")
	}
	turnID := rt.TurnID()
	var id string
	var parent string
	if call, ok := rt.Item(toolCallID); ok && toolCallID != "" {
		parent = call.ParentID()
		rt.UpdateItem(call.ID(), Patch{"status": protocol.ToolStatusPending})
	} else {
		toolCallID = ""
	}
	switch r := request.(type) {
	case *protocol.PermissionRequest:
		id = NewID("perm")
		r.ID, r.TurnID, r.ToolCallID, r.ParentID = id, turnID, toolCallID, parent
		if r.Server == "" && standing != nil {
			r.Server = standing.Server
		}
	case *protocol.QuestionRequest:
		id = NewID("q")
		r.ID, r.TurnID, r.ToolCallID, r.ParentID = id, turnID, toolCallID, parent
	}
	req := protocol.ThreadRequest{Value: request}
	rt.addRequest(id, &openRequest{request: req, answered: answered, standing: standing, users: rt.userMessages()})
	rt.emit(&protocol.RequestOpenedEvent{Request: req})
	rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusWaiting })
	return id
}

func (rt *threadRuntime) addRequest(id string, r *openRequest) {
	if _, ok := rt.requests[id]; !ok {
		rt.requestOrder = append(rt.requestOrder, id)
	}
	rt.requests[id] = r
}

func (rt *threadRuntime) dropRequest(id string) {
	delete(rt.requests, id)
	for i, x := range rt.requestOrder {
		if x == id {
			rt.requestOrder = append(rt.requestOrder[:i:i], rt.requestOrder[i+1:]...)
			break
		}
	}
}

func (rt *threadRuntime) Reopen(requestID string, answered func(protocol.Resolution), standing *StandingKey) bool {
	if _, ok := rt.requests[requestID]; ok {
		return false
	}
	for _, r := range rt.state.Requests {
		// One that's been resolved stays in the state, with its resolution, but can't be reopened.
		if r.ID() == requestID && r.Resolution() == nil {
			rt.addRequest(requestID, &openRequest{request: r, answered: answered, standing: standing, users: rt.userMessages()})
			return true
		}
	}
	return false
}

func (rt *threadRuntime) respond(requestID string, res protocol.Resolution) {
	open := rt.requests[requestID]
	if open == nil {
		return
	}
	rt.dropRequest(requestID)
	// The answers to secret questions go only to the harness: what's sent and saved hides them.
	rt.emit(&protocol.RequestResolvedEvent{RequestID: requestID, Resolution: redact(open.request, res)})
	rt.requestsDone()
	var standing *protocol.StandingAnswer
	if res.Always && open.standing != nil {
		switch res.Outcome {
		case protocol.ResolutionOutcomeAllow:
			a := open.standing.Answer(protocol.StandingAnswerOutcomeAllow)
			standing = &a
		case protocol.ResolutionOutcomeDeny:
			a := open.standing.Answer(protocol.StandingAnswerOutcomeDeny)
			standing = &a
		}
	}
	if standing != nil {
		rt.SetThread(func(t *protocol.Thread) {
			var kept []protocol.StandingAnswer
			for _, a := range t.StandingAnswers {
				if !open.standing.Matches(a) {
					kept = append(kept, a)
				}
			}
			t.StandingAnswers = append(kept, *standing)
		})
	}
	open.answered(res)
	// It stands for the requests open for the same tool too.
	if standing != nil {
		rt.settle()
	}
}

// settle answers the open requests the thread's standing answers or permission mode now answer
// (see settled), after either changed: questions kept open after their turns included, which
// dont_ask dismisses (and which then send nothing).
func (rt *threadRuntime) settle() {
	type answer struct {
		id  string
		res protocol.Resolution
	}
	var answers []answer
	for _, id := range rt.requestOrder {
		o := rt.requests[id]
		if o == nil {
			continue
		}
		_, question := o.request.Value.(*protocol.QuestionRequest)
		if r := rt.settled(question, o.standing); r != nil {
			answers = append(answers, answer{id, *r})
		}
	}
	for _, a := range answers {
		rt.respond(a.id, a.res)
	}
}

// CancelRequest closes a request the harness no longer wants answered. (A question kept open after
// its turn isn't the harness's any more, and stays open; so does one the harness gives up on
// because the user interrupted its turn, with LateAnswers.)
func (rt *threadRuntime) CancelRequest(id string) {
	open := rt.requests[id]
	if open == nil || open.late {
		return
	}
	rt.dropRequest(id)
	if !(rt.Interrupted() && rt.keepLate(id, open.request, &open.users)) {
		rt.emit(&protocol.RequestResolvedEvent{RequestID: id, Resolution: cancelled("")})
	}
	rt.requestsDone()
}

// requestsDone sets the thread running again once it waits on no request, or idle if no turn is
// running (a background subagent's request can be answered after its turn).
func (rt *threadRuntime) requestsDone() {
	if rt.waiting() {
		return
	}
	if rt.turn != nil {
		rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusRunning })
	} else if rt.state.Thread.Status == protocol.ThreadStatusWaiting {
		rt.SetThread(func(t *protocol.Thread) { t.Status = protocol.ThreadStatusIdle })
	}
}

// waiting says whether the thread waits on a request (one that isn't kept open after its turn).
func (rt *threadRuntime) waiting() bool {
	for _, o := range rt.requests {
		if !o.late {
			return true
		}
	}
	return false
}

// openRequestIDs is the open requests, but for questions kept open after their turns.
func (rt *threadRuntime) openRequestIDs() map[string]bool {
	out := map[string]bool{}
	for id, o := range rt.requests {
		if !o.late {
			out[id] = true
		}
	}
	return out
}

// keepLate keeps a question open after its turn ended, with LateAnswers, if it can be: not a secret
// one (its answer would be shown, as a message), not under dont_ask (which dismisses questions),
// and not when the conversation has moved on: messages are queued, or the user sent one since it
// was opened (when there were *users; nil if that isn't known). It says whether it did.
func (rt *threadRuntime) keepLate(id string, request protocol.ThreadRequest, users *int) bool {
	q, ok := request.Value.(*protocol.QuestionRequest)
	movedOn := len(rt.queue) > 0 || users != nil && rt.userMessages() > *users
	if !ok || !rt.sdk.options.LateAnswers || movedOn || rt.state.Thread.PermissionMode == protocol.PermissionModeDontAsk {
		return false
	}
	for _, x := range q.Questions {
		if x.Secret {
			return false
		}
	}
	rt.addRequest(id, &openRequest{request: request, answered: rt.lateAnswered(q), late: true, users: rt.userMessages()})
	return true
}

// userMessages is how many messages the user has sent.
func (rt *threadRuntime) userMessages() int {
	n := 0
	for _, it := range rt.state.Items {
		if it.Type() == "user_message" {
			n++
		}
	}
	return n
}

// cancelLate cancels the questions kept open after their turns.
func (rt *threadRuntime) cancelLate() {
	for _, id := range append([]string(nil), rt.requestOrder...) {
		if o := rt.requests[id]; o != nil && o.late {
			rt.dropRequest(id)
			rt.emit(&protocol.RequestResolvedEvent{RequestID: id, Resolution: cancelled("")})
		}
	}
}

// takeUpRequests takes up, as a thread is loaded, the requests open in its state that nothing will
// answer: those of turns that ended (or all of them), which aren't taken up already. A question is
// kept open after its turn as endTurn keeps it; the others are cancelled.
func (rt *threadRuntime) takeUpRequests(all bool) {
	ended := map[string]bool{}
	for _, it := range rt.state.Items {
		if it.Type() == "turn_result" && it.TurnID() != "" {
			ended[it.TurnID()] = true
		}
	}
	for _, r := range protocol.OpenRequests(rt.state) {
		if rt.requests[r.ID()] != nil || !all && !ended[r.TurnID()] {
			continue
		}
		if !rt.keepLate(r.ID(), r, nil) {
			rt.emit(&protocol.RequestResolvedEvent{RequestID: r.ID(), Resolution: cancelled("")})
		}
	}
}

// lateAnswered is what's done with the answer to a question kept open after its turn: it's sent as
// the next message (a dismissal sends nothing).
func (rt *threadRuntime) lateAnswered(q *protocol.QuestionRequest) func(protocol.Resolution) {
	return func(res protocol.Resolution) {
		if res.Outcome != protocol.ResolutionOutcomeAnswer {
			return
		}
		rt.send(outgoing{text: lateAnswerText(q, res)})
	}
}

// lateAnswerText is the message a late answer is sent as: each question, with its answers (and the
// note with them).
func lateAnswerText(q *protocol.QuestionRequest, res protocol.Resolution) string {
	lines := make([]string, 0, len(q.Questions))
	for _, x := range q.Questions {
		answer := "(no answer)"
		if a := res.Answers[x.ID]; len(a) > 0 {
			answer = strings.Join(a, ", ")
		}
		lines = append(lines, "- "+x.Question+"\n  "+answer)
	}
	what := "answers to the questions"
	if len(lines) == 1 {
		what = "answer to the question"
	}
	text := "My " + what + " you asked:\n\n" + strings.Join(lines, "\n")
	if res.Message != "" {
		text += "\n\n" + res.Message
	}
	return text
}

// secretText is what a secret answer is shown as.
const secretText = "[secret]"

// redact is a resolution as it may be shown and saved: a secret question's answers replaced.
func redact(request protocol.ThreadRequest, res protocol.Resolution) protocol.Resolution {
	q, ok := request.Value.(*protocol.QuestionRequest)
	if !ok || res.Answers == nil {
		return res
	}
	secret := map[string]bool{}
	for _, x := range q.Questions {
		if x.Secret {
			secret[x.ID] = true
		}
	}
	has := false
	for id := range res.Answers {
		has = has || secret[id]
	}
	if !has {
		return res
	}
	answers := map[string][]string{}
	for id, a := range res.Answers {
		if secret[id] && len(a) > 0 {
			answers[id] = []string{secretText}
		} else {
			answers[id] = a
		}
	}
	res.Answers = answers
	return res
}

// addUsage is a + b, with costs rounded to a picodollar so sums don't drift.
func addUsage(a, b *protocol.Usage) *protocol.Usage {
	if b == nil {
		return a
	}
	if a == nil {
		c := clone(*b)
		return &c
	}
	out := clone(*a)
	out.InputTokens += b.InputTokens
	out.OutputTokens += b.OutputTokens
	out.CacheReadTokens = addOpt(out.CacheReadTokens, b.CacheReadTokens)
	out.CacheWriteTokens = addOpt(out.CacheWriteTokens, b.CacheWriteTokens)
	if b.CostUSD != nil {
		c := roundCost(deref(out.CostUSD) + *b.CostUSD)
		out.CostUSD = &c
	}
	return &out
}

func addOpt(a, b *int64) *int64 {
	if b == nil {
		return a
	}
	n := deref(a) + *b
	return &n
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func roundCost(c float64) float64 {
	return float64(int64(c*1e12+0.5)) / 1e12
}

func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return string(a) == string(b)
	}
	return jsonEqual(x, y)
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

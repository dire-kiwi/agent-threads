//go:build unix

package agentthreads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// The shim spawner: harness processes run under agent-threads-shim (../shim), detached from the
// backend, and everything between them goes through files in the run's directory, as
// spec/RUNDIR.md says. The backend appends its input to input.jsonl and follows out.jsonl, and the
// offset it has read to is saved with the events it made of the lines (see DurableSpawner), so a
// backend that restarts re-attaches (Attach) and carries on from exactly there.

const (
	// keepUnknown is how long a finished run's directory with no record, or a dead run's, is kept:
	// it may be a run being started.
	keepUnknown = time.Hour
	// startTimeout is how long the shim may take to record its pid after it's launched.
	startTimeout = 10 * time.Second
	// stderrTailBytes is how much of err.log a re-attached run's stderr starts with.
	stderrTailBytes = 4096
	// fastPoll is how often the output is read while it's coming, or just after input went in.
	fastPoll = 10 * time.Millisecond
)

// Shim is the spawner that runs harness processes under agent-threads-shim (path: the binary, a
// path or a name looked for on the PATH), so they survive the backend. It panics without a RunsDir.
func Shim(path string, o ShimOptions) Spawner {
	if o.RunsDir == "" {
		panic("agentthreads: Shim needs a RunsDir: a directory for this store's runs alone")
	}
	// Made absolute here, as the shim starts in the thread's working directory.
	runsDir, _ := filepath.Abs(o.RunsDir)
	bin := path
	if strings.Contains(path, "/") && !filepath.IsAbs(path) {
		bin, _ = filepath.Abs(path)
	}
	keep := o.KeepDays
	if keep <= 0 {
		keep = 14
	}
	return &shimSpawner{
		bin: bin, runsDir: runsDir, keep: time.Duration(keep) * 24 * time.Hour,
		grace: orDuration(o.KillGrace, 10*time.Second), poll: orDuration(o.Poll, 200*time.Millisecond),
		live: map[string]*shimProcess{}, esc: &escalator{running: map[string]bool{}},
	}
}

type shimSpawner struct {
	bin, runsDir string
	keep, grace  time.Duration
	poll         time.Duration
	mu           sync.Mutex
	// live is the runs this backend follows, which pruning leaves alone.
	live map[string]*shimProcess
	esc  *escalator
}

func (s *shimSpawner) Name() string { return "shim" }

func (s *shimSpawner) follow(id, dir string, offset int64, h ProcessHandlers, post func(func()), launched bool, input *int64) *shimProcess {
	p := newShimProcess(s, id, dir, offset, h, post, launched, input)
	s.mu.Lock()
	s.live[id] = p
	s.mu.Unlock()
	return p
}

func (s *shimSpawner) forget(id string, p *shimProcess) {
	s.mu.Lock()
	if s.live[id] == p {
		delete(s.live, id)
	}
	s.mu.Unlock()
}

func (s *shimSpawner) Spawn(o SpawnOptions, h ProcessHandlers) (Process, error) {
	dir := filepath.Join(s.runsDir, o.RunID)
	if err := os.MkdirAll(s.runsDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	run := map[string]any{"format": RunFormat, "run_id": o.RunID, "thread_id": o.ThreadID, "command": o.Command, "started_at": now()}
	if err := os.WriteFile(filepath.Join(dir, "run.json"), append(mustJSON(run), '\n'), 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "input.jsonl"), nil, 0o600); err != nil {
		return nil, err
	}
	p := s.follow(o.RunID, dir, 0, h, o.Post, true, nil)
	// The shim forks and its first process exits at once; the run is the fork's.
	launcher := exec.Command(s.bin, append([]string{dir, "--", o.Command}, o.Args...)...)
	launcher.Dir, launcher.Env = o.Cwd, o.Env
	launcher.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := launcher.Start(); err != nil {
		p.launchFailed("agent-threads-shim couldn't be started: " + err.Error())
		return p, nil
	}
	go func() {
		err := launcher.Wait()
		if err == nil {
			p.launched()
			return
		}
		status := exitStatus(launcher.ProcessState, err)
		p.launchFailed("agent-threads-shim " + exitHow(status))
	}()
	return p, nil
}

func (s *shimSpawner) Attach(run RunRecord, h ProcessHandlers, post func(func())) (Process, error) {
	var data struct {
		Dir   string `json:"dir"`
		Input *int64 `json:"input"`
	}
	json.Unmarshal(run.Data, &data)
	dir := data.Dir
	if dir == "" {
		dir = filepath.Join(s.runsDir, run.ID)
	}
	p := s.follow(run.ID, dir, run.Offset, h, post, false, data.Input)
	if format := readFormat(dir); format > RunFormat {
		s.stopDir(dir)
		p.fail(fmt.Sprintf("the run was started by a newer backend (run directory format %d), which this one can't follow", format))
	}
	return p, nil
}

func (s *shimSpawner) StopRun(run RunRecord) {
	var data struct {
		Dir string `json:"dir"`
	}
	json.Unmarshal(run.Data, &data)
	if data.Dir == "" {
		data.Dir = filepath.Join(s.runsDir, run.ID)
	}
	s.stopDir(data.Dir)
}

// stopDir stops the run in dir, which nothing follows: it ends its input, then SIGTERM to its group
// and SIGKILL after the grace. A run its shim hasn't started yet is stopped once it has; one whose
// shim has gone gets the exit the shim would have written.
func (s *shimSpawner) stopDir(dir string) {
	s.esc.beginStop(dir, 0, s.grace)
}

func (s *shimSpawner) Wait(ctx context.Context) error { return s.esc.wait(ctx) }

func (s *shimSpawner) Prune(ctx context.Context, store Store) (int, error) {
	entries, err := os.ReadDir(s.runsDir)
	if err != nil {
		return 0, nil
	}
	removed := 0
	nowT := time.Now()
	for _, e := range entries {
		id := e.Name()
		dir := filepath.Join(s.runsDir, id)
		st, err := os.Stat(dir)
		if err != nil || !st.IsDir() {
			continue
		}
		// A run being stopped when a backend went: whatever's left of it is stopped still.
		if readStopping(dir) != nil {
			s.esc.escalate(dir)
			continue
		}
		s.mu.Lock()
		_, followed := s.live[id]
		s.mu.Unlock()
		if followed {
			continue
		}
		record, err := store.GetRun(ctx, id)
		if err != nil {
			return removed, err
		}
		if record != nil && record.Active() {
			continue // A run the backend will follow.
		}
		// Its shim, or (with the shim gone) what it ran, which nothing would stop.
		running := (!exists(filepath.Join(dir, "exit")) && shimAlive(dir, nil)) || liveGroup(dir) != 0
		if running {
			// Nothing follows it, so nothing will stop it: a run its backend gave up on (and was
			// stopping when it went), or one started by a backend that died before saving it.
			if record != nil || nowT.Sub(st.ModTime()) > startTimeout {
				s.stopDir(dir)
			}
			continue
		}
		since, keep := st.ModTime(), keepUnknown
		if record != nil {
			keep = s.keep
			if t, err := time.Parse(time.RFC3339Nano, record.EndedAt); err == nil {
				since = t
			}
		}
		if nowT.Sub(since) > keep {
			if os.RemoveAll(dir) == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// delivered is a line in input.jsonl after the checkpoint a run was re-attached from (and where it
// starts), that reading the output again hasn't written again yet.
type delivered struct {
	text    string
	at      int64
	answers string
}

type tailLine struct {
	line string
	end  int64
}

// shimProcess is one run under the shim, followed through its directory. Its methods and handlers
// run on the thread's goroutine; a goroutine of its own reads the directory and hands what it reads
// to it.
type shimProcess struct {
	spawner *shimSpawner
	id, dir string
	h       ProcessHandlers
	post    func(func())

	// The thread's goroutine's.
	offset      int64
	input       int64 // input.jsonl's size, as written
	delivered   []delivered
	outAtAttach int64
	caughtUp    bool
	inputClosed bool
	pid         int

	// The follower's, and shared.
	over       atomic.Bool
	left       atomic.Bool
	wake       chan struct{}
	stopCh     chan struct{}
	stopOnce   sync.Once
	mu         sync.Mutex
	signals    []syscall.Signal // to send once the program's pid is known
	launch     *launchState
	launchHere bool
	since      time.Time
}

type launchState struct {
	at    time.Time
	error string
}

func newShimProcess(s *shimSpawner, id, dir string, offset int64, h ProcessHandlers, post func(func()), launched bool, input *int64) *shimProcess {
	p := &shimProcess{spawner: s, id: id, dir: dir, h: h, post: post, offset: offset, launchHere: launched, since: time.Now(), wake: make(chan struct{}, 1), stopCh: make(chan struct{})}
	errStart := int64(0)
	if !launched {
		// What's been written, and what of it came after the checkpoint (input: where it was then).
		if all, err := os.ReadFile(filepath.Join(dir, "input.jsonl")); err == nil {
			p.input = int64(len(all))
			if input != nil {
				at := min(*input, int64(len(all)))
				for _, text := range splitAfterNewline(all[at:]) {
					if strings.HasSuffix(text, "\n") {
						p.delivered = append(p.delivered, delivered{text: text, at: at, answers: answering(text)})
					}
					at += int64(len(text))
				}
			}
			if st, err := os.Stat(filepath.Join(dir, "out.jsonl")); err == nil {
				p.outAtAttach = st.Size()
			}
		}
		p.inputClosed = exists(filepath.Join(dir, "input.closed"))
		// Being stopped when the backend went: it's carried on with.
		if readStopping(dir) != nil {
			s.esc.escalate(dir)
		}
		// A re-attached run's stderr starts with the end of what it wrote before.
		if st, err := os.Stat(filepath.Join(dir, "err.log")); err == nil {
			errStart = max(0, st.Size()-stderrTailBytes)
		}
	}
	out := &tail{path: filepath.Join(dir, "out.jsonl"), at: offset}
	errs := &tail{path: filepath.Join(dir, "err.log"), at: errStart, skip: errStart > 0}
	go p.follow(out, errs)
	return p
}

func splitAfterNewline(data []byte) []string {
	var out []string
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			out = append(out, string(data))
			break
		}
		out = append(out, string(data[:i+1]))
		data = data[i+1:]
	}
	return out
}

func (p *shimProcess) Dir() string { return p.dir }

func (p *shimProcess) Pid() int {
	if p.pid == 0 {
		p.pid = readPid(p.dir, "pid")
	}
	return p.pid
}

func (p *shimProcess) Offset() int64 { return p.offset }

// InputOffset is how much of input.jsonl is written: not past a line that's to be written again (and
// isn't), since a restart before it is must know it's there. (An answer's kept only while its
// request's open.)
func (p *shimProcess) InputOffset() int64 {
	if p.caughtUp {
		p.retire()
	}
	if len(p.delivered) > 0 {
		return p.delivered[0].at
	}
	return p.input
}

func (p *shimProcess) Write(line string) {
	if p.over.Load() || p.inputClosed {
		return
	}
	text := line
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	// Written already, after the checkpoint this run was re-attached from: what's read again since
	// writes it again, and it isn't. The first (in order) of those it's the same as; or an answer to
	// a request that was answered already (another way, by a user asked again, say): the harness has
	// its answer.
	at := -1
	for i, d := range p.delivered {
		if d.text == text {
			at = i
			break
		}
	}
	if answers := answering(text); at < 0 && answers != "" {
		for i, d := range p.delivered {
			if d.answers == answers {
				at = i
				break
			}
		}
	}
	if at >= 0 {
		p.delivered = append(p.delivered[:at:at], p.delivered[at+1:]...)
		return
	}
	// One write, so the shim never relays half a line.
	f, err := os.OpenFile(filepath.Join(p.dir, "input.jsonl"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return // The run's gone; its exit says how.
	}
	n, _ := f.Write([]byte(text))
	f.Close()
	p.input += int64(n)
	p.nudge()
}

func (p *shimProcess) Answered(id string) bool {
	for _, d := range p.delivered {
		if d.answers != "" && d.answers == id {
			return true
		}
	}
	return false
}

func (p *shimProcess) CloseInput() {
	if p.inputClosed {
		return
	}
	p.inputClosed = true
	os.WriteFile(filepath.Join(p.dir, "input.closed"), nil, 0o600)
}

func (p *shimProcess) Stop(graceMs int64, now bool) {
	if p.over.Load() {
		return
	}
	p.inputClosed = true
	grace := time.Duration(graceMs) * time.Millisecond
	term := grace
	if now {
		term = 0
	}
	p.spawner.esc.beginStop(p.dir, term, grace*2)
}

func (p *shimProcess) Kill(sig syscall.Signal) {
	if p.Pid() == 0 {
		// The shim hasn't started it yet: it's signalled once it has.
		if !p.over.Load() {
			p.mu.Lock()
			p.signals = append(p.signals, sig)
			p.mu.Unlock()
		}
		return
	}
	// Its group, even once the program has exited: what it started may still be running.
	p.spawner.esc.terminate(p.dir, p.spawner.grace, sig)
}

func (p *shimProcess) Detach() {
	p.left.Store(true)
	p.end()
}

// launched says the launcher came back: the shim has forked, and records the run's pid next.
func (p *shimProcess) launched() {
	p.mu.Lock()
	if p.launch == nil {
		p.launch = &launchState{at: time.Now()}
	}
	p.mu.Unlock()
}

func (p *shimProcess) launchFailed(err string) {
	p.mu.Lock()
	p.launch = &launchState{at: time.Now(), error: err}
	p.mu.Unlock()
	p.nudge()
}

// fail ends the run with an error, without reading it further (a run this backend can't follow).
func (p *shimProcess) fail(err string) {
	if p.over.Load() {
		return
	}
	p.left.Store(true)
	p.end()
	p.post(func() { p.h.Exit(ExitStatus{Err: errors.New(err)}) })
}

func (p *shimProcess) end() {
	if p.over.Swap(true) {
		return
	}
	p.stopOnce.Do(func() { close(p.stopCh) })
	p.spawner.forget(p.id, p)
}

// retire forgets the lines written before the restart that won't be written again: all of them but
// the answers to requests the driver has yet to answer.
func (p *shimProcess) retire() {
	if len(p.delivered) == 0 {
		return
	}
	open := map[string]bool{}
	if p.h.Unanswered != nil {
		for _, id := range p.h.Unanswered() {
			open[id] = true
		}
	}
	var keep []delivered
	for _, d := range p.delivered {
		if d.answers != "" && open[d.answers] {
			keep = append(keep, d)
		}
	}
	p.delivered = keep
}

func (p *shimProcess) nudge() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// follow reads the run's directory until the run's over, handing what it reads to the thread's
// goroutine: often while there's output, and less often (up to the spawner's poll) while there isn't.
func (p *shimProcess) follow(out, errs *tail) {
	defer out.close()
	defer errs.close()
	var identity identityBox
	var checked time.Time
	wait := time.Duration(0)
	for !p.over.Load() {
		if wait > 0 {
			select {
			case <-p.stopCh:
				return
			case <-p.wake:
				wait = 0
			case <-time.After(wait):
			}
		}
		// Looked for first, so all the output written before it is read below.
		exited := exists(filepath.Join(p.dir, "exit"))
		errLines := errs.lines(exited)
		outLines := out.lines(exited)
		var status *ExitStatus
		if exited {
			s := readExit(p.dir)
			status = &s
		}
		if len(errLines) > 0 || len(outLines) > 0 || exited {
			p.post(func() { p.deliver(errLines, outLines, status) })
		}
		if exited {
			p.end()
			return
		}
		// Signals asked for before the program's pid was known.
		p.mu.Lock()
		signals := p.signals
		if len(signals) > 0 && readPid(p.dir, "pid") != 0 {
			p.signals = nil
		} else {
			signals = nil
		}
		p.mu.Unlock()
		for _, sig := range signals {
			p.spawner.esc.terminate(p.dir, p.spawner.grace, sig)
		}
		if gone := p.gone(&identity, &checked); gone != "" {
			// Recorded as the shim would have, unless it did after all.
			if !exists(p.dir) {
				p.post(func() { p.deliver(nil, nil, &ExitStatus{Err: errors.New(gone)}) })
				p.end()
				return
			}
			writeExit(p.dir, gone)
			// With its shim gone, nothing would stop the program, which may well still be running.
			p.spawner.esc.terminate(p.dir, p.spawner.grace, syscall.SIGTERM)
			wait = 0
			continue
		}
		if len(outLines) > 0 || len(errLines) > 0 {
			wait = fastPoll
		} else {
			wait = min(max(wait*2, fastPoll), p.spawner.poll)
		}
	}
}

// deliver gives the handlers what was read, on the thread's goroutine.
func (p *shimProcess) deliver(errLines, outLines []tailLine, status *ExitStatus) {
	if p.detached() {
		return
	}
	for _, l := range errLines {
		p.h.Stderr(l.line)
		if p.detached() {
			return
		}
	}
	for _, l := range outLines {
		p.offset = l.end
		if l.line != "" {
			p.h.Line(l.line)
		}
		if p.detached() {
			return
		}
	}
	// What was there when it was re-attached to is read again, and what that writes is written (in
	// the same task, or the next): lines written before that aren't written again now.
	if !p.caughtUp && p.offset >= p.outAtAttach {
		p.caughtUp = true
		p.post(p.retire)
	}
	if status != nil {
		p.h.Exit(*status)
	}
}

// detached says the backend stopped following the run (Detach, or a run it can't follow), rather
// than the run ending: nothing more is handed to the handlers.
func (p *shimProcess) detached() bool { return p.left.Load() }

// gone is why the run is gone though it has no exit file, if it is.
func (p *shimProcess) gone(identity *identityBox, checked *time.Time) string {
	if !exists(p.dir) {
		return "the run's directory was removed"
	}
	p.mu.Lock()
	launch := p.launch
	p.mu.Unlock()
	if launch != nil && launch.error != "" {
		return launch.error
	}
	// Not every time: it's a few system calls.
	nowT := time.Now()
	if nowT.Sub(*checked) < time.Second {
		return ""
	}
	*checked = nowT
	if readPid(p.dir, "shim.pid") != 0 {
		if shimAlive(p.dir, identity) || exists(filepath.Join(p.dir, "exit")) {
			return ""
		}
		return "its supervisor (agent-threads-shim) went away"
	}
	// No shim.pid: one still starting, or one that never started.
	since := p.since
	if p.launchHere {
		if launch == nil {
			return ""
		}
		since = launch.at
	}
	if nowT.Sub(since) > startTimeout {
		return "agent-threads-shim didn't start the run"
	}
	return ""
}

// tail reads a file's whole lines as they're appended, from an offset.
type tail struct {
	path    string
	f       *os.File
	at      int64 // where pending starts in the file
	pending []byte
	// skip drops what comes before the first newline (a tail started mid-line).
	skip bool
}

// lines is the whole lines appended since the last call, each with the offset after it. Once the
// writer is done (final), a last line with no newline counts too.
func (t *tail) lines(final bool) []tailLine {
	t.read()
	var out []tailLine
	start := 0
	for {
		nl := bytes.IndexByte(t.pending[start:], '\n')
		if nl < 0 {
			break
		}
		line := string(t.pending[start : start+nl])
		start += nl + 1
		if t.skip {
			t.skip = false
			continue
		}
		out = append(out, tailLine{line: strings.TrimSuffix(line, "\r"), end: t.at + int64(start)})
	}
	if final && start < len(t.pending) && !t.skip {
		line := string(t.pending[start:])
		start = len(t.pending)
		out = append(out, tailLine{line: line, end: t.at + int64(start)})
	}
	t.at += int64(start)
	t.pending = append([]byte(nil), t.pending[start:]...)
	return out
}

func (t *tail) read() {
	if t.f == nil {
		f, err := os.Open(t.path)
		if err != nil {
			return // Not there yet.
		}
		t.f = f
	}
	pos := t.at + int64(len(t.pending))
	buf := make([]byte, 64*1024)
	for {
		n, err := t.f.ReadAt(buf, pos)
		if n > 0 {
			t.pending = append(t.pending, buf[:n]...)
			pos += int64(n)
		}
		if err != nil || n == 0 {
			if err != nil && !errors.Is(err, io.EOF) {
				return
			}
			return
		}
	}
}

func (t *tail) close() {
	if t.f != nil {
		t.f.Close()
		t.f = nil
	}
}

// ---------- the run directory ----------

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readPid is the pid in a run directory's pid or shim.pid, or 0.
func readPid(dir, name string) int {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return 0
	}
	var n int
	if _, err := fmt.Sscan(strings.TrimSpace(string(data)), &n); err != nil || n <= 0 {
		return 0
	}
	return n
}

func readFormat(dir string) int {
	data, err := os.ReadFile(filepath.Join(dir, "run.json"))
	if err != nil {
		return 1
	}
	var r struct {
		Format *float64 `json:"format"`
	}
	if json.Unmarshal(data, &r) != nil || r.Format == nil {
		return 1
	}
	return int(*r.Format)
}

// readExit is a run directory's exit, as an ExitStatus.
func readExit(dir string) ExitStatus {
	data, err := os.ReadFile(filepath.Join(dir, "exit"))
	if err != nil {
		return ExitStatus{Err: fmt.Errorf("the run's exit file can't be read: %w", err)}
	}
	e := parseObj(data)
	if e == nil {
		return ExitStatus{Err: errors.New("the run's exit file can't be read: it isn't JSON")}
	}
	var s ExitStatus
	if n, ok := e.int("code"); ok {
		c := int(n)
		s.Code = &c
	}
	if n, ok := e.int("signal"); ok {
		s.Signal = signalName(syscall.Signal(n))
	} else if sig := e.str("signal"); sig != "" {
		s.Signal = sig
	}
	if msg := e.str("error"); msg != "" {
		s.Err = errors.New(msg)
	}
	return s
}

// answering is which of the harness's requests an input line answers, if it's an answer: a Claude
// control_response's request_id, or a JSON-RPC response's id (Codex's).
func answering(line string) string {
	m := parseObj([]byte(line))
	if m == nil {
		return ""
	}
	if m.str("type") == "control_response" {
		return idText(m.obj("response").raw("request_id"))
	}
	if id := m.raw("id"); id != nil && !m.has("method") && (m["result"] != nil || m["error"] != nil) {
		return idText(id)
	}
	return ""
}

// idText is a string's text or a number's digits, as JavaScript's String() has them; "" for anything else.
func idText(v json.RawMessage) string {
	if isStr(v) {
		return rawStr(v)
	}
	var f float64
	if json.Unmarshal(v, &f) == nil {
		return string(bytes.TrimSpace(v))
	}
	return ""
}

// writeAtomic writes a run directory's file whole, as the shim does.
func writeAtomic(dir, name string, content []byte) {
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.tmp", name, os.Getpid()))
	if os.WriteFile(tmp, content, 0o600) != nil {
		return // The directory's gone.
	}
	os.Rename(tmp, filepath.Join(dir, name))
}

// writeExit writes exit atomically, as the shim does, unless there's one.
func writeExit(dir, why string) {
	tmp := filepath.Join(dir, fmt.Sprintf(".exit.%d.tmp", os.Getpid()))
	if os.WriteFile(tmp, mustJSON(map[string]any{"code": nil, "signal": nil, "error": why}), 0o600) != nil {
		return
	}
	if exists(filepath.Join(dir, "exit")) {
		os.Remove(tmp)
		return
	}
	// A hard link fails if exit appeared meanwhile, where a rename would replace it.
	if os.Link(tmp, filepath.Join(dir, "exit")) != nil {
		os.Rename(tmp, filepath.Join(dir, "exit"))
	}
	os.Remove(tmp)
}

type stoppingFile struct {
	TermAt *int64 `json:"term_at,omitempty"`
	KillAt int64  `json:"kill_at"`
}

// readStopping is a run being stopped (its stopping file): when its group gets SIGTERM, if it
// hasn't yet, and when SIGKILL.
func readStopping(dir string) *stoppingFile {
	data, err := os.ReadFile(filepath.Join(dir, "stopping"))
	if err != nil {
		return nil
	}
	m := parseObj(data)
	kill, ok := m.int("kill_at")
	if !ok {
		return nil
	}
	s := &stoppingFile{KillAt: kill}
	if term, ok := m.int("term_at"); ok {
		s.TermAt = &term
	}
	return s
}

// startedAt is when the run was started (run.json written), as near as can be told.
func startedAt(dir string) time.Time {
	for _, name := range []string{"run.json", "."} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return st.ModTime()
		}
	}
	return time.Time{}
}

// ---------- stopping runs ----------

// escalator carries on stopping runs (those with a stopping file), as spec/RUNDIR.md says.
type escalator struct {
	mu      sync.Mutex
	running map[string]bool
	wg      sync.WaitGroup
}

func (e *escalator) wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		e.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// terminate signals the run's process group, if it's still the run's; after SIGTERM (or another
// signal), SIGKILL to whatever is left of it after grace, even if the program itself has exited.
// That's written down (stopping), so a backend that restarts before then carries on with it. During
// a stop that's under way, its deadlines stand, and a SIGTERM it was still to send isn't sent again.
func (e *escalator) terminate(dir string, grace time.Duration, sig syscall.Signal) {
	pid := liveGroup(dir)
	if pid == 0 {
		return
	}
	was := readStopping(dir)
	switch {
	case sig == syscall.SIGTERM && was != nil && was.TermAt != nil:
		// A stop under way whose SIGTERM is still to come doesn't send it again: written down first.
		writeAtomic(dir, "stopping", mustJSON(stoppingFile{KillAt: was.KillAt}))
	case sig != syscall.SIGKILL && was == nil:
		writeAtomic(dir, "stopping", mustJSON(stoppingFile{KillAt: time.Now().Add(grace).UnixMilli()}))
	}
	syscall.Kill(-pid, sig)
	if sig != syscall.SIGKILL {
		e.escalate(dir)
	}
}

// beginStop stops a run: it ends its input, then SIGTERM to its group in term (if it's still there)
// and SIGKILL in kill. It's written down first (stopping, with both deadlines), so a backend that
// restarts meanwhile carries on with it. A stop already under way only ever comes sooner.
func (e *escalator) beginStop(dir string, term, kill time.Duration) {
	nowMs := time.Now().UnixMilli()
	was := readStopping(dir)
	next := stoppingFile{KillAt: nowMs + kill.Milliseconds()}
	if was != nil {
		next.KillAt = min(next.KillAt, was.KillAt)
	}
	// Once SIGTERM's gone (no term_at), it isn't sent again.
	if was == nil || was.TermAt != nil {
		t := nowMs + term.Milliseconds()
		if was != nil {
			t = min(t, *was.TermAt)
		}
		next.TermAt = &t
	}
	writeAtomic(dir, "stopping", mustJSON(next))
	if os.WriteFile(filepath.Join(dir, "input.closed"), nil, 0o600) != nil {
		return // Its directory's gone.
	}
	e.escalate(dir)
}

// escalate carries on stopping a run (it has stopping): SIGTERM to its group at term_at, SIGKILL
// to what's left of it at kill_at, each only if the group is still the run's, until it has gone. A
// run its shim hasn't started yet is waited for (while its shim may still start it); one whose shim
// has gone gets the exit the shim would have written. Wait waits for it, so shutting down doesn't
// leave it; a backend killed meanwhile carries on after it restarts (when it re-attaches, or in
// Prune).
func (e *escalator) escalate(dir string) {
	e.mu.Lock()
	if e.running[dir] {
		e.mu.Unlock()
		return
	}
	e.running[dir] = true
	e.wg.Add(1)
	e.mu.Unlock()
	go func() {
		defer func() {
			e.mu.Lock()
			delete(e.running, dir)
			e.mu.Unlock()
			e.wg.Done()
		}()
		done := func() { os.Remove(filepath.Join(dir, "stopping")) }
		checked := false
		for {
			s := readStopping(dir)
			if s == nil {
				return
			}
			pid := readPid(dir, "pid")
			exited := exists(filepath.Join(dir, "exit"))
			if pid == 0 {
				var never bool
				if readPid(dir, "shim.pid") != 0 {
					never = exited || !shimAlive(dir, nil)
				} else {
					never = exited || time.Since(startedAt(dir)) > startTimeout
				}
				if never {
					done()
					return
				}
				time.Sleep(50 * time.Millisecond)
				continue
			}
			if !groupExists(pid) {
				done()
				return
			}
			if !checked {
				checked = true
				if !exited && !shimAlive(dir, nil) {
					writeExit(dir, "its supervisor (agent-threads-shim) went away")
				}
			}
			nowMs := time.Now().UnixMilli()
			if nowMs >= s.KillAt {
				if group := liveGroup(dir); group != 0 {
					syscall.Kill(-group, syscall.SIGKILL)
				}
				done()
				return
			}
			if s.TermAt != nil && nowMs >= *s.TermAt {
				// Written down first: it's sent once.
				writeAtomic(dir, "stopping", mustJSON(stoppingFile{KillAt: s.KillAt}))
				if group := liveGroup(dir); group != 0 {
					syscall.Kill(-group, syscall.SIGTERM)
				}
			}
			next := s.KillAt
			if s.TermAt != nil && *s.TermAt > nowMs {
				next = *s.TermAt
			}
			time.Sleep(time.Duration(max(0, min(100, next-nowMs))) * time.Millisecond)
		}
	}()
}

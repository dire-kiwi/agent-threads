package agentthreads

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
)

// How harness processes are started. Direct runs them as child processes, which end with the
// backend; Shim runs them under agent-threads-shim, so they outlive it and a restarted backend
// re-attaches to them.

// SpawnOptions is a process to start.
type SpawnOptions struct {
	Command string
	Args    []string
	Cwd     string
	// Env is its whole environment (os.Environ() and more).
	Env []string
	// ThreadID and RunID are the thread the process runs and the run's id, for spawners that keep
	// records.
	ThreadID, RunID string
	// Post runs a function on the thread's goroutine: the spawner calls every handler through it.
	Post func(func())
}

// ExitStatus is how a process ended.
type ExitStatus struct {
	// Code is its exit code, if it exited.
	Code *int
	// Signal is the name of the signal that killed it (SIGTERM...), if one did.
	Signal string
	// Err is why it couldn't be started (or its end isn't known), if it couldn't.
	Err error
}

// ProcessHandlers are what a spawner calls (through SpawnOptions.Post) as a process runs.
type ProcessHandlers struct {
	// Line is a line of its stdout.
	Line func(line string)
	// Stderr is a line of its stderr.
	Stderr func(line string)
	// Exit says it ended (or never started), after its last line.
	Exit func(status ExitStatus)
	// Unanswered is the ids of its requests the driver has yet to answer (Claude's control requests'
	// request_ids, Codex's JSON-RPC request ids), for a process that outlives the backend: after a
	// restart, an answer it was given before isn't given again while the driver may still answer.
	Unanswered func() []string
}

// Process is a harness process a spawner started. Its methods are called on the thread's goroutine.
type Process interface {
	// Pid is its pid, or 0 if it isn't known yet.
	Pid() int
	// Write writes a line to its stdin.
	Write(line string)
	// CloseInput closes its stdin.
	CloseInput()
	// Kill signals it, and whatever it started (its process group).
	Kill(sig syscall.Signal)
}

// DurableProcess is a process that outlives the backend (the shim's).
type DurableProcess interface {
	Process
	// Dir is the run's directory.
	Dir() string
	// Offset is how far into its output the lines given so far go (bytes, whole lines only): the
	// backend saves it with the events it made of those lines.
	Offset() int64
	// InputOffset is how much of its input has been written (bytes): saved with the driver's state,
	// so input written after it isn't written again when what led to it is read again after a
	// restart.
	InputOffset() int64
	// Stop stops it: closes its stdin, then SIGTERM in grace ms (at once with now) and SIGKILL in
	// twice that, unless it has gone. That's written down first, so a backend that restarts
	// meanwhile carries on with it.
	Stop(graceMs int64, now bool)
	// Answered says whether an answer to its request id was written to its input already, after the
	// checkpoint it was re-attached from (and before the backend restarted): the harness has it, so
	// the request isn't asked again.
	Answered(id string) bool
	// Detach stops following it and leaves it running, for a backend that's shutting down and will
	// re-attach. No handler is called after this.
	Detach()
}

// Spawner starts harness processes.
type Spawner interface {
	// Name is "direct" or "shim": a thread's run says which started it.
	Name() string
	Spawn(opts SpawnOptions, handlers ProcessHandlers) (Process, error)
}

// DurableSpawner is a spawner whose processes outlive the backend. The backend then saves each run
// (its offset and what's needed to carry on reading it) with the thread's events, and re-attaches
// after a restart.
type DurableSpawner interface {
	Spawner
	// Attach follows a run started before a restart, from the offset saved with it.
	Attach(run RunRecord, handlers ProcessHandlers, post func(func())) (Process, error)
	// StopRun stops a run nothing will follow (its thread has gone on without it, or can't
	// re-attach): it ends its input and signals its process group, escalating to SIGKILL.
	StopRun(run RunRecord)
	// Prune removes what's left of runs the backend is done with (their directories), after the
	// time it keeps them, and stops runs that aren't the store's (their backend died before saving
	// them). It returns the number removed.
	Prune(ctx context.Context, store Store) (int, error)
	// Wait waits for the runs it's stopping to be stopped (or ctx to be done).
	Wait(ctx context.Context) error
}

// Direct is the spawner that runs harness processes as children of the backend, each in its own
// process group (on Unix).
func Direct() Spawner { return directSpawner{} }

type directSpawner struct{}

func (directSpawner) Name() string { return "direct" }

func (directSpawner) Spawn(o SpawnOptions, h ProcessHandlers) (Process, error) {
	cmd := exec.Command(o.Command, o.Args...)
	cmd.Dir = o.Cwd
	cmd.Env = o.Env
	setGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &directProcess{cmd: cmd, stdin: stdin, wake: make(chan struct{}, 1)}
	go p.writeInput()
	var wg sync.WaitGroup
	wg.Add(2)
	read := func(r io.Reader, fn func(string)) {
		defer wg.Done()
		br := bufio.NewReaderSize(r, 64*1024)
		for {
			data, err := br.ReadString('\n')
			if len(data) > 0 {
				line := trimCR(strings.TrimSuffix(data, "\n"))
				o.Post(func() { fn(line) })
			}
			if err != nil {
				return
			}
		}
	}
	go read(stdout, h.Line)
	go read(stderr, h.Stderr)
	go func() {
		// The output ends after the process exits and its stdio closes, so after the last line. Until
		// then something it started may still hold its stdio, so its group can still be signalled.
		wg.Wait()
		err := cmd.Wait()
		p.done.Store(true)
		// What's still queued for its stdin can't be written now.
		p.mu.Lock()
		p.broken, p.queue = true, nil
		p.mu.Unlock()
		p.nudge()
		status := exitStatus(cmd.ProcessState, err)
		o.Post(func() { h.Exit(status) })
	}()
	return p, nil
}

func trimCR(s string) string {
	if n := len(s); n > 0 && s[n-1] == '\r' {
		return s[:n-1]
	}
	return s
}

// directProcess is a child process. Its stdin is written by a goroutine of its own, in order, so a
// harness that stops reading it doesn't hold up the thread's goroutine (or Kill).
type directProcess struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	done  atomic.Bool

	mu sync.Mutex // guards what follows
	// queue is the lines still to be written, and closing says the input ends after them.
	queue   []string
	closing bool
	// broken says writing failed (the process has gone): nothing more is written.
	broken bool
	wake   chan struct{}
}

func (p *directProcess) Pid() int { return p.cmd.Process.Pid }

func (p *directProcess) Write(line string) {
	if len(line) == 0 || line[len(line)-1] != '\n' {
		line += "\n"
	}
	p.mu.Lock()
	if p.closing || p.broken {
		p.mu.Unlock()
		return
	}
	p.queue = append(p.queue, line)
	p.mu.Unlock()
	p.nudge()
}

func (p *directProcess) CloseInput() {
	p.mu.Lock()
	p.closing = true
	p.mu.Unlock()
	p.nudge()
}

func (p *directProcess) nudge() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// writeInput writes the queued lines to stdin, in order, and closes it once the input ends. A write
// that blocks (the harness isn't reading) is unblocked by the process going: Wait closes stdin then.
func (p *directProcess) writeInput() {
	for {
		p.mu.Lock()
		if len(p.queue) == 0 {
			if p.closing || p.broken {
				p.mu.Unlock()
				p.stdin.Close()
				return
			}
			p.mu.Unlock()
			<-p.wake
			continue
		}
		line := p.queue[0]
		p.queue = p.queue[1:]
		p.mu.Unlock()
		// Writing to a process that has gone fails with EPIPE; its exit says what happened.
		if _, err := io.WriteString(p.stdin, line); err != nil {
			p.mu.Lock()
			p.broken, p.queue = true, nil
			p.mu.Unlock()
		}
	}
}

func (p *directProcess) Kill(sig syscall.Signal) {
	if p.done.Load() {
		return
	}
	// The group outlives its leader while anything in it runs.
	if killGroup(p.cmd.Process.Pid, sig) == nil {
		return
	}
	p.cmd.Process.Signal(sig)
}

func exitStatus(state *os.ProcessState, err error) ExitStatus {
	if state == nil {
		if err == nil {
			err = errors.New("it didn't start")
		}
		return ExitStatus{Err: err}
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && runtime.GOOS != "windows" && ws.Signaled() {
		return ExitStatus{Signal: signalName(ws.Signal())}
	}
	code := state.ExitCode()
	return ExitStatus{Code: &code}
}

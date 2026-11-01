package agentthreads

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// loop runs a thread's work one function at a time, in the order it was posted, on a goroutine of
// its own: the thread's commands, its harness's output, timers, and what comes back from tools
// and the store. So a thread's state (and its driver's) is only ever touched by one goroutine, and
// needs no locks.
type loop struct {
	mu      sync.Mutex
	tasks   []task
	wake    chan struct{}
	stopped bool
	// after runs after each task (to save what it did).
	after   func()
	onPanic func(error)
}

type task struct {
	fn   func()
	done chan struct{}
}

func newLoop(after func(), onPanic func(error)) *loop {
	l := &loop{wake: make(chan struct{}, 1), after: after, onPanic: onPanic}
	go l.run()
	return l
}

// post runs fn on the loop, after what's posted already. After stop, it does nothing.
func (l *loop) post(fn func()) {
	l.push(task{fn: fn})
}

func (l *loop) push(t task) bool {
	l.mu.Lock()
	if l.stopped {
		l.mu.Unlock()
		if t.done != nil {
			close(t.done)
		}
		return false
	}
	l.tasks = append(l.tasks, t)
	l.mu.Unlock()
	select {
	case l.wake <- struct{}{}:
	default:
	}
	return true
}

// call runs fn on the loop and waits for it (and what it saves to be taken). It says whether it
// ran: not once the loop has stopped. It mustn't be called from the loop itself.
func (l *loop) call(fn func()) bool {
	ran := false
	done := make(chan struct{})
	l.push(task{fn: func() { fn(); ran = true }, done: done})
	<-done
	return ran
}

// callCtx is call, giving up the wait (not the function, which still runs) once ctx is done.
func (l *loop) callCtx(ctx context.Context, fn func()) error {
	ran := false
	done := make(chan struct{})
	l.push(task{fn: func() { fn(); ran = true }, done: done})
	select {
	case <-done:
		if !ran {
			return errLoopStopped
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var errLoopStopped = errors.New("the thread is closed")

func (l *loop) run() {
	for {
		l.mu.Lock()
		if len(l.tasks) == 0 {
			if l.stopped {
				l.mu.Unlock()
				return
			}
			l.mu.Unlock()
			<-l.wake
			continue
		}
		t := l.tasks[0]
		l.tasks[0] = task{}
		l.tasks = l.tasks[1:]
		l.mu.Unlock()
		l.exec(t)
	}
}

func (l *loop) exec(t task) {
	defer func() {
		if t.done != nil {
			close(t.done)
		}
	}()
	l.guard(t.fn)
	l.guard(l.after)
}

func (l *loop) guard(fn func()) {
	defer func() {
		if r := recover(); r != nil && l.onPanic != nil {
			l.onPanic(fmt.Errorf("agentthreads: a thread's goroutine panicked: %v", r))
		}
	}()
	if fn != nil {
		fn()
	}
}

// stop ends the loop: what's posted after is dropped, and so is what's waiting now.
func (l *loop) stop() {
	l.mu.Lock()
	if l.stopped {
		l.mu.Unlock()
		return
	}
	l.stopped = true
	pending := l.tasks
	l.tasks = nil
	l.mu.Unlock()
	for _, t := range pending {
		if t.done != nil {
			close(t.done)
		}
	}
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

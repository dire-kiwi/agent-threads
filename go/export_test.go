package agentthreads

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// HoldThreadPastTimers holds up a Claude thread's goroutine, whose steer and stop timers are both
// pending, until the AgentThreads is closing and both timers have gone off: so what Close posts to
// the thread (Detach) is queued ahead of what the timers post. It returns once the goroutine is held.
func HoldThreadPastTimers(a *AgentThreads, threadID string) error {
	rt := a.live(threadID)
	if rt == nil {
		return fmt.Errorf("thread %s isn't live", threadID)
	}
	held := make(chan error, 1)
	rt.loop.post(func() {
		s, _ := rt.session.(*claudeSession)
		if s == nil || s.steerTimer.pending() == nil || s.stopTimer.pending() == nil {
			held <- errors.New("its steer and stop timers aren't both pending")
			return
		}
		first, last := min(s.steerTimer.at, s.stopTimer.at), max(s.steerTimer.at, s.stopTimer.at)
		held <- nil
		for {
			a.mu.Lock()
			closed := a.closed
			a.mu.Unlock()
			if closed {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		// Close's call is pushed straight after it's closed.
		time.Sleep(50 * time.Millisecond)
		if time.Now().UnixMilli() >= first {
			fmt.Fprintln(os.Stderr, "HoldThreadPastTimers: a timer went off before Close got to the thread")
		}
		time.Sleep(time.Until(time.UnixMilli(last + 200)))
	})
	return <-held
}

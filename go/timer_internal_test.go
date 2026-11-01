package agentthreads

import (
	"testing"
	"time"
)

// A paused timer that had gone off already, with its function posted to the thread's goroutine but
// not run yet, doesn't run it, and keeps its deadline for the checkpoint.
func TestAPausedTimerThatHadGoneOff(t *testing.T) {
	var queued []func()
	posted := make(chan struct{}, 1)
	post := func(fn func()) {
		queued = append(queued, fn)
		posted <- struct{}{}
	}
	ran := false
	timer := startLoopTimer(post, time.Millisecond, func() { ran = true })
	<-posted
	timer.pause()
	for _, fn := range queued {
		fn()
	}
	if ran {
		t.Fatal("it went off after it was paused")
	}
	if timer.pending() == nil {
		t.Fatal("its deadline is gone")
	}
	// Stopped, it isn't pending.
	timer.stop()
	if timer.pending() != nil {
		t.Fatal("still pending after stop")
	}
}

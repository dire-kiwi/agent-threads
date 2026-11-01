//go:build unix

package agentthreads_test

import (
	"syscall"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
)

// Writing to a process that doesn't read its stdin doesn't block, and it can still be killed.
func TestDirectWritesDontBlock(t *testing.T) {
	exited := make(chan agentthreads.ExitStatus, 1)
	post := func(fn func()) { go fn() }
	proc, err := agentthreads.Direct().Spawn(agentthreads.SpawnOptions{Command: "sleep", Args: []string{"30"}, Post: post}, agentthreads.ProcessHandlers{
		Line: func(string) {}, Stderr: func(string) {}, Exit: func(s agentthreads.ExitStatus) { exited <- s },
	})
	if err != nil {
		t.Fatal(err)
	}
	line := make([]byte, 1<<20)
	for i := range line {
		line[i] = 'x'
	}
	start := time.Now()
	for range 8 {
		proc.Write(string(line))
	}
	proc.CloseInput()
	if d := time.Since(start); d > time.Second {
		t.Fatalf("writing took %s", d)
	}
	proc.Kill(syscall.SIGKILL)
	select {
	case s := <-exited:
		if s.Signal != "SIGKILL" {
			t.Fatalf("got %+v", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("it didn't exit")
	}
}

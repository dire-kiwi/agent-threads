//go:build unix

package agentthreads_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

// A Delete whose context runs out while the harness is still being stopped says so, and leaves the
// thread to its goroutine, which goes on to stop the harness (SIGKILL, for one that ignores SIGTERM
// and its input); deleting it again then deletes it.
func TestATimedOutDelete(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pid")
	bin := filepath.Join(dir, "stubborn")
	os.WriteFile(bin, []byte("#!/bin/sh\necho $$ > \"$PIDFILE\"\ntrap '' TERM\nexec sleep 1000\n"), 0o755)
	sdk := agentthreads.New(agentthreads.Options{
		Harnesses: map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{
			Bin: bin, Env: map[string]string{"PIDFILE": pidFile}, CloseGrace: 100 * time.Millisecond,
		})},
		OnError: func(error) {},
	})
	defer sdk.Stop(context.Background())
	ctx := context.Background()
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	sdk.Send(ctx, th.ID, "hi", agentthreads.SendOptions{})
	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for pid == 0 && time.Now().Before(deadline) {
		data, _ := os.ReadFile(pidFile)
		pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("the harness didn't start")
	}
	short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if ok, err := sdk.Delete(short, th.ID); ok || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v, %v", ok, err)
	}
	// Past both of the stop's deadlines (SIGTERM at 100ms, SIGKILL at 200ms), it's gone.
	time.Sleep(500 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("the harness is still running")
	}
	if ok, err := sdk.Delete(ctx, th.ID); !ok || err != nil {
		t.Fatalf("got %v, %v", ok, err)
	}
	if got, _ := sdk.Get(ctx, th.ID); got != nil {
		t.Fatal("still there")
	}
}

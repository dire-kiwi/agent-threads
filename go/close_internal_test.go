package agentthreads

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A Delete whose context runs out while the thread's goroutine is too busy to take the close gives up
// then; the close is still taken, and deleting it again deletes it.
func TestADeleteGivesUpOnABusyThread(t *testing.T) {
	sdk := New(Options{Harnesses: map[string]Harness{"claude": ClaudeCode(ClaudeOptions{Bin: "true"})}, OnError: func(error) {}})
	defer sdk.Stop(context.Background())
	ctx := context.Background()
	th, err := sdk.Create(ctx, CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	sdk.live(th.ID).loop.post(func() { <-release })
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if ok, err := sdk.Delete(short, th.ID); ok || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v, %v", ok, err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("it took %s", d)
	}
	close(release)
	if ok, err := sdk.Delete(ctx, th.ID); !ok || err != nil {
		t.Fatalf("got %v, %v", ok, err)
	}
}

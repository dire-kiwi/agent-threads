package agentthreads_test

// What the pass-through fixtures don't cover, against the Node backend's scriptable fake claude
// (mini-claude.mjs): raw left out by default, and control requests that can't be sent or answered.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// miniSDK is an AgentThreads running mini-claude.mjs as Claude, the log it writes of what it's
// sent, and its events.
func miniSDK(t *testing.T, o agentthreads.Options) (*agentthreads.AgentThreads, string, *recorder) {
	t.Helper()
	needNode(t)
	log := filepath.Join(t.TempDir(), "log.jsonl")
	bin := filepath.Join(specDir, "..", "ts", "packages", "node", "src", "test", "mini-claude.mjs")
	o.Harnesses = map[string]agentthreads.Harness{"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{Bin: bin, Env: map[string]string{"MINI_CLAUDE_LOG": log}})}
	o.Capabilities.Permissions = agentthreads.Allow
	o.OnError = func(err error) { t.Errorf("OnError: %v", err) }
	sdk := agentthreads.New(o)
	rec := &recorder{}
	sdk.Subscribe(rec.add)
	t.Cleanup(func() { sdk.Stop(context.Background()) })
	return sdk, log, rec
}

func eventually(t *testing.T, what func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !what() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settled is the thread's snapshot once it's idle (or failed).
func settled(t *testing.T, sdk *agentthreads.AgentThreads, id string) protocol.Snapshot {
	t.Helper()
	var snap protocol.Snapshot
	eventually(t, func() bool {
		snap, _ = sdk.Snapshot(context.Background(), id)
		return snap.Thread.Status == protocol.ThreadStatusIdle || snap.Thread.Status == protocol.ThreadStatusError
	})
	return snap
}

func TestRawIsLeftOutUnlessItsTurnedOnAndTheAppGetsEveryLine(t *testing.T) {
	var mu sync.Mutex
	var messages []agentthreads.HarnessMessage
	sdk, _, rec := miniSDK(t, agentthreads.Options{OnHarnessMessage: func(m agentthreads.HarnessMessage) {
		mu.Lock()
		messages = append(messages, m)
		mu.Unlock()
	}})
	ctx := context.Background()
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply hi", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	snap := settled(t, sdk, th.ID)
	for _, e := range rec.all() {
		if data := mustMarshal(e); bytes.Contains(data, []byte(`"raw"`)) {
			t.Errorf("an event with raw: %s", data)
		}
	}
	if data := mustMarshal(snap); bytes.Contains(data, []byte(`"raw"`)) {
		t.Errorf("a snapshot with raw: %s", data)
	}
	mu.Lock()
	defer mu.Unlock()
	types := map[string]bool{}
	for _, m := range messages {
		var v struct{ Type string }
		if err := json.Unmarshal(m.Message, &v); err != nil || m.Line != string(m.Message) {
			t.Errorf("a message that isn't its line, parsed: %+v", m)
		}
		if m.ThreadID != th.ID || m.Harness != "claude" || snap.Thread.Run == nil || m.RunID != snap.Thread.Run.ID {
			t.Errorf("a message for another thread or run: %+v", m)
		}
		types[v.Type] = true
	}
	for _, typ := range []string{"control_response", "system", "assistant", "result"} {
		if !types[typ] {
			t.Errorf("no %s message among %v", typ, types)
		}
	}
}

func TestControlSendsToTheRunningProcessAndFailsWhenItCant(t *testing.T) {
	sdk, log, _ := miniSDK(t, agentthreads.Options{})
	ctx := context.Background()
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	usage := json.RawMessage(`{"subtype":"get_context_usage"}`)
	var ce *agentthreads.CommandError
	if _, err := sdk.Control(ctx, th.ID, usage); !errors.As(err, &ce) {
		t.Fatalf("with no process: %v, want a CommandError", err)
	}
	if err := sdk.Send(ctx, th.ID, "reply hi", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	settled(t, sdk, th.ID)
	if got, err := sdk.Control(ctx, th.ID, usage); err != nil || string(got) != "{}" {
		t.Fatalf("got %s, %v", got, err)
	}
	if _, err := sdk.Control(ctx, th.ID, json.RawMessage(`"get_context_usage"`)); !errors.As(err, &ce) {
		t.Fatalf("a malformed request: %v, want a CommandError", err)
	}
	// One the process exits before answering.
	failed := make(chan error, 1)
	go func() {
		_, err := sdk.Control(ctx, th.ID, json.RawMessage(`{"subtype":"never_answered"}`))
		failed <- err
	}()
	eventually(t, func() bool {
		data, _ := os.ReadFile(log)
		return strings.Contains(string(data), `"never_answered"`)
	})
	if err := sdk.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	var ctl *agentthreads.ControlError
	if err := <-failed; !errors.As(err, &ctl) {
		t.Fatalf("one the process exited before answering: %v, want a ControlError", err)
	}
	if _, err := sdk.Control(ctx, th.ID, usage); !errors.As(err, &ce) {
		t.Fatalf("after Stop: %v, want a CommandError", err)
	}
}

func TestControlFailsWhenTheBackendLeavesTheRunGoing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no shim on Windows")
	}
	spawner := agentthreads.Shim(shimPath(t), agentthreads.ShimOptions{RunsDir: t.TempDir()})
	sdk, log, _ := miniSDK(t, agentthreads.Options{Spawner: spawner})
	ctx := context.Background()
	th, err := sdk.Create(ctx, agentthreads.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := sdk.Send(ctx, th.ID, "reply hi", agentthreads.SendOptions{}); err != nil {
		t.Fatal(err)
	}
	snap := settled(t, sdk, th.ID)
	failed := make(chan error, 1)
	go func() {
		_, err := sdk.Control(ctx, th.ID, json.RawMessage(`{"subtype":"never_answered"}`))
		failed <- err
	}()
	eventually(t, func() bool {
		data, _ := os.ReadFile(log)
		return strings.Contains(string(data), `"never_answered"`)
	})
	// Close leaves the run going, for a backend to re-attach to: the request goes unanswered.
	if err := sdk.Close(ctx); err != nil {
		t.Fatal(err)
	}
	var ctl *agentthreads.ControlError
	if err := <-failed; !errors.As(err, &ctl) {
		t.Fatalf("got %v, want a ControlError", err)
	}
	if snap.Thread.Run != nil {
		spawner.(agentthreads.DurableSpawner).StopRun(agentthreads.RunRecord{ID: snap.Thread.Run.ID})
	}
}

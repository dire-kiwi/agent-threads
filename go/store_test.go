package agentthreads_test

import (
	"os"
	"path/filepath"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/storetest"
)

const storeCases = "../spec/conformance/store.json"

func TestMemoryStore(t *testing.T) {
	storetest.Run(t, storeCases, func(t *testing.T) (agentthreads.Store, func() agentthreads.Store, bool) {
		state := agentthreads.NewMemoryState()
		return agentthreads.NewMemoryStoreOn(state), func() agentthreads.Store { return agentthreads.NewMemoryStoreOn(state) }, false
	})
}

func TestFileStore(t *testing.T) {
	storetest.Run(t, storeCases, func(t *testing.T) (agentthreads.Store, func() agentthreads.Store, bool) {
		dir := t.TempDir()
		store, err := agentthreads.NewFileStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		return store, func() agentthreads.Store {
			store.Close()
			store, err = agentthreads.NewFileStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			return store
		}, true
	})
}

// A half-written last line (a crash mid-write) is dropped when the store opens, and the store
// carries on from before it.
func TestFileStoreCrashMidWrite(t *testing.T) {
	dir := t.TempDir()
	store, err := agentthreads.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	if err := store.CreateThread(ctx, thread("th_1")); err != nil {
		t.Fatal(err)
	}
	store.Close()
	files, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	f, _ := os.OpenFile(files[0], os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"events":[{"type":"turn.started","thread_id":"th_1","seq":1,"tu`)
	f.Close()
	store, err = agentthreads.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if seq, err := store.LastSeq(ctx, "th_1"); err != nil || seq != 0 {
		t.Fatalf("got %d, %v", seq, err)
	}
	if err := store.AppendEvents(ctx, "th_1", events(t, `{"type":"turn.started","thread_id":"th_1","seq":1,"turn_id":"t"}`), nil); err != nil {
		t.Fatal(err)
	}
	reopened, err := agentthreads.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if seq, _ := reopened.LastSeq(ctx, "th_1"); seq != 1 {
		t.Fatalf("got seq %d", seq)
	}
}

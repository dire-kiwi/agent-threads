package sqlitestore_test

import (
	"path/filepath"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/sqlitestore"
	"github.com/dire-kiwi/agent-threads/go/storetest"
)

func TestStore(t *testing.T) {
	storetest.Run(t, "../../spec/conformance/store.json", func(t *testing.T) (agentthreads.Store, func() agentthreads.Store, bool) {
		path := filepath.Join(t.TempDir(), "threads.db")
		store, err := sqlitestore.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		return store, func() agentthreads.Store {
			store.Close()
			store, err = sqlitestore.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			return store
		}, true
	})
}

func TestMemoryDatabase(t *testing.T) {
	store, err := sqlitestore.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if threads, err := store.ListThreads(t.Context()); err != nil || len(threads) != 0 {
		t.Fatalf("got %v, %v", threads, err)
	}
}

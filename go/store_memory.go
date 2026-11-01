package agentthreads

import (
	"context"
	"sync"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// MemoryState is everything a MemoryStore holds. Another MemoryStore made on it sees the same
// threads (as a store opened again on the same file would).
type MemoryState struct {
	mu        sync.Mutex
	threads   map[string]protocol.Thread
	events    map[string][]protocol.ThreadEvent
	snapshots map[string]protocol.Snapshot
	runs      map[string]RunRecord
}

// NewMemoryState is an empty MemoryState.
func NewMemoryState() *MemoryState {
	return &MemoryState{
		threads:   map[string]protocol.Thread{},
		events:    map[string][]protocol.ThreadEvent{},
		snapshots: map[string]protocol.Snapshot{},
		runs:      map[string]RunRecord{},
	}
}

// MemoryStore keeps threads in memory: for tests, demos, and apps that don't keep threads. What it
// gives out are copies.
type MemoryStore struct {
	state *MemoryState
}

// NewMemoryStore is an empty MemoryStore.
func NewMemoryStore() *MemoryStore { return &MemoryStore{state: NewMemoryState()} }

// NewMemoryStoreOn is a MemoryStore on state, which other MemoryStores may share.
func NewMemoryStoreOn(state *MemoryState) *MemoryStore { return &MemoryStore{state: state} }

// State is what the store holds.
func (m *MemoryStore) State() *MemoryState { return m.state }

func (m *MemoryStore) lock() func() {
	m.state.mu.Lock()
	return m.state.mu.Unlock
}

func (m *MemoryStore) CreateThread(_ context.Context, thread protocol.Thread) error {
	defer m.lock()()
	if _, ok := m.state.threads[thread.ID]; ok {
		return NewStoreError(StoreErrExists, "thread %s exists", thread.ID)
	}
	m.state.threads[thread.ID] = clone(thread)
	m.state.events[thread.ID] = nil
	return nil
}

func (m *MemoryStore) GetThread(_ context.Context, id string) (*protocol.Thread, error) {
	defer m.lock()()
	t, ok := m.state.threads[id]
	if !ok {
		return nil, nil
	}
	c := clone(t)
	return &c, nil
}

func (m *MemoryStore) ListThreads(context.Context) ([]protocol.Thread, error) {
	defer m.lock()()
	out := make([]protocol.Thread, 0, len(m.state.threads))
	for _, t := range m.state.threads {
		out = append(out, clone(t))
	}
	SortThreads(out)
	return out, nil
}

func (m *MemoryStore) UpdateThread(_ context.Context, thread protocol.Thread) error {
	defer m.lock()()
	if _, ok := m.state.threads[thread.ID]; !ok {
		return notFound(thread.ID)
	}
	m.state.threads[thread.ID] = clone(thread)
	return nil
}

func (m *MemoryStore) DeleteThread(_ context.Context, id string) (bool, error) {
	defer m.lock()()
	if _, ok := m.state.threads[id]; !ok {
		return false, nil
	}
	delete(m.state.threads, id)
	delete(m.state.events, id)
	delete(m.state.snapshots, id)
	for rid, r := range m.state.runs {
		if r.ThreadID == id {
			delete(m.state.runs, rid)
		}
	}
	return true, nil
}

func (m *MemoryStore) log(id string) ([]protocol.ThreadEvent, error) {
	log, ok := m.state.events[id]
	if !ok {
		if _, known := m.state.threads[id]; !known {
			return nil, notFound(id)
		}
	}
	return log, nil
}

func lastOf(log []protocol.ThreadEvent) int64 {
	if len(log) == 0 {
		return 0
	}
	return log[len(log)-1].Seq()
}

func (m *MemoryStore) AppendEvents(_ context.Context, id string, events []protocol.ThreadEvent, runs []RunRecord) error {
	defer m.lock()()
	log, err := m.log(id)
	if err != nil {
		return err
	}
	if err := CheckEvents(id, lastOf(log), events, runs); err != nil {
		return err
	}
	for _, e := range events {
		log = append(log, clone(e))
	}
	m.state.events[id] = log
	for _, r := range runs {
		m.state.runs[r.ID] = clone(r)
	}
	return nil
}

func (m *MemoryStore) ReadEvents(_ context.Context, id string, after int64, limit int) ([]protocol.ThreadEvent, error) {
	defer m.lock()()
	log, err := m.log(id)
	if err != nil {
		return nil, err
	}
	// Events are numbered from 1 with no gaps, so the ones after `after` start at index `after`.
	from := min(max(after, 0), int64(len(log)))
	to := int64(len(log))
	if limit > 0 {
		to = min(to, from+int64(limit))
	}
	out := make([]protocol.ThreadEvent, 0, to-from)
	for _, e := range log[from:to] {
		out = append(out, clone(e))
	}
	return out, nil
}

func (m *MemoryStore) LastSeq(_ context.Context, id string) (int64, error) {
	defer m.lock()()
	log, err := m.log(id)
	if err != nil {
		return 0, err
	}
	return lastOf(log), nil
}

func (m *MemoryStore) SaveSnapshot(_ context.Context, id string, snapshot protocol.Snapshot) error {
	defer m.lock()()
	if _, err := m.log(id); err != nil {
		return err
	}
	m.state.snapshots[id] = clone(snapshot)
	return nil
}

func (m *MemoryStore) LoadSnapshot(_ context.Context, id string) (*protocol.Snapshot, error) {
	defer m.lock()()
	if _, err := m.log(id); err != nil {
		return nil, err
	}
	s, ok := m.state.snapshots[id]
	if !ok {
		return nil, nil
	}
	c := clone(s)
	return &c, nil
}

func (m *MemoryStore) PutRun(_ context.Context, run RunRecord) error {
	defer m.lock()()
	if _, ok := m.state.threads[run.ThreadID]; !ok {
		return notFound(run.ThreadID)
	}
	m.state.runs[run.ID] = clone(run)
	return nil
}

func (m *MemoryStore) GetRun(_ context.Context, id string) (*RunRecord, error) {
	defer m.lock()()
	r, ok := m.state.runs[id]
	if !ok {
		return nil, nil
	}
	c := clone(r)
	return &c, nil
}

func (m *MemoryStore) ActiveRuns(context.Context) ([]RunRecord, error) {
	defer m.lock()()
	out := []RunRecord{}
	for _, r := range m.state.runs {
		if r.Active() {
			out = append(out, clone(r))
		}
	}
	SortRuns(out)
	return out, nil
}

func (m *MemoryStore) Close() error { return nil }

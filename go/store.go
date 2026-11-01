package agentthreads

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// Where threads live: their Thread, their saved events (the source of truth), a snapshot to start
// from, and the harness processes the backend started. spec/conformance/store.md says what each
// operation does; MemoryStore, FileStore and sqlitestore.Store all pass spec/conformance/store.json
// (storetest.Run runs it), and an app can implement Store on its own database the same way.

// Store keeps threads, their events and snapshots, and the backend's runs. It may be used from
// several goroutines at once: each operation is atomic, and AppendEvents to one thread are
// serialized. Errors of the kinds the spec names are *StoreError (errors.Is(err, ErrNotFound)...).
type Store interface {
	// CreateThread adds a thread, with no events. It fails with ErrExists if there's one with its id.
	CreateThread(ctx context.Context, thread protocol.Thread) error
	// GetThread is the thread, or nil if there's none.
	GetThread(ctx context.Context, id string) (*protocol.Thread, error)
	// ListThreads is every thread, oldest first by created_at, then by id.
	ListThreads(ctx context.Context) ([]protocol.Thread, error)
	// UpdateThread replaces the thread with the same id, in full. It fails with ErrNotFound.
	UpdateThread(ctx context.Context, thread protocol.Thread) error
	// DeleteThread deletes the thread with its events, snapshot and runs, and says whether there was one.
	DeleteThread(ctx context.Context, id string) (bool, error)
	// AppendEvents appends saved events, all of them or none. Each is for the thread, isn't a
	// delta, and has the seq after the one before it. With runs (the thread's), it puts them too, in
	// the same atomic write: a run's offset is saved with the events made from its output, so after
	// a restart the output is read again from exactly there. It fails with ErrNotFound, ErrInvalid
	// or ErrSeq.
	AppendEvents(ctx context.Context, id string, events []protocol.ThreadEvent, runs []RunRecord) error
	// ReadEvents is the thread's events with a seq greater than after, in order, at most limit of
	// them (all of them if limit <= 0). It fails with ErrNotFound.
	ReadEvents(ctx context.Context, id string, after int64, limit int) ([]protocol.ThreadEvent, error)
	// LastSeq is the seq of the thread's last event, or 0. It fails with ErrNotFound.
	LastSeq(ctx context.Context, id string) (int64, error)
	// SaveSnapshot keeps the snapshot, replacing the one before. It fails with ErrNotFound.
	SaveSnapshot(ctx context.Context, id string, snapshot protocol.Snapshot) error
	// LoadSnapshot is the last snapshot saved, or nil. It fails with ErrNotFound.
	LoadSnapshot(ctx context.Context, id string) (*protocol.Snapshot, error)
	// PutRun adds the run, or replaces the one with its id. It fails with ErrNotFound if its thread
	// doesn't exist.
	PutRun(ctx context.Context, run RunRecord) error
	// GetRun is the run, or nil.
	GetRun(ctx context.Context, id string) (*RunRecord, error)
	// ActiveRuns is the runs with no ended_at, oldest first by started_at, then by id.
	ActiveRuns(ctx context.Context) ([]RunRecord, error)
	// Close lets go of files and connections.
	Close() error
}

// RunRecord is a harness process the backend started: its own record, for a spawner to re-attach
// to after a restart.
type RunRecord struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
	Spawner  string `json:"spawner"`
	// Offset is how far into the run's output the backend has read.
	Offset    int64  `json:"offset"`
	StartedAt string `json:"started_at"`
	// EndedAt is set once the backend has finished with the run.
	EndedAt string `json:"ended_at,omitempty"`
	// Data is anything else the backend keeps about it, stored as given.
	Data json.RawMessage `json:"data,omitempty"`
	// Extra has fields the backend doesn't know, kept as they came.
	Extra map[string]json.RawMessage `json:"-"`
}

var runFields = map[string]bool{"id": true, "thread_id": true, "spawner": true, "offset": true, "started_at": true, "ended_at": true, "data": true}

func (r RunRecord) MarshalJSON() ([]byte, error) {
	type plain RunRecord
	data, err := json.Marshal(plain(r))
	if err != nil || len(r.Extra) == 0 {
		return data, err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	for k, v := range r.Extra {
		if !runFields[k] {
			all[k] = v
		}
	}
	return json.Marshal(all)
}

func (r *RunRecord) UnmarshalJSON(data []byte) error {
	type plain RunRecord
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for k, v := range all {
		if !runFields[k] {
			if p.Extra == nil {
				p.Extra = map[string]json.RawMessage{}
			}
			p.Extra[k] = v
		}
	}
	if string(p.Data) == "null" {
		p.Data = nil
	}
	*r = RunRecord(p)
	return nil
}

// Active says whether the backend hasn't finished with the run.
func (r RunRecord) Active() bool { return r.EndedAt == "" }

// StoreErrorKind is the kind of a store's error, as spec/conformance/store.md names them.
type StoreErrorKind string

const (
	StoreErrExists   StoreErrorKind = "exists"
	StoreErrNotFound StoreErrorKind = "not_found"
	StoreErrInvalid  StoreErrorKind = "invalid"
	StoreErrSeq      StoreErrorKind = "seq"
)

// StoreError is a store's error of a kind the spec names. errors.Is matches it with the sentinel of
// its kind (ErrExists, ErrNotFound, ErrInvalid, ErrSeq).
type StoreError struct {
	Kind    StoreErrorKind
	Message string
}

func (e *StoreError) Error() string {
	if e.Message == "" {
		return "store: " + string(e.Kind)
	}
	return "store: " + e.Message
}

// Is matches a sentinel (a StoreError with no message) of the same kind.
func (e *StoreError) Is(target error) bool {
	t, ok := target.(*StoreError)
	return ok && t.Kind == e.Kind && t.Message == ""
}

var (
	ErrExists   = &StoreError{Kind: StoreErrExists}
	ErrNotFound = &StoreError{Kind: StoreErrNotFound}
	ErrInvalid  = &StoreError{Kind: StoreErrInvalid}
	ErrSeq      = &StoreError{Kind: StoreErrSeq}
)

// NewStoreError is an error of the kind, for a Store implementation to return.
func NewStoreError(kind StoreErrorKind, format string, args ...any) *StoreError {
	return &StoreError{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

func notFound(id string) error {
	return NewStoreError(StoreErrNotFound, "no thread %s", id)
}

// CheckEvents checks a batch of events (and runs) for AppendEvents to thread id, whose last seq is
// last: for a Store implementation to call.
func CheckEvents(id string, last int64, events []protocol.ThreadEvent, runs []RunRecord) error {
	for _, r := range runs {
		if r.ThreadID != id {
			return NewStoreError(StoreErrInvalid, "thread %s's run appended to %s", r.ThreadID, id)
		}
	}
	seq := last
	for _, e := range events {
		if !e.Saved() {
			return NewStoreError(StoreErrInvalid, "deltas aren't saved")
		}
		if e.ThreadID() != id {
			return NewStoreError(StoreErrInvalid, "an event for thread %s appended to %s", e.ThreadID(), id)
		}
		seq++
		if e.Seq() != seq {
			return NewStoreError(StoreErrSeq, "event seq %d, where %d comes next", e.Seq(), seq)
		}
	}
	return nil
}

// SortThreads sorts threads oldest first by created_at, then by id.
func SortThreads(threads []protocol.Thread) {
	sort.SliceStable(threads, func(i, j int) bool {
		a, b := threads[i], threads[j]
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return a.ID < b.ID
	})
}

// SortRuns sorts runs oldest first by started_at, then by id.
func SortRuns(runs []RunRecord) {
	sort.SliceStable(runs, func(i, j int) bool {
		a, b := runs[i], runs[j]
		if a.StartedAt != b.StartedAt {
			return a.StartedAt < b.StartedAt
		}
		return a.ID < b.ID
	})
}

// clone is a deep copy of v, by way of JSON (which the protocol's types keep exactly).
func clone[T any](v T) T {
	data, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("agentthreads: can't copy a %T: %v", v, err))
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		panic(fmt.Sprintf("agentthreads: can't copy a %T: %v", v, err))
	}
	return out
}

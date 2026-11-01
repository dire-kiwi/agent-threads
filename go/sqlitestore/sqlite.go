// Package sqlitestore is an agent-threads Store in a SQLite database, with modernc.org/sqlite (no
// cgo). Values are kept as JSON text, so they come back exactly as they were given. The tables are
// the Node backend's SqliteStore's, so either can open the database.
package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  active INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_active ON runs (active, started_at, id);
`

// Store is a Store in a SQLite database.
type Store struct {
	db    *sql.DB
	owned bool
	// One write at a time, so a transaction's reads and writes are atomic against the others'.
	mu sync.Mutex
}

var _ agentthreads.Store = (*Store)(nil)

// Open opens (or makes) the database at path, or ":memory:".
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	if path == ":memory:" {
		dsn = "file::memory:?_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: a :memory: database is per connection, and writes are serialized anyway.
	db.SetMaxOpenConns(1)
	s, err := New(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	s.owned = true
	return s, nil
}

// New is a store on an open database, which it doesn't close. It makes the tables if they aren't
// there.
func New(db *sql.DB) (*Store, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("sqlitestore: making the tables: %w", err)
	}
	return &Store{db: db}, nil
}

// DB is the store's database.
func (s *Store) DB() *sql.DB { return s.db }

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (s *Store) tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func known(ctx context.Context, q querier, id string) error {
	var one int
	err := q.QueryRowContext(ctx, "SELECT 1 FROM threads WHERE id = ?", id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return agentthreads.NewStoreError(agentthreads.StoreErrNotFound, "no thread %s", id)
	}
	return err
}

func lastSeq(ctx context.Context, q querier, id string) (int64, error) {
	var seq sql.NullInt64
	err := q.QueryRowContext(ctx, "SELECT MAX(seq) FROM events WHERE thread_id = ?", id).Scan(&seq)
	return seq.Int64, err
}

func jsonText(v any) (string, error) {
	data, err := json.Marshal(v)
	return string(data), err
}

// one reads a row's data column into v; false if there's no row.
func one(ctx context.Context, q querier, v any, query string, args ...any) (bool, error) {
	var data string
	err := q.QueryRowContext(ctx, query, args...).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal([]byte(data), v)
}

func all[T any](ctx context.Context, q querier, query string, args ...any) ([]T, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var v T
		if err := json.Unmarshal([]byte(data), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) CreateThread(ctx context.Context, thread protocol.Thread) error {
	data, err := jsonText(thread)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if known(ctx, tx, thread.ID) == nil {
			return agentthreads.NewStoreError(agentthreads.StoreErrExists, "thread %s exists", thread.ID)
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO threads (id, created_at, data) VALUES (?, ?, ?)", thread.ID, thread.CreatedAt, data)
		return err
	})
}

func (s *Store) GetThread(ctx context.Context, id string) (*protocol.Thread, error) {
	var t protocol.Thread
	ok, err := one(ctx, s.db, &t, "SELECT data FROM threads WHERE id = ?", id)
	if !ok || err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) ListThreads(ctx context.Context) ([]protocol.Thread, error) {
	return all[protocol.Thread](ctx, s.db, "SELECT data FROM threads ORDER BY created_at, id")
}

func (s *Store) UpdateThread(ctx context.Context, thread protocol.Thread) error {
	data, err := jsonText(thread)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, "UPDATE threads SET created_at = ?, data = ? WHERE id = ?", thread.CreatedAt, data, thread.ID)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return agentthreads.NewStoreError(agentthreads.StoreErrNotFound, "no thread %s", thread.ID)
		}
		return nil
	})
}

func (s *Store) DeleteThread(ctx context.Context, id string) (bool, error) {
	deleted := false
	err := s.tx(ctx, func(tx *sql.Tx) error {
		// Spelled out rather than left to ON DELETE CASCADE, for a database opened without foreign keys.
		for _, table := range []string{"events", "snapshots", "runs"} {
			if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE thread_id = ?", id); err != nil {
				return err
			}
		}
		r, err := tx.ExecContext(ctx, "DELETE FROM threads WHERE id = ?", id)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		deleted = n > 0
		return nil
	})
	return deleted, err
}

func (s *Store) AppendEvents(ctx context.Context, id string, events []protocol.ThreadEvent, runs []agentthreads.RunRecord) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := known(ctx, tx, id); err != nil {
			return err
		}
		last, err := lastSeq(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := agentthreads.CheckEvents(id, last, events, runs); err != nil {
			return err
		}
		for _, e := range events {
			data, err := jsonText(e)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO events (thread_id, seq, data) VALUES (?, ?, ?)", id, e.Seq(), data); err != nil {
				return err
			}
		}
		for _, r := range runs {
			if err := putRun(ctx, tx, r); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) ReadEvents(ctx context.Context, id string, after int64, limit int) ([]protocol.ThreadEvent, error) {
	if err := known(ctx, s.db, id); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = -1
	}
	return all[protocol.ThreadEvent](ctx, s.db, "SELECT data FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?", id, after, limit)
}

func (s *Store) LastSeq(ctx context.Context, id string) (int64, error) {
	if err := known(ctx, s.db, id); err != nil {
		return 0, err
	}
	return lastSeq(ctx, s.db, id)
}

func (s *Store) SaveSnapshot(ctx context.Context, id string, snapshot protocol.Snapshot) error {
	data, err := jsonText(snapshot)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := known(ctx, tx, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO snapshots (thread_id, data) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET data = excluded.data", id, data)
		return err
	})
}

func (s *Store) LoadSnapshot(ctx context.Context, id string) (*protocol.Snapshot, error) {
	if err := known(ctx, s.db, id); err != nil {
		return nil, err
	}
	var snap protocol.Snapshot
	ok, err := one(ctx, s.db, &snap, "SELECT data FROM snapshots WHERE thread_id = ?", id)
	if !ok || err != nil {
		return nil, err
	}
	return &snap, nil
}

func (s *Store) PutRun(ctx context.Context, run agentthreads.RunRecord) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := known(ctx, tx, run.ThreadID); err != nil {
			return err
		}
		return putRun(ctx, tx, run)
	})
}

func putRun(ctx context.Context, tx *sql.Tx, run agentthreads.RunRecord) error {
	data, err := jsonText(run)
	if err != nil {
		return err
	}
	active := 0
	if run.Active() {
		active = 1
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO runs (id, thread_id, started_at, active, data) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at, active = excluded.active, data = excluded.data`,
		run.ID, run.ThreadID, run.StartedAt, active, data)
	return err
}

func (s *Store) GetRun(ctx context.Context, id string) (*agentthreads.RunRecord, error) {
	var r agentthreads.RunRecord
	ok, err := one(ctx, s.db, &r, "SELECT data FROM runs WHERE id = ?", id)
	if !ok || err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) ActiveRuns(ctx context.Context) ([]agentthreads.RunRecord, error) {
	return all[agentthreads.RunRecord](ctx, s.db, "SELECT data FROM runs WHERE active = 1 ORDER BY started_at, id")
}

// Close closes the database, if the store opened it.
func (s *Store) Close() error {
	if s.owned {
		return s.db.Close()
	}
	return nil
}

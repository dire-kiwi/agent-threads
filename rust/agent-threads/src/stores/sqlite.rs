//! A store in a SQLite database (rusqlite, with SQLite bundled), with the same schema as the Node
//! backend's SqliteStore. Values are kept as JSON text, so they come back exactly as they were
//! given.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::store::{RunRecord, Store, StoreError, StoreErrorKind, StoreResult, check_events, str_field};

const SCHEMA: &str = "
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
";

/// A store in a SQLite database.
pub struct SqliteStore {
    db: Arc<Mutex<Option<Connection>>>,
}

fn failed(e: impl std::fmt::Display) -> StoreError {
    StoreError::failed(e)
}

fn parse<T: serde::de::DeserializeOwned>(text: String) -> StoreResult<T> {
    serde_json::from_str(&text).map_err(failed)
}

fn known(db: &Connection, id: &str) -> StoreResult<()> {
    let found = db
        .prepare_cached("SELECT 1 FROM threads WHERE id = ?")
        .and_then(|mut s| s.exists([id]))
        .map_err(failed)?;
    if found { Ok(()) } else { Err(StoreError::not_found(id)) }
}

fn last(db: &Connection, id: &str) -> StoreResult<u64> {
    db.prepare_cached("SELECT MAX(seq) FROM events WHERE thread_id = ?")
        .and_then(|mut s| s.query_row([id], |r| r.get::<_, Option<i64>>(0)))
        .map(|n| n.unwrap_or(0) as u64)
        .map_err(failed)
}

fn put_run(db: &Connection, run: &RunRecord) -> StoreResult<()> {
    let data = serde_json::to_string(run).map_err(failed)?;
    db.prepare_cached(
        "INSERT INTO runs (id, thread_id, started_at, active, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at,
         active = excluded.active, data = excluded.data",
    )
    .and_then(|mut s| s.execute(params![run.id, run.thread_id, run.started_at, run.is_active() as i64, data]))
    .map(|_| ())
    .map_err(failed)
}

impl SqliteStore {
    /// Opens the database at `path` (made if it doesn't exist), or ":memory:".
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        let db = Connection::open(path).map_err(failed)?;
        Self::with_connection(db)
    }

    /// A store on a connection the app opened.
    pub fn with_connection(db: Connection) -> StoreResult<Self> {
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
            .map_err(failed)?;
        db.execute_batch(SCHEMA).map_err(failed)?;
        Ok(SqliteStore { db: Arc::new(Mutex::new(Some(db))) })
    }

    /// Runs `op` on the connection, off the async runtime's threads.
    async fn run<T: Send + 'static>(&self, op: impl FnOnce(&mut Connection) -> StoreResult<T> + Send + 'static) -> StoreResult<T> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = db.lock().unwrap_or_else(|e| e.into_inner());
            let Some(conn) = guard.as_mut() else { return Err(failed("the store is closed")) };
            op(conn)
        })
        .await
        .map_err(failed)?
    }

    /// Runs `op` in a transaction that takes the write lock at once.
    async fn tx<T: Send + 'static>(&self, op: impl FnOnce(&Transaction) -> StoreResult<T> + Send + 'static) -> StoreResult<T> {
        self.run(move |db| {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(failed)?;
            let out = op(&tx)?;
            tx.commit().map_err(failed)?;
            Ok(out)
        })
        .await
    }
}

#[async_trait]
impl Store for SqliteStore {
    async fn create_thread(&self, thread: &Value) -> StoreResult<()> {
        let thread = thread.clone();
        self.tx(move |db| {
            let id = str_field(&thread, "id");
            if known(db, id).is_ok() {
                return Err(StoreError::new(StoreErrorKind::Exists, format!("thread {id} exists")));
            }
            db.execute(
                "INSERT INTO threads (id, created_at, data) VALUES (?, ?, ?)",
                params![id, str_field(&thread, "created_at"), thread.to_string()],
            )
            .map_err(failed)?;
            Ok(())
        })
        .await
    }

    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        let id = id.to_string();
        self.run(move |db| {
            let row: Option<String> = db
                .query_row("SELECT data FROM threads WHERE id = ?", [&id], |r| r.get(0))
                .optional()
                .map_err(failed)?;
            row.map(parse).transpose()
        })
        .await
    }

    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        self.run(|db| {
            let mut s = db.prepare_cached("SELECT data FROM threads ORDER BY created_at, id").map_err(failed)?;
            let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| parse(r.map_err(failed)?)).collect()
        })
        .await
    }

    async fn update_thread(&self, thread: &Value) -> StoreResult<()> {
        let thread = thread.clone();
        self.run(move |db| {
            let id = str_field(&thread, "id");
            let n = db
                .execute(
                    "UPDATE threads SET created_at = ?, data = ? WHERE id = ?",
                    params![str_field(&thread, "created_at"), thread.to_string(), id],
                )
                .map_err(failed)?;
            if n == 0 { Err(StoreError::not_found(id)) } else { Ok(()) }
        })
        .await
    }

    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        let id = id.to_string();
        self.tx(move |db| {
            // Spelled out rather than left to ON DELETE CASCADE, for a database opened without
            // foreign keys.
            for table in ["events", "snapshots", "runs"] {
                db.execute(&format!("DELETE FROM {table} WHERE thread_id = ?"), [&id]).map_err(failed)?;
            }
            Ok(db.execute("DELETE FROM threads WHERE id = ?", [&id]).map_err(failed)? > 0)
        })
        .await
    }

    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        let (id, events, runs) = (id.to_string(), events.to_vec(), runs.to_vec());
        self.tx(move |db| {
            known(db, &id)?;
            check_events(&id, last(db, &id)?, &events, &runs)?;
            let mut insert = db.prepare_cached("INSERT INTO events (thread_id, seq, data) VALUES (?, ?, ?)").map_err(failed)?;
            for e in &events {
                insert.execute(params![id, e["seq"].as_i64(), e.to_string()]).map_err(failed)?;
            }
            for r in &runs {
                put_run(db, r)?;
            }
            Ok(())
        })
        .await
    }

    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        let id = id.to_string();
        self.run(move |db| {
            known(db, &id)?;
            let mut s = db
                .prepare_cached("SELECT data FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?")
                .map_err(failed)?;
            let limit = limit.map_or(-1, |l| l.min(i64::MAX as usize) as i64);
            let rows = s.query_map(params![id, after as i64, limit], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| parse(r.map_err(failed)?)).collect()
        })
        .await
    }

    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        let id = id.to_string();
        self.run(move |db| {
            known(db, &id)?;
            last(db, &id)
        })
        .await
    }

    async fn save_snapshot(&self, id: &str, snapshot: &Value) -> StoreResult<()> {
        let (id, snapshot) = (id.to_string(), snapshot.clone());
        self.run(move |db| {
            known(db, &id)?;
            db.execute(
                "INSERT INTO snapshots (thread_id, data) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET data = excluded.data",
                params![id, snapshot.to_string()],
            )
            .map_err(failed)?;
            Ok(())
        })
        .await
    }

    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        let id = id.to_string();
        self.run(move |db| {
            known(db, &id)?;
            let row: Option<String> = db
                .query_row("SELECT data FROM snapshots WHERE thread_id = ?", [&id], |r| r.get(0))
                .optional()
                .map_err(failed)?;
            row.map(parse).transpose()
        })
        .await
    }

    async fn put_run(&self, run: &RunRecord) -> StoreResult<()> {
        let run = run.clone();
        self.run(move |db| {
            known(db, &run.thread_id)?;
            put_run(db, &run)
        })
        .await
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        let id = id.to_string();
        self.run(move |db| {
            let row: Option<String> =
                db.query_row("SELECT data FROM runs WHERE id = ?", [&id], |r| r.get(0)).optional().map_err(failed)?;
            row.map(parse).transpose()
        })
        .await
    }

    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        self.run(|db| {
            let mut s = db.prepare_cached("SELECT data FROM runs WHERE active = 1 ORDER BY started_at, id").map_err(failed)?;
            let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| parse(r.map_err(failed)?)).collect()
        })
        .await
    }

    async fn close(&self) -> StoreResult<()> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            db.lock().unwrap_or_else(|e| e.into_inner()).take();
        })
        .await
        .map_err(failed)
    }
}

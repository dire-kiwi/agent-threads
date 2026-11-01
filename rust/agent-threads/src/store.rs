//! Where threads live: their `Thread`, their saved events (the source of truth), a snapshot to start
//! from, and the harness processes the backend started. spec/conformance/store.md says what each
//! operation does; [`MemoryStore`](crate::MemoryStore), [`FileStore`](crate::FileStore) and
//! [`SqliteStore`](crate::SqliteStore) all pass spec/conformance/store.json, and an app can implement
//! [`Store`] on its own database the same way.
//!
//! A store keeps every value exactly as it was given, fields it doesn't know included (a newer
//! backend's, say), so threads, events and snapshots go through it as JSON values.

use std::cmp::Ordering;
use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A harness process the backend started: its own record, for a spawner to re-attach to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub thread_id: String,
    pub spawner: String,
    /// How far into the run's output the backend has read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    pub started_at: String,
    /// Set once the backend has finished with the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Anything else the backend keeps about it, stored as given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// Fields this backend doesn't know, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl RunRecord {
    pub fn is_active(&self) -> bool {
        self.ended_at.is_none()
    }
}

/// What a store fails with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreErrorKind {
    /// There's a thread with the id already.
    Exists,
    /// There's no such thread.
    NotFound,
    /// The events (or runs) given aren't the thread's, or a delta.
    Invalid,
    /// The events' seqs leave a gap, or repeat one.
    Seq,
    /// The store couldn't do it (an I/O error, say).
    Failed,
}

#[derive(Clone, Debug)]
pub struct StoreError {
    pub kind: StoreErrorKind,
    pub message: String,
}

impl StoreError {
    pub fn new(kind: StoreErrorKind, message: impl Into<String>) -> Self {
        StoreError { kind, message: message.into() }
    }

    pub fn failed(error: impl fmt::Display) -> Self {
        StoreError::new(StoreErrorKind::Failed, error.to_string())
    }

    pub(crate) fn not_found(id: &str) -> Self {
        StoreError::new(StoreErrorKind::NotFound, format!("no thread {id}"))
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StoreError {}

pub type StoreResult<T> = Result<T, StoreError>;

/// Where threads are kept. Threads, events and snapshots are JSON values (a `Thread`, a saved
/// `ThreadEvent`, a `Snapshot`), which a store keeps as given.
#[async_trait]
pub trait Store: Send + Sync {
    /// Adds a thread, with no events. Fails with `Exists` if there's one with its id.
    async fn create_thread(&self, thread: &Value) -> StoreResult<()>;
    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>>;
    /// Every thread, oldest first by `created_at`, then by id.
    async fn list_threads(&self) -> StoreResult<Vec<Value>>;
    /// Replaces the thread with the same id, in full. Fails with `NotFound`.
    async fn update_thread(&self, thread: &Value) -> StoreResult<()>;
    /// Deletes the thread with its events, snapshot and runs; whether there was one.
    async fn delete_thread(&self, id: &str) -> StoreResult<bool>;
    /// Appends saved events, all of them or none. Each is for the thread, isn't a delta, and has
    /// the seq after the one before it. With `runs` (the thread's), it puts them too, in the same
    /// atomic write. Fails with `NotFound`, `Invalid` or `Seq`.
    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()>;
    /// The thread's events with a seq after `after`, in order, at most `limit` of them. Fails with
    /// `NotFound`.
    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>>;
    /// The seq of the thread's last event, or 0. Fails with `NotFound`.
    async fn last_seq(&self, id: &str) -> StoreResult<u64>;
    /// Keeps the snapshot, replacing the one before. Fails with `NotFound`.
    async fn save_snapshot(&self, id: &str, snapshot: &Value) -> StoreResult<()>;
    /// The last snapshot saved, or none. Fails with `NotFound`.
    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>>;
    /// Adds the run, or replaces the one with its id. Fails with `NotFound` if its thread doesn't
    /// exist.
    async fn put_run(&self, run: &RunRecord) -> StoreResult<()>;
    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>>;
    /// The runs with no `ended_at`, oldest first by `started_at`, then by id.
    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>>;
    /// Lets go of files and connections.
    async fn close(&self) -> StoreResult<()> {
        Ok(())
    }
}

/// Checks a batch of events (and runs) for `append_events` to thread `id`, whose last seq is
/// `last`.
pub(crate) fn check_events(id: &str, last: u64, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
    for r in runs {
        if r.thread_id != id {
            return Err(StoreError::new(
                StoreErrorKind::Invalid,
                format!("thread {}'s run appended to {id}", r.thread_id),
            ));
        }
    }
    let mut seq = last;
    for e in events {
        if e.get("type").and_then(Value::as_str) == Some("delta") {
            return Err(StoreError::new(StoreErrorKind::Invalid, "deltas aren't saved"));
        }
        let thread = e.get("thread_id").and_then(Value::as_str);
        if thread != Some(id) {
            return Err(StoreError::new(
                StoreErrorKind::Invalid,
                format!("an event for thread {} appended to {id}", thread.unwrap_or("?")),
            ));
        }
        seq += 1;
        let got = e.get("seq").and_then(Value::as_u64);
        if got != Some(seq) {
            return Err(StoreError::new(
                StoreErrorKind::Seq,
                format!("event seq {}, where {seq} comes next", e.get("seq").unwrap_or(&Value::Null)),
            ));
        }
    }
    Ok(())
}

/// A JSON value's string field, or "".
pub(crate) fn str_field<'a>(v: &'a Value, name: &str) -> &'a str {
    v.get(name).and_then(Value::as_str).unwrap_or("")
}

/// Oldest first by `created_at` (threads), then by id.
pub(crate) fn thread_order(a: &Value, b: &Value) -> Ordering {
    str_field(a, "created_at").cmp(str_field(b, "created_at")).then_with(|| str_field(a, "id").cmp(str_field(b, "id")))
}

/// Oldest first by `started_at` (runs), then by id.
pub(crate) fn run_order(a: &RunRecord, b: &RunRecord) -> Ordering {
    a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id))
}

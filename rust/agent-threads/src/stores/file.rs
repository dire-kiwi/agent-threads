//! A store in a directory, with one JSONL file per thread, in the same format as the Node
//! backend's FileStore. Each line is a change: the thread as created or updated, a batch of events
//! (with the runs saved with them), a snapshot or a run. The files are read into memory when the
//! store opens, and each change is appended and synced before the operation returns, so it survives
//! the process being killed. A write that fails is cut off the file again, so a failed operation
//! leaves nothing behind; a half-written last line (from a crash mid-write) is dropped.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::memory::State;
use crate::store::{RunRecord, Store, StoreError, StoreErrorKind, StoreResult, check_events, str_field};

const SUFFIX: &str = ".jsonl";

/// A store in a directory of JSONL files.
pub struct FileStore {
    dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    dir: PathBuf,
    mem: State,
    files: HashMap<String, (File, u64)>,
    // A run's lines carry a revision, counted across the store, since a run moved to another
    // thread is in two files: the latest of its lines says where it is (or, if it's `run_moved`,
    // that it's gone).
    rev: u64,
    /// Why a failed write couldn't be undone, after which nothing more is written until a reopen.
    broken: Option<String>,
}

impl FileStore {
    /// Opens the store in `dir`, making it if it doesn't exist.
    pub fn open(dir: impl Into<PathBuf>) -> StoreResult<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).map_err(StoreError::failed)?;
        let (mem, rev) = load(&dir)?;
        let inner = Inner { dir: dir.clone(), mem, files: HashMap::new(), rev, broken: None };
        Ok(FileStore { dir, inner: Arc::new(Mutex::new(inner)) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs a write off the async runtime's threads, after every operation before it.
    async fn write<T: Send + 'static>(&self, op: impl FnOnce(&mut Inner) -> StoreResult<T> + Send + 'static) -> StoreResult<T> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || op(&mut inner.lock().unwrap_or_else(|e| e.into_inner())))
            .await
            .map_err(StoreError::failed)?
    }
}

fn path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}{SUFFIX}", encode_uri_component(id)))
}

/// The file's name for an id, as JavaScript's encodeURIComponent makes it.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn load(dir: &Path) -> StoreResult<(State, u64)> {
    let mut state = State::default();
    let mut rev = 0;
    let mut runs: HashMap<String, (Option<RunRecord>, u64)> = HashMap::new(); // each run's latest line
    for entry in fs::read_dir(dir).map_err(StoreError::failed)? {
        let entry = entry.map_err(StoreError::failed)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(SUFFIX) {
            continue;
        }
        let path = entry.path();
        let mut bytes = fs::read(&path).map_err(StoreError::failed)?;
        let end = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |n| n + 1);
        if end < bytes.len() {
            // The last write didn't finish: it never returned, so it didn't happen.
            let f = OpenOptions::new().write(true).open(&path).map_err(StoreError::failed)?;
            f.set_len(end as u64).map_err(StoreError::failed)?;
            bytes.truncate(end);
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut id: Option<String> = None;
        let mut mine: HashMap<String, (Option<RunRecord>, u64)> = HashMap::new();
        for raw in text.split('\n').filter(|l| !l.is_empty()) {
            let line: Value = serde_json::from_str(raw).map_err(|e| StoreError::failed(format!("{}: {e}", path.display())))?;
            let run_rev = line.get("rev").and_then(Value::as_u64).unwrap_or(0);
            if let Some(thread) = line.get("thread") {
                let tid = str_field(thread, "id").to_string();
                state.threads.insert(tid.clone(), thread.clone());
                state.events.entry(tid.clone()).or_default();
                id = Some(tid);
                continue;
            }
            let Some(tid) = &id else {
                return Err(StoreError::failed(format!("{} doesn't start with its thread", path.display())));
            };
            if let Some(events) = line.get("events").and_then(Value::as_array) {
                let log = state.events.get_mut(tid).unwrap();
                for e in events {
                    let last = log.last().and_then(|x| x.get("seq")).and_then(Value::as_u64).unwrap_or(0);
                    if e.get("seq").and_then(Value::as_u64).unwrap_or(0) > last {
                        log.push(e.clone());
                    }
                }
                for r in line.get("runs").and_then(Value::as_array).into_iter().flatten() {
                    let run: RunRecord = serde_json::from_value(r["run"].clone()).map_err(StoreError::failed)?;
                    let rev = r.get("rev").and_then(Value::as_u64).unwrap_or(0);
                    mine.insert(run.id.clone(), (Some(run), rev));
                }
            } else if let Some(snapshot) = line.get("snapshot") {
                state.snapshots.insert(tid.clone(), snapshot.clone());
            } else if let Some(run) = line.get("run") {
                let run: RunRecord = serde_json::from_value(run.clone()).map_err(StoreError::failed)?;
                mine.insert(run.id.clone(), (Some(run), run_rev));
            } else if let Some(moved) = line.get("run_moved").and_then(Value::as_str) {
                mine.insert(moved.to_string(), (None, run_rev));
            }
        }
        for (rid, (run, r)) in mine {
            rev = rev.max(r);
            if runs.get(&rid).is_none_or(|(_, have)| r >= *have) {
                runs.insert(rid, (run, r));
            }
        }
    }
    for (rid, (run, _)) in runs {
        if let Some(run) = run {
            state.runs.insert(rid, run);
        }
    }
    Ok((state, rev))
}

impl Inner {
    fn file(&mut self, id: &str) -> std::io::Result<&mut (File, u64)> {
        if !self.files.contains_key(id) {
            let f = OpenOptions::new().create(true).append(true).open(path(&self.dir, id))?;
            let size = f.metadata()?.len();
            self.files.insert(id.to_string(), (f, size));
        }
        Ok(self.files.get_mut(id).unwrap())
    }

    /// Appends lines (to one thread's file or several), all or none: each is written in full and
    /// synced, and if one fails, what was written is cut off again.
    fn append(&mut self, lines: Vec<(String, Value)>) -> StoreResult<()> {
        if let Some(e) = &self.broken {
            return Err(StoreError::failed(format!(
                "the store can't be written to until it's opened again: a failed write couldn't be undone ({e})"
            )));
        }
        let mut written: Vec<(String, u64)> = Vec::new();
        let mut result = Ok(());
        for (id, line) in lines {
            let mut bytes = serde_json::to_vec(&line).map_err(StoreError::failed)?;
            bytes.push(b'\n');
            let r = (|| -> std::io::Result<()> {
                let (f, size) = self.file(&id)?;
                written.push((id.clone(), *size));
                f.write_all(&bytes)?;
                f.sync_data()?;
                *size += bytes.len() as u64;
                Ok(())
            })();
            if let Err(e) = r {
                result = Err(StoreError::failed(e));
                break;
            }
        }
        if result.is_err() {
            for (id, size) in written.into_iter().rev() {
                let Some((f, at)) = self.files.get_mut(&id) else { continue };
                match f.set_len(size).and_then(|_| f.sync_data()) {
                    Ok(()) => *at = size,
                    Err(e) => self.broken = Some(e.to_string()),
                }
            }
        }
        result
    }

    fn known(&self, id: &str) -> StoreResult<()> {
        if self.mem.threads.contains_key(id) { Ok(()) } else { Err(StoreError::not_found(id)) }
    }

    /// The thread a run was in before, if putting it in another moves it out of that one's file.
    fn moved(&self, run: &RunRecord) -> Option<String> {
        let before = self.mem.runs.get(&run.id)?;
        (before.thread_id != run.thread_id && self.mem.threads.contains_key(&before.thread_id))
            .then(|| before.thread_id.clone())
    }
}

#[async_trait]
impl Store for FileStore {
    async fn create_thread(&self, thread: &Value) -> StoreResult<()> {
        let thread = thread.clone();
        self.write(move |s| {
            let id = str_field(&thread, "id").to_string();
            if s.mem.threads.contains_key(&id) {
                return Err(StoreError::new(StoreErrorKind::Exists, format!("thread {id} exists")));
            }
            s.append(vec![(id, json!({ "thread": thread }))])?;
            s.mem.create_thread(&thread)
        })
        .await
    }

    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        Ok(self.lock().mem.threads.get(id).cloned())
    }

    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        Ok(self.lock().mem.list_threads())
    }

    async fn update_thread(&self, thread: &Value) -> StoreResult<()> {
        let thread = thread.clone();
        self.write(move |s| {
            let id = str_field(&thread, "id").to_string();
            s.known(&id)?;
            s.append(vec![(id, json!({ "thread": thread }))])?;
            s.mem.update_thread(&thread)
        })
        .await
    }

    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        let id = id.to_string();
        self.write(move |s| {
            if !s.mem.threads.contains_key(&id) {
                return Ok(false);
            }
            s.files.remove(&id);
            match fs::remove_file(path(&s.dir, &id)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::failed(e)),
            }
            Ok(s.mem.delete_thread(&id))
        })
        .await
    }

    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        let (id, events, runs) = (id.to_string(), events.to_vec(), runs.to_vec());
        self.write(move |s| {
            check_events(&id, s.mem.last(&id)?, &events, &runs)?;
            if events.is_empty() && runs.is_empty() {
                return Ok(());
            }
            let mut rev = s.rev;
            let mut lines = Vec::new();
            let mut revs = Vec::new();
            for run in &runs {
                if let Some(from) = s.moved(run) {
                    rev += 1;
                    lines.push((from, json!({ "run_moved": run.id, "rev": rev })));
                }
                rev += 1;
                revs.push(json!({ "run": run, "rev": rev }));
            }
            let mut line = json!({ "events": events });
            if !revs.is_empty() {
                line["runs"] = Value::Array(revs);
            }
            lines.push((id.clone(), line));
            s.append(lines)?;
            s.rev = rev;
            s.mem.append_events(&id, &events, &runs)
        })
        .await
    }

    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        self.lock().mem.read_events(id, after, limit)
    }

    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        self.lock().mem.last(id)
    }

    async fn save_snapshot(&self, id: &str, snapshot: &Value) -> StoreResult<()> {
        let (id, snapshot) = (id.to_string(), snapshot.clone());
        self.write(move |s| {
            s.known(&id)?;
            s.append(vec![(id.clone(), json!({ "snapshot": snapshot }))])?;
            s.mem.save_snapshot(&id, &snapshot)
        })
        .await
    }

    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.lock().mem.load_snapshot(id)
    }

    async fn put_run(&self, run: &RunRecord) -> StoreResult<()> {
        let run = run.clone();
        self.write(move |s| {
            s.known(&run.thread_id)?;
            let moved = s.moved(&run);
            let rev = s.rev + if moved.is_some() { 2 } else { 1 };
            let mut lines = Vec::new();
            if let Some(from) = moved {
                lines.push((from, json!({ "run_moved": run.id, "rev": rev - 1 })));
            }
            lines.push((run.thread_id.clone(), json!({ "run": run, "rev": rev })));
            s.append(lines)?;
            s.rev = rev;
            s.mem.put_run(&run)
        })
        .await
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        Ok(self.lock().mem.runs.get(id).cloned())
    }

    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        Ok(self.lock().mem.active_runs())
    }

    async fn close(&self) -> StoreResult<()> {
        self.write(|s| {
            s.files.clear();
            Ok(())
        })
        .await
    }
}

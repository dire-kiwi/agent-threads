//! A store in memory: for tests, demos, and apps that don't keep threads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;

use crate::store::{
    RunRecord, Store, StoreError, StoreErrorKind, StoreResult, check_events, run_order, str_field, thread_order,
};

/// Everything a [`MemoryStore`] holds. Another `MemoryStore` made on the same state sees the same
/// threads.
#[derive(Clone, Default)]
pub struct MemoryState(pub(crate) Arc<Mutex<State>>);

#[derive(Default)]
pub(crate) struct State {
    pub threads: HashMap<String, Value>,
    pub events: HashMap<String, Vec<Value>>,
    pub snapshots: HashMap<String, Value>,
    pub runs: HashMap<String, RunRecord>,
}

impl MemoryState {
    pub fn new() -> Self {
        Self::default()
    }
}

impl State {
    pub fn log(&self, id: &str) -> StoreResult<&Vec<Value>> {
        self.events.get(id).ok_or_else(|| StoreError::not_found(id))
    }

    pub fn last(&self, id: &str) -> StoreResult<u64> {
        Ok(self.log(id)?.last().and_then(|e| e.get("seq")).and_then(Value::as_u64).unwrap_or(0))
    }

    pub fn create_thread(&mut self, thread: &Value) -> StoreResult<()> {
        let id = str_field(thread, "id").to_string();
        if self.threads.contains_key(&id) {
            return Err(StoreError::new(StoreErrorKind::Exists, format!("thread {id} exists")));
        }
        self.threads.insert(id.clone(), thread.clone());
        self.events.insert(id, Vec::new());
        Ok(())
    }

    pub fn update_thread(&mut self, thread: &Value) -> StoreResult<()> {
        let id = str_field(thread, "id");
        let Some(t) = self.threads.get_mut(id) else { return Err(StoreError::not_found(id)) };
        *t = thread.clone();
        Ok(())
    }

    pub fn delete_thread(&mut self, id: &str) -> bool {
        if self.threads.remove(id).is_none() {
            return false;
        }
        self.events.remove(id);
        self.snapshots.remove(id);
        self.runs.retain(|_, r| r.thread_id != id);
        true
    }

    pub fn append_events(&mut self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        check_events(id, self.last(id)?, events, runs)?;
        self.events.get_mut(id).unwrap().extend(events.iter().cloned());
        for r in runs {
            self.runs.insert(r.id.clone(), r.clone());
        }
        Ok(())
    }

    pub fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        let log = self.log(id)?;
        // Events are numbered from 1 with no gaps, so the ones after `after` start at index `after`.
        let from = (after as usize).min(log.len());
        let to = limit.map_or(log.len(), |l| from.saturating_add(l).min(log.len()));
        Ok(log[from..to].to_vec())
    }

    pub fn save_snapshot(&mut self, id: &str, snapshot: &Value) -> StoreResult<()> {
        self.log(id)?;
        self.snapshots.insert(id.to_string(), snapshot.clone());
        Ok(())
    }

    pub fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.log(id)?;
        Ok(self.snapshots.get(id).cloned())
    }

    pub fn put_run(&mut self, run: &RunRecord) -> StoreResult<()> {
        if !self.threads.contains_key(&run.thread_id) {
            return Err(StoreError::not_found(&run.thread_id));
        }
        self.runs.insert(run.id.clone(), run.clone());
        Ok(())
    }

    pub fn list_threads(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.threads.values().cloned().collect();
        out.sort_by(thread_order);
        out
    }

    pub fn active_runs(&self) -> Vec<RunRecord> {
        let mut out: Vec<RunRecord> = self.runs.values().filter(|r| r.is_active()).cloned().collect();
        out.sort_by(run_order);
        out
    }
}

/// A store in memory.
#[derive(Clone, Default)]
pub struct MemoryStore {
    pub state: MemoryState,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store on `state`, which another store may have made threads in.
    pub fn with_state(state: MemoryState) -> Self {
        MemoryStore { state }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn create_thread(&self, thread: &Value) -> StoreResult<()> {
        self.lock().create_thread(thread)
    }

    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        Ok(self.lock().threads.get(id).cloned())
    }

    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        Ok(self.lock().list_threads())
    }

    async fn update_thread(&self, thread: &Value) -> StoreResult<()> {
        self.lock().update_thread(thread)
    }

    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        Ok(self.lock().delete_thread(id))
    }

    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        self.lock().append_events(id, events, runs)
    }

    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        self.lock().read_events(id, after, limit)
    }

    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        self.lock().last(id)
    }

    async fn save_snapshot(&self, id: &str, snapshot: &Value) -> StoreResult<()> {
        self.lock().save_snapshot(id, snapshot)
    }

    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.lock().load_snapshot(id)
    }

    async fn put_run(&self, run: &RunRecord) -> StoreResult<()> {
        self.lock().put_run(run)
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        Ok(self.lock().runs.get(id).cloned())
    }

    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        Ok(self.lock().active_runs())
    }
}

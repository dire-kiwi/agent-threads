//! AgentThreads: the backend an app runs. It creates threads, takes commands, runs each thread's
//! harness, and sends every thread's events to its subscribers, which the app wires to its own
//! transport.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::harness::{
    ControlReply, Harness, HarnessMessageHandler, LaunchOptions, McpServer, Skill, ThreadConfig, TurnEnd,
};
use crate::ids::{new_id, now_iso};
use crate::permissions::PermissionPolicy;
use crate::protocol::{
    Attachment, Command, Item, ItemPage, PermissionMode, Resolution, Snapshot, StandingAnswer, SubagentStatus, Thread,
    ThreadEvent, ThreadStatus,
};
use crate::reducer::{apply_event, initial_state, open_requests};
use crate::spawner::{Spawner, direct};
use crate::store::{RunRecord, Store, StoreError};
use crate::stores::memory::MemoryStore;
use crate::thread::{Actor, Host, Job, Outgoing, ThreadContext, Turn};
use crate::tools::Tool;
use crate::window::{item_page, snapshot_window};

/// What goes wrong.
#[derive(Clone, Debug)]
pub enum Error {
    /// A command that can't be carried out: an unknown thread, a malformed command, or an
    /// AgentThreads that's closed.
    Command(String),
    /// The store failed.
    Store(StoreError),
    /// A control request ([`AgentThreads::control`]) the harness refused, or didn't answer: its
    /// process exited first, or the backend closed. `error` is the harness's own error, when it
    /// gave one (Claude Code's error text, or Codex's JSON-RPC error object).
    Control { message: String, error: Option<Value> },
    /// Something else: a harness that misbehaved, say (for `on_error`).
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Command(m) | Error::Other(m) | Error::Control { message: m, .. } => f.write_str(m),
            Error::Store(e) => write!(f, "the store failed: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<StoreError> for Error {
    fn from(e: StoreError) -> Self {
        Error::Store(e)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Tools, MCP servers, skills and the permission policy: for every thread, or for one.
#[derive(Clone, Default)]
pub struct Capabilities {
    pub tools: Vec<Arc<dyn Tool>>,
    pub mcp_servers: BTreeMap<String, McpServer>,
    pub skills: Vec<Skill>,
    /// Whether the agent may call a tool: allow, deny or ask the user. Asking is the default.
    pub permissions: Option<PermissionPolicy>,
    /// Added to the harness's own system prompt.
    pub system_prompt: Option<String>,
}

/// Changes to a thread's own capabilities, for [`AgentThreads::configure`]: what's left out (`None`)
/// stays as it is, and what's given replaces what the thread had (an empty list clears it).
#[derive(Clone, Default)]
pub struct CapabilitiesUpdate {
    pub tools: Option<Vec<Arc<dyn Tool>>>,
    pub mcp_servers: Option<BTreeMap<String, McpServer>>,
    pub skills: Option<Vec<Skill>>,
    pub permissions: Option<PermissionPolicy>,
    /// `Some("")` clears it.
    pub system_prompt: Option<String>,
}

impl From<Capabilities> for CapabilitiesUpdate {
    /// Every capability given (a policy or prompt left out of `Capabilities` stays as it is).
    fn from(c: Capabilities) -> Self {
        CapabilitiesUpdate {
            tools: Some(c.tools),
            mcp_servers: Some(c.mcp_servers),
            skills: Some(c.skills),
            permissions: c.permissions,
            system_prompt: c.system_prompt,
        }
    }
}

/// How an [`AgentThreads`] runs.
#[derive(Clone)]
pub struct Options {
    /// Where threads are kept: a [`MemoryStore`] by default.
    pub store: Option<Arc<dyn Store>>,
    /// The harnesses threads can run on. Claude Code (`claude`) and Codex (`codex`) by default.
    pub harnesses: Vec<Arc<dyn Harness>>,
    /// How harness processes are started: direct child processes by default, which end with the
    /// backend. With [`shim`](crate::shim()) they outlive it: call
    /// [`recover`](AgentThreads::recover) when the app starts, to re-attach.
    pub spawner: Option<Arc<dyn Spawner>>,
    /// For every thread.
    pub capabilities: Capabilities,
    /// Called with errors that aren't any command's: a store that fails, say. They're printed to
    /// stderr by default.
    pub on_error: Option<Arc<dyn Fn(Error) + Send + Sync>>,
    /// How many events a subscriber may fall behind by before it misses some (and gets
    /// `RecvError::Lagged`, after which it catches up with `events_since`). 4096 by default.
    pub event_capacity: usize,
    /// Questions still open when their turn ends (it was interrupted, say) stay open, rather than
    /// being cancelled: an answer is sent to the agent as the user's next message, unless the
    /// conversation has moved on first (the user sent a message, or one was left queued). Secret
    /// ones are cancelled still, and dont_ask dismisses them.
    pub late_answers: bool,
    /// Fill in `raw` on events, items and requests: the harness message each came from. Off by
    /// default; it's saved with the events, so they take more room.
    pub raw: bool,
    /// Called with every line a thread's harness process writes, once its driver has dealt with it:
    /// for what the protocol leaves out (Claude Code's system messages and rate limit events,
    /// Codex's token usage...). It's called on the thread's task as the output is read, so it
    /// should be quick, and mustn't wait on the backend.
    pub on_harness_message: Option<HarnessMessageHandler>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            store: None,
            harnesses: Vec::new(),
            spawner: None,
            capabilities: Capabilities::default(),
            on_error: None,
            event_capacity: 4096,
            late_answers: false,
            raw: false,
            on_harness_message: None,
        }
    }
}

/// A new thread's options.
#[derive(Clone, Default)]
pub struct CreateOptions {
    /// The harness to run on; the first configured one by default.
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    /// The working directory; the process's by default.
    pub cwd: Option<PathBuf>,
    pub title: Option<String>,
    /// The app's own data about the thread (e.g. the user it's for); tools and the policy get it.
    pub metadata: Map<String, Value>,
    /// Answers that stand from the start (from the app's own rules, say), as answers given with
    /// `always` do.
    pub standing_answers: Vec<StandingAnswer>,
    /// The thread's id; a new one by default.
    pub id: Option<String>,
    /// The thread's own tools, MCP servers, skills, policy and system prompt, on top of the
    /// instance's. They aren't stored: after a restart, set them again with
    /// [`configure`](AgentThreads::configure).
    pub capabilities: Capabilities,
    /// How its harness process is started (args, environment, directories, config directory), on
    /// top of the harness's options. They're stored with the thread, but not sent to clients.
    pub launch: LaunchOptions,
}

/// A message's options.
#[derive(Clone, Debug, Default)]
pub struct SendOptions {
    pub attachments: Vec<Attachment>,
    pub client_id: Option<String>,
}

/// Changes to a thread's options; ones left out stay as they are.
#[derive(Clone, Debug, Default)]
pub struct ThreadOptions {
    /// `Some("")` clears it.
    pub model: Option<String>,
    /// `Some("")` clears it.
    pub effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    /// Replaces the thread's standing answers; `Some(vec![])` clears them.
    pub standing_answers: Option<Vec<StandingAnswer>>,
    /// Replaces how the thread's harness process is started, in full. Only the app sets it: the
    /// `set_options` command doesn't.
    pub launch: Option<LaunchOptions>,
}

/// What [`recover`](AgentThreads::recover) did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Recovered {
    /// Threads whose runs it re-attached to (including runs that ended while the backend was down).
    pub reattached: Vec<String>,
    /// Threads whose runs it couldn't re-attach to, and stopped: their turns ended.
    pub lost: Vec<String>,
}

/// How often the shim spawner's finished runs are pruned.
const PRUNE_EVERY: std::time::Duration = std::time::Duration::from_secs(3600);

/// Runs a function when it's dropped (however the scope it's in ends).
struct Finally<F: FnOnce()>(Option<F>);

impl<F: FnOnce()> Drop for Finally<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// A deletion under way: its outcome once it's done.
type Deletion = tokio::sync::watch::Receiver<Option<Result<bool>>>;

/// Waits for a deletion's outcome.
async fn deleted(mut d: Deletion) -> Result<bool> {
    match d.wait_for(Option::is_some).await {
        Ok(r) => r.clone().unwrap(),
        Err(_) => Err(Error::Other("the deletion stopped before it finished".into())),
    }
}

/// A thread being loaded: the outcome once it is.
type Loading = tokio::sync::watch::Receiver<Option<Result<Handle>>>;

/// Waits for a load's outcome.
async fn loaded(mut l: Loading) -> Result<Handle> {
    match l.wait_for(Option::is_some).await {
        Ok(r) => r.clone().unwrap(),
        Err(_) => Err(Error::Other("the load stopped before it finished".into())),
    }
}

/// The live threads, and those being loaded. Its lock is never held across an await, so a slow
/// load or close doesn't hold up commands for other threads.
#[derive(Default)]
struct Threads {
    live: HashMap<String, Handle>,
    /// Threads being loaded, which are live once they are (a thread is published only once its
    /// load, re-attach or recovery has finished). A load that comes meanwhile waits for the same
    /// one, as do a deletion and close().
    loading: HashMap<String, Loading>,
}

/// A live thread's task.
#[derive(Clone)]
struct Handle {
    tx: tokio::sync::mpsc::UnboundedSender<Job>,
    task: Arc<StdMutex<Option<JoinHandle<()>>>>,
}

impl Handle {
    /// Runs `f` on the thread's task, and returns what it returns.
    async fn call<T: Send + 'static>(&self, f: impl FnOnce(&mut Actor) -> T + Send + 'static) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Box::new(move |a: &mut Actor| {
                let _ = tx.send(f(a));
            }))
            .map_err(|_| Error::Command("the thread is closed".into()))?;
        rx.await.map_err(|_| Error::Command("the thread is closed".into()))
    }

    /// Resolves once every event so far is saved.
    async fn saved(&self) -> Result<()> {
        let rx = self.call(|a| a.core.saved_waiter()).await?;
        rx.await
            .map_err(|_| Error::Command("the thread is closed".into()))?
            .map_err(Error::Store)
    }
}

/// The backend: threads on Claude Code and Codex, their events, and the commands that drive them.
#[derive(Clone)]
pub struct AgentThreads {
    inner: Arc<Inner>,
}

struct Inner {
    store: Arc<dyn Store>,
    harnesses: Vec<Arc<dyn Harness>>,
    spawner: Arc<dyn Spawner>,
    capabilities: Capabilities,
    on_error: Arc<dyn Fn(Error) + Send + Sync>,
    late_answers: bool,
    raw: bool,
    on_harness_message: Option<HarnessMessageHandler>,
    events: broadcast::Sender<ThreadEvent>,
    threads: StdMutex<Threads>,
    configs: StdMutex<HashMap<String, Capabilities>>,
    /// Threads being deleted, which aren't loaded again.
    deleting: StdMutex<HashMap<String, Deletion>>,
    closed: AtomicBool,
    /// The shutdown close() started (waiting for deletions, stopping every thread, settling the
    /// spawner): a task of its own, so it finishes even if close()'s caller stops waiting; true once
    /// it's done.
    shutdown: StdMutex<Option<tokio::sync::watch::Receiver<bool>>>,
    /// One save_all() at a time.
    saving: Mutex<()>,
    pruner: StdMutex<Option<JoinHandle<()>>>,
}

impl Default for AgentThreads {
    fn default() -> Self {
        AgentThreads::new(Options::default())
    }
}

impl AgentThreads {
    pub fn new(options: Options) -> Self {
        let harnesses = if options.harnesses.is_empty() {
            vec![
                crate::claude::claude_code(Default::default()),
                crate::codex::codex(Default::default()),
            ]
        } else {
            options.harnesses
        };
        let on_error = options
            .on_error
            .unwrap_or_else(|| Arc::new(|e| eprintln!("agent-threads: {e}")));
        let (events, _) = broadcast::channel(options.event_capacity.max(16));
        AgentThreads {
            inner: Arc::new(Inner {
                store: options.store.unwrap_or_else(|| Arc::new(MemoryStore::new())),
                harnesses,
                spawner: options.spawner.unwrap_or_else(direct),
                capabilities: options.capabilities,
                late_answers: options.late_answers,
                on_error,
                raw: options.raw,
                on_harness_message: options.on_harness_message,
                events,
                threads: StdMutex::new(Threads::default()),
                configs: StdMutex::new(HashMap::new()),
                deleting: StdMutex::new(Default::default()),
                closed: AtomicBool::new(false),
                shutdown: StdMutex::new(None),
                saving: Mutex::new(()),
                pruner: StdMutex::new(None),
            }),
        }
    }

    pub fn store(&self) -> &Arc<dyn Store> {
        &self.inner.store
    }

    pub fn spawner(&self) -> &Arc<dyn Spawner> {
        &self.inner.spawner
    }

    // ---------- threads ----------

    /// Creates a thread, idle.
    pub async fn create(&self, options: CreateOptions) -> Result<Thread> {
        self.open()?;
        let i = &self.inner;
        let harness = match &options.harness {
            Some(h) => h.clone(),
            None => i.harnesses.first().map(|h| h.name().to_string()).unwrap_or_default(),
        };
        if self.harness(&harness).is_none() {
            return Err(Error::Command(format!("there's no harness {harness:?}")));
        }
        let cwd = match options.cwd {
            Some(c) => c,
            None => {
                std::env::current_dir().map_err(|e| Error::Command(format!("there's no working directory: {e}")))?
            }
        };
        let mut thread = json!({
            "id": options.id.unwrap_or_else(|| new_id("th")),
            "harness": harness,
            "status": "idle",
            "permission_mode": options.permission_mode.unwrap_or(PermissionMode::Default),
            "cwd": cwd.to_string_lossy(),
            "created_at": now_iso(),
        });
        for (k, v) in [
            ("title", &options.title),
            ("model", &options.model),
            ("effort", &options.effort),
        ] {
            if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                thread[k] = json!(v);
            }
        }
        if !options.metadata.is_empty() {
            thread["metadata"] = Value::Object(options.metadata);
        }
        if !options.standing_answers.is_empty() {
            thread["standing_answers"] = json!(options.standing_answers);
        }
        let typed: Thread = serde_json::from_value(thread.clone()).map_err(|e| Error::Command(e.to_string()))?;
        i.configs.lock().unwrap().insert(typed.id.clone(), options.capabilities);
        let mut stored = thread.clone();
        if !options.launch.is_empty() {
            stored["launch"] = serde_json::to_value(&options.launch).map_err(|e| Error::Command(e.to_string()))?;
        }
        i.store.create_thread(&stored).await?;
        let handle = {
            let mut threads = i.threads.lock().unwrap();
            // Checked again under the lock close() collects the threads under, so a close() that
            // started meanwhile either sees this one or refuses it here.
            self.open()?;
            let (handle, mut actor, rx) = self.actor(initial_state(typed.clone()), options.launch)?;
            actor
                .core
                .emit_value(json!({"type": "thread.updated", "thread": thread}));
            self.run(&handle, actor, rx);
            threads.live.insert(typed.id.clone(), handle.clone());
            handle
        };
        handle.saved().await?;
        Ok(typed)
    }

    /// Sets a thread's own tools, MCP servers, skills, policy or system prompt, which aren't
    /// stored: e.g. for a thread created before the app restarted. What `update` leaves out stays as
    /// it is. The policy and the tools' code change at once, even for a running turn; what the
    /// harness is told when its process starts (which tools there are, MCP servers, skills, the
    /// system prompt) changes from its next turn.
    pub async fn configure(&self, thread_id: &str, update: impl Into<CapabilitiesUpdate>) -> Result<()> {
        self.open()?;
        let update = update.into();
        {
            // A thread being deleted keeps no configuration: checked and changed under the lock a
            // deletion is marked under, so one can't start in between.
            let deleting = self.inner.deleting.lock().unwrap();
            if deleting.contains_key(thread_id) {
                return Err(Error::Command(format!("thread {thread_id} is being deleted")));
            }
            let mut configs = self.inner.configs.lock().unwrap();
            let own = configs.entry(thread_id.to_string()).or_default();
            if let Some(t) = update.tools {
                own.tools = t;
            }
            if let Some(m) = update.mcp_servers {
                own.mcp_servers = m;
            }
            if let Some(s) = update.skills {
                own.skills = s;
            }
            if let Some(p) = update.permissions {
                own.permissions = Some(p);
            }
            if let Some(p) = update.system_prompt {
                own.system_prompt = Some(p).filter(|p| !p.is_empty());
            }
        }
        // A thread being loaded is waited for, and then changed as a live one is: this doesn't
        // return before the change is in effect. (What its load did before then had the change if
        // it came before the load re-attached the thread's run: see reattach().) One that isn't
        // loaded, or whose load fails, gets it when it's next loaded.
        let (live, loading) = {
            let threads = self.inner.threads.lock().unwrap();
            (
                threads.live.get(thread_id).cloned(),
                threads.loading.get(thread_id).cloned(),
            )
        };
        let handle = match (live, loading) {
            (Some(h), _) => Some(h),
            (None, Some(l)) => loaded(l).await.ok(),
            (None, None) => None,
        };
        if let Some(h) = handle {
            let (config, policy) = (self.config(thread_id), self.policy(thread_id));
            h.call(move |a| {
                a.core.config = config;
                a.core.policy = policy;
                a.core.options_changed();
                // A run that outlives the backend is saved knowing it, without an event to save it
                // with.
                a.core.request_save();
            })
            .await?;
        }
        Ok(())
    }

    /// The thread, or none.
    pub async fn get(&self, thread_id: &str) -> Result<Option<Thread>> {
        let handle = self.live(thread_id);
        if let Some(h) = handle
            && let Ok(t) = h.call(|a| a.core.thread().clone()).await
        {
            return Ok(Some(t));
        }
        Ok(self
            .inner
            .store
            .get_thread(thread_id)
            .await?
            .and_then(|t| serde_json::from_value(t).ok()))
    }

    /// Every thread, oldest first.
    pub async fn list(&self) -> Result<Vec<Thread>> {
        let stored = self.inner.store.list_threads().await?;
        let live = self.inner.threads.lock().unwrap().live.clone();
        let mut out = Vec::new();
        for t in stored {
            let Ok(t) = serde_json::from_value::<Thread>(t) else {
                continue;
            };
            match live.get(&t.id) {
                Some(h) => out.push(h.call(|a| a.core.thread().clone()).await.unwrap_or(t)),
                None => out.push(t),
            }
        }
        Ok(out)
    }

    /// Deletes a thread, stopping its harness first. Whether there was one.
    pub async fn delete(&self, thread_id: &str) -> Result<bool> {
        self.open()?;
        // Marked as being deleted under the lock loads take, so nothing loads it again meanwhile:
        // commands for it are refused until it's gone. A load already under way is waited for (it
        // sees the mark, and stops the thread it loaded). The deletion runs as a task of its own,
        // so it finishes (and the mark goes) even if the caller stops waiting for it; a delete that
        // comes meanwhile waits for the same one, as close() does.
        let deletion = {
            let mut threads = self.inner.threads.lock().unwrap();
            let mut deleting = self.inner.deleting.lock().unwrap();
            if let Some(d) = deleting.get(thread_id) {
                d.clone()
            } else {
                // Checked again under the lock close() collects deletions under, so a close() that
                // started meanwhile either sees this one or refuses it here.
                self.open()?;
                let (tx, rx) = tokio::sync::watch::channel(None);
                deleting.insert(thread_id.to_string(), rx.clone());
                let handle = threads.live.remove(thread_id);
                let loading = threads.loading.get(thread_id).cloned();
                let (me, id) = (self.clone(), thread_id.to_string());
                tokio::spawn(async move {
                    // However it ends (a panic in delete_now included), the mark goes and those
                    // waiting are told.
                    let result: Arc<StdMutex<Option<Result<bool>>>> = Arc::default();
                    let _done = {
                        let (me, id, result) = (me.clone(), id.clone(), result.clone());
                        Finally(Some(move || {
                            me.inner.deleting.lock().unwrap().remove(&id);
                            let r = result.lock().unwrap().take();
                            tx.send_replace(Some(
                                r.unwrap_or_else(|| Err(Error::Other(format!("deleting thread {id} failed")))),
                            ));
                        }))
                    };
                    if let Some(l) = loading {
                        let _ = loaded(l).await;
                    }
                    let r = me.delete_now(&id, handle).await;
                    *result.lock().unwrap() = Some(r);
                });
                rx
            }
        };
        deleted(deletion).await
    }

    /// Stops a thread being deleted (its handle, if it was live) and deletes it from the store.
    async fn delete_now(&self, thread_id: &str, handle: Option<Handle>) -> Result<bool> {
        if let Some(h) = handle {
            discard(h).await;
        }
        self.inner.configs.lock().unwrap().remove(thread_id);
        Ok(self.inner.store.delete_thread(thread_id).await?)
    }

    /// The thread's state now, including text streamed so far.
    pub async fn snapshot(&self, thread_id: &str) -> Result<Snapshot> {
        self.ready(thread_id).await?.call(|a| a.core.snapshot().clone()).await
    }

    /// A window of the thread's state now: its last `limit` items, and what they need from before
    /// them (spec/PROTOCOL.md, "Windows"); the whole state if it has no more than `limit`.
    pub async fn snapshot_window(&self, thread_id: &str, limit: usize) -> Result<Snapshot> {
        self.ready(thread_id)
            .await?
            .call(move |a| snapshot_window(a.core.snapshot(), limit))
            .await
    }

    /// The thread's items before index `before` (a window's `start`), at most `limit` of them, as
    /// they are now, for a client loading earlier ones into its window.
    pub async fn items_before(&self, thread_id: &str, before: u64, limit: usize) -> Result<ItemPage> {
        self.ready(thread_id)
            .await?
            .call(move |a| item_page(a.core.snapshot(), before, limit))
            .await
    }

    /// The thread's saved events after `seq` (at most `limit`), for a client catching up.
    pub async fn events_since(&self, thread_id: &str, seq: u64, limit: Option<usize>) -> Result<Vec<ThreadEvent>> {
        let handle = self.live(thread_id);
        match handle {
            Some(h) => h.saved().await?,
            None => {
                if self.inner.store.get_thread(thread_id).await?.is_none() {
                    return Err(Error::Command(format!("there's no thread {thread_id}")));
                }
            }
        }
        let events = self.inner.store.read_events(thread_id, seq, limit).await?;
        // A newer backend's event types are left out (their seqs are still gone past).
        Ok(events
            .into_iter()
            .filter_map(|e| serde_json::from_value(e).ok())
            .collect())
    }

    /// Every thread's events, deltas included, from now on. A subscriber that falls more than
    /// `Options::event_capacity` events behind misses some (it gets `RecvError::Lagged`), and
    /// catches up with [`events_since`](Self::events_since) or a [`snapshot`](Self::snapshot).
    pub fn subscribe(&self) -> broadcast::Receiver<ThreadEvent> {
        self.inner.events.subscribe()
    }

    /// Picks up the runs that were going when the backend last stopped (with the shim spawner,
    /// whose runs outlive it): it re-attaches to those still running, and follows those that ended
    /// while it was down to their end, so their threads carry on. Runs it can't re-attach to are
    /// stopped, and their turns end. Call it when the app starts, before taking commands; a thread
    /// a command loads first is re-attached then. It also prunes old runs' directories, now and
    /// every hour after.
    pub async fn recover(&self) -> Result<Recovered> {
        self.open()?;
        let mut out = Recovered::default();
        for run in self.inner.store.active_runs().await? {
            let handle = match self.load(&run.thread_id).await {
                Ok(h) => h,
                Err(e) => {
                    (self.inner.on_error)(e);
                    continue;
                }
            };
            let run_id = run.id.clone();
            let (current, reattached, lost) = handle
                .call(move |a| {
                    // As of loading it: the run may have ended since.
                    let reattached = a.core.reattached_run.as_deref() == Some(run_id.as_str());
                    let current = reattached || a.core.thread().run.as_ref().is_some_and(|r| r.id == run_id);
                    (current, reattached, a.core.lost_run.as_deref() == Some(run_id.as_str()))
                })
                .await?;
            if current {
                if reattached {
                    out.reattached.push(run.thread_id.clone());
                }
                continue;
            }
            if lost {
                out.lost.push(run.thread_id.clone());
            }
            // Not the thread's run (any more): nothing follows it.
            if let Some(now) = self.inner.store.get_run(&run.id).await?
                && now.ended_at.is_none()
            {
                self.abandon(now).await;
            }
        }
        self.prune();
        Ok(out)
    }

    fn prune(&self) {
        let i = &self.inner;
        if !i.spawner.prunes() {
            return;
        }
        let mut pruner = i.pruner.lock().unwrap();
        if pruner.is_some() {
            return;
        }
        let me = Arc::downgrade(&self.inner);
        *pruner = Some(tokio::spawn(async move {
            loop {
                let Some(i) = me.upgrade() else { return };
                if let Err(e) = i.spawner.prune(&*i.store).await {
                    (i.on_error)(Error::Store(e));
                }
                drop(i);
                tokio::time::sleep(PRUNE_EVERY).await;
            }
        }));
    }

    /// Stops a run nothing follows, and records that the backend is done with it.
    async fn abandon(&self, run: RunRecord) {
        abandon(&self.inner.spawner, &self.inner.store, &self.inner.on_error, run).await;
    }

    /// Sends the thread's running harness process a request of the app's own, and returns its
    /// answer: for Claude Code a control request's `request` (e.g. `{"subtype":
    /// "get_context_usage"}`), answered with the control response's `response`; for Codex
    /// `{"method", "params"?}`, answered with the JSON-RPC result. It's an `Error::Command` if the
    /// thread has no running process or its harness takes no requests, and an `Error::Control` if
    /// the harness refuses it, or its process exits (or the backend closes) before it answers. It
    /// mustn't be used for what the driver does itself (starting turns, answering the harness's
    /// requests...).
    pub async fn control(&self, thread_id: &str, request: Value) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        let reply: ControlReply = Box::new(move |r| {
            let _ = tx.send(r);
        });
        self.ready(thread_id)
            .await?
            .call(move |a| a.session.control(&mut a.core, request, reply))
            .await?;
        rx.await.unwrap_or_else(|_| {
            Err(Error::Control {
                message: "the harness didn't answer before the thread was closed".into(),
                error: None,
            })
        })
    }

    // ---------- commands ----------

    /// Carries out a command from a client. A command it can't carry out (an unknown thread, a
    /// closed AgentThreads) is an `Error::Command`.
    pub async fn handle(&self, command: Command) -> Result<()> {
        match command {
            Command::Send(c) => {
                self.send(
                    &c.thread_id,
                    &c.text,
                    SendOptions {
                        attachments: c.attachments,
                        client_id: c.client_id,
                    },
                )
                .await
            }
            Command::Interrupt(c) => self.interrupt(&c.thread_id).await,
            Command::Respond(c) => self.respond(&c.thread_id, &c.request_id, c.resolution).await,
            Command::SetOptions(c) => {
                let o = ThreadOptions {
                    model: c.model,
                    effort: c.effort,
                    permission_mode: c.permission_mode,
                    standing_answers: c.standing_answers,
                    launch: None,
                };
                self.set_options(&c.thread_id, o).await
            }
        }
    }

    /// Carries out a command given as JSON, checked against the protocol first: one that isn't a
    /// valid command is an `Error::Command`, and changes nothing.
    pub async fn handle_json(&self, command: Value) -> Result<()> {
        let command: Command =
            serde_json::from_value(command).map_err(|e| Error::Command(format!("that isn't a valid command: {e}")))?;
        self.handle(command).await
    }

    /// Sends the agent a message: starts a turn, or steers the running one.
    pub async fn send(&self, thread_id: &str, text: &str, options: SendOptions) -> Result<()> {
        // Checked as the protocol's schema has it (contentEncoding: base64) before anything is
        // touched.
        if let Some(i) = options
            .attachments
            .iter()
            .position(|a| a.data.as_deref().is_some_and(|d| !is_base64(d)))
        {
            return Err(Error::Command(format!(
                "that isn't a valid command: attachments[{i}].data should be base64"
            )));
        }
        let message = Outgoing {
            text: text.to_string(),
            attachments: options.attachments,
            client_id: options.client_id,
        };
        self.ready(thread_id).await?.call(move |a| a.core.send(message)).await
    }

    /// Stops the running turn, if there is one.
    pub async fn interrupt(&self, thread_id: &str) -> Result<()> {
        self.ready(thread_id).await?.call(|a| a.core.interrupt()).await
    }

    /// Answers an open request; does nothing if it isn't open.
    pub async fn respond(&self, thread_id: &str, request_id: &str, resolution: Resolution) -> Result<()> {
        let request_id = request_id.to_string();
        self.ready(thread_id)
            .await?
            .call(move |a| a.respond(&request_id, resolution))
            .await
    }

    /// Changes the thread's model, effort, permission mode or launch options, from its next turn, or
    /// its standing answers. Open permission requests the new mode or standing answers answer
    /// (bypass allows them, dont_ask denies them) are answered at once.
    pub async fn set_options(&self, thread_id: &str, options: ThreadOptions) -> Result<()> {
        self.ready(thread_id)
            .await?
            .call(move |a| {
                let options_of = |t: &Thread| (t.model.clone(), t.effort.clone(), t.permission_mode);
                let before = options_of(a.core.thread());
                a.core.set_thread(|t| {
                    if let Some(s) = options.standing_answers {
                        t.standing_answers = s;
                    }
                    if let Some(m) = options.model {
                        t.model = Some(m).filter(|m| !m.is_empty());
                    }
                    if let Some(e) = options.effort {
                        t.effort = Some(e).filter(|e| !e.is_empty());
                    }
                    if let Some(p) = options.permission_mode {
                        t.permission_mode = Some(p);
                    }
                });
                if options_of(a.core.thread()) != before {
                    a.core.options_changed();
                }
                if let Some(l) = options.launch {
                    a.core.set_launch(l);
                }
                a.settle();
            })
            .await
    }

    /// Stops every harness process and saves everything. With the shim spawner, runs are left
    /// going instead (their turns too), for [`recover`](Self::recover) to re-attach to when the
    /// app starts again, unless `stop` is set; a driver that can't re-attach has its runs stopped.
    /// It fails if some thread's events can't be saved (the store is failing): they're kept, and
    /// calling close again tries again. After it, commands, snapshots and changes to threads are
    /// refused with an `Error::Command`; get, list and events_since still read the store, which
    /// is the app's to close.
    pub async fn close(&self, stop: bool) -> Result<()> {
        let i = &self.inner;
        let mut shutdown = {
            let mut shutdown = i.shutdown.lock().unwrap();
            shutdown
                .get_or_insert_with(|| {
                    i.closed.store(true, Ordering::SeqCst);
                    if let Some(p) = i.pruner.lock().unwrap().take() {
                        p.abort();
                    }
                    let (tx, rx) = tokio::sync::watch::channel(false);
                    let me = self.clone();
                    tokio::spawn(async move {
                        // Done however it ends (a panic in a harness's close included), so close()
                        // goes on to save what there is.
                        let _done = Finally(Some(move || {
                            tx.send_replace(true);
                        }));
                        me.shut_down(stop).await;
                    });
                    rx
                })
                .clone()
        };
        let _ = shutdown.wait_for(|done| *done).await;
        self.save_all().await
    }

    /// Waits for the deletions and loads under way, then stops every thread's harness, and settles
    /// the spawner.
    async fn shut_down(&self, stop: bool) {
        let i = &self.inner;
        // A delete(), load() or create() that started before `closed` was set has marked, started
        // or published its thread by the time the threads lock is free (each rechecks `closed`
        // under it), so none is missed: a load is published when it's done, for stop_all to stop.
        let (deletions, loads): (Vec<Deletion>, Vec<Loading>) = {
            let threads = i.threads.lock().unwrap();
            let deletions = i.deleting.lock().unwrap().values().cloned().collect();
            (deletions, threads.loading.values().cloned().collect())
        };
        for l in loads {
            let _ = loaded(l).await;
        }
        for d in deletions {
            let _ = deleted(d).await;
        }
        self.stop_all(stop).await;
        i.spawner.settle().await;
    }

    /// Stops every thread's harness.
    async fn stop_all(&self, stop: bool) {
        let handles: Vec<Handle> = self.inner.threads.lock().unwrap().live.values().cloned().collect();
        let durable = self.inner.spawner.durable();
        let mut tasks = Vec::new();
        for h in handles {
            tasks.push(tokio::spawn(async move {
                let closing = h
                    .call(move |a| {
                        // Left going, saved as it is now, to be re-attached to.
                        if !stop && durable && a.session.detach(&mut a.core) {
                            a.core.request_save();
                            return None;
                        }
                        // A turn cut short by shutting down ends as an interrupted one.
                        a.core.closing = true;
                        if let Some(t) = &mut a.core.turn {
                            t.interrupted = true;
                        }
                        Some(a.session.close(&mut a.core))
                    })
                    .await;
                if let Ok(Some(close)) = closing {
                    close.await;
                    let _ = h
                        .call(|a| {
                            if a.core.turn.is_some() {
                                a.core.finish_turn(TurnEnd::default(), false, false);
                            }
                        })
                        .await;
                }
            }));
        }
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Saves every thread's events and a snapshot, then lets the thread go.
    async fn save_all(&self) -> Result<()> {
        let _one = self.inner.saving.lock().await;
        let handles: Vec<(String, Handle)> = self
            .inner
            .threads
            .lock()
            .unwrap()
            .live
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut failed = Vec::new();
        for (id, h) in handles {
            match h.saved().await {
                Ok(()) => {}
                // Its task has ended: a close() that saved and disposed of it was cut short before
                // it let go of the handle.
                Err(Error::Command(_)) if h.tx.is_closed() => {
                    self.inner.threads.lock().unwrap().live.remove(&id);
                    continue;
                }
                Err(e) => {
                    failed.push(e.to_string());
                    continue;
                }
            }
            let _ = h
                .call(|a| {
                    a.core.save_snapshot_next();
                    a.core.dispose();
                })
                .await;
            let task = h.task.lock().unwrap().take();
            if let Some(task) = task {
                let _ = task.await;
            }
            self.inner.threads.lock().unwrap().live.remove(&id);
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(Error::Other(format!(
                "{} thread(s) have events the store hasn't saved; close again to retry: {}",
                failed.len(),
                failed.join("; ")
            )))
        }
    }

    // ---------- internals ----------

    fn open(&self) -> Result<()> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(Error::Command("this AgentThreads is closed".into()));
        }
        Ok(())
    }

    /// The live thread a command is for, once the instance is known to be open.
    async fn ready(&self, thread_id: &str) -> Result<Handle> {
        self.open()?;
        let h = self.load(thread_id).await?;
        self.open()?;
        Ok(h)
    }

    fn harness(&self, name: &str) -> Option<Arc<dyn Harness>> {
        self.inner.harnesses.iter().find(|h| h.name() == name).cloned()
    }

    fn config(&self, thread_id: &str) -> ThreadConfig {
        let all = &self.inner.capabilities;
        let configs = self.inner.configs.lock().unwrap();
        let own = configs.get(thread_id).cloned().unwrap_or_default();
        let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
        for t in all.tools.iter().chain(own.tools.iter()) {
            match tools.iter().position(|x| x.name() == t.name()) {
                Some(at) => tools[at] = t.clone(),
                None => tools.push(t.clone()),
            }
        }
        let mut mcp_servers = all.mcp_servers.clone();
        mcp_servers.extend(own.mcp_servers.clone());
        let prompts: Vec<&str> = [&all.system_prompt, &own.system_prompt]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .collect();
        ThreadConfig {
            tools,
            mcp_servers,
            skills: all.skills.iter().chain(own.skills.iter()).cloned().collect(),
            system_prompt: (!prompts.is_empty()).then(|| prompts.join("\n\n")),
        }
    }

    fn policy(&self, thread_id: &str) -> PermissionPolicy {
        let own = self
            .inner
            .configs
            .lock()
            .unwrap()
            .get(thread_id)
            .and_then(|c| c.permissions.clone());
        own.or_else(|| self.inner.capabilities.permissions.clone())
            .unwrap_or_default()
    }

    fn host(&self) -> Arc<Host> {
        let i = &self.inner;
        Arc::new(Host {
            store: i.store.clone(),
            spawner: i.spawner.clone(),
            events: i.events.clone(),
            on_error: i.on_error.clone(),
            late_answers: i.late_answers,
            raw: i.raw,
            on_harness_message: i.on_harness_message.clone(),
        })
    }

    /// A thread's actor, not yet running.
    fn actor(
        &self,
        state: Snapshot,
        launch: LaunchOptions,
    ) -> Result<(Handle, Actor, tokio::sync::mpsc::UnboundedReceiver<Job>)> {
        let id = state.thread.id.clone();
        let harness = self.harness(&state.thread.harness).ok_or_else(|| {
            Error::Command(format!(
                "thread {id} runs on {}, which isn't configured",
                state.thread.harness
            ))
        })?;
        let (tx, actor, rx) = Actor::start(self.host(), state, self.config(&id), launch, self.policy(&id), |ctx| {
            harness.open(ctx)
        });
        Ok((
            Handle {
                tx,
                task: Arc::new(StdMutex::new(None)),
            },
            actor,
            rx,
        ))
    }

    fn run(&self, handle: &Handle, actor: Actor, rx: tokio::sync::mpsc::UnboundedReceiver<Job>) {
        // A first job, so whatever loading it made is saved straight away.
        let _ = handle.tx.send(Box::new(|_| {}));
        *handle.task.lock().unwrap() = Some(tokio::spawn(actor.run(rx)));
    }

    /// The live thread, if it is.
    fn live(&self, thread_id: &str) -> Option<Handle> {
        self.inner.threads.lock().unwrap().live.get(thread_id).cloned()
    }

    /// The live thread, loaded from the store if it isn't yet. Only the thread's own load is waited
    /// for: other threads' commands go on meanwhile.
    async fn load(&self, thread_id: &str) -> Result<Handle> {
        let loading = {
            let mut threads = self.inner.threads.lock().unwrap();
            if let Some(h) = threads.live.get(thread_id) {
                return Ok(h.clone());
            }
            // Refused at once, rather than after a load under way, which comes to nothing.
            if self.inner.deleting.lock().unwrap().contains_key(thread_id) {
                return Err(Error::Command(format!("thread {thread_id} is being deleted")));
            }
            match threads.loading.get(thread_id) {
                Some(l) => l.clone(),
                None => {
                    // Checked again under the lock close() collects loads under, so a close() that
                    // started meanwhile either waits for this one or refuses it here.
                    self.open()?;
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    threads.loading.insert(thread_id.to_string(), rx.clone());
                    // A task of its own, so the load finishes (and is published or let go) even if
                    // the caller stops waiting for it.
                    let (me, id) = (self.clone(), thread_id.to_string());
                    tokio::spawn(async move { me.load_task(&id, tx).await });
                    rx
                }
            }
        };
        loaded(loading).await
    }

    /// Loads a thread, then publishes it, or stops it if it's being deleted meanwhile.
    async fn load_task(&self, thread_id: &str, tx: tokio::sync::watch::Sender<Option<Result<Handle>>>) {
        // However it ends (a panic included), the load is let go of and those waiting are told.
        let result: Arc<StdMutex<Option<Result<Handle>>>> = Arc::default();
        let _done = {
            let (me, id, result, ours) = (self.clone(), thread_id.to_string(), result.clone(), tx.subscribe());
            Finally(Some(move || {
                {
                    // Unless it's been published, and another load started since.
                    let mut threads = me.inner.threads.lock().unwrap();
                    if threads.loading.get(&id).is_some_and(|l| l.same_channel(&ours)) {
                        threads.loading.remove(&id);
                    }
                }
                let r = result.lock().unwrap().take();
                tx.send_replace(Some(
                    r.unwrap_or_else(|| Err(Error::Other(format!("loading thread {id} failed")))),
                ));
            }))
        };
        let r = match self.load_from_store(thread_id).await {
            Ok(h) => {
                let published = {
                    let mut threads = self.inner.threads.lock().unwrap();
                    let deleting = self.inner.deleting.lock().unwrap().contains_key(thread_id);
                    if !deleting {
                        threads.live.insert(thread_id.to_string(), h.clone());
                        threads.loading.remove(thread_id);
                    }
                    !deleting
                };
                if published {
                    Ok(h)
                } else {
                    // The deletion waits for this before it deletes the thread from the store.
                    discard(h).await;
                    Err(Error::Command(format!("thread {thread_id} is being deleted")))
                }
            }
            Err(e) => Err(e),
        };
        *result.lock().unwrap() = Some(r);
    }

    async fn load_from_store(&self, thread_id: &str) -> Result<Handle> {
        let store = &self.inner.store;
        let Some(thread) = store.get_thread(thread_id).await? else {
            return Err(Error::Command(format!("there's no thread {thread_id}")));
        };
        let launch = LaunchOptions::from_stored(&thread);
        let thread: Thread = serde_json::from_value(thread)
            .map_err(|e| Error::Command(format!("thread {thread_id} can't be read: {e}")))?;
        let snap: Option<Snapshot> = store
            .load_snapshot(thread_id)
            .await?
            .and_then(|s| serde_json::from_value(s).ok());
        let mut state = snap.unwrap_or_else(|| initial_state(thread.clone()));
        for e in store.read_events(thread_id, state.seq, None).await? {
            match serde_json::from_value::<ThreadEvent>(e.clone()) {
                Ok(e) => apply_event(&mut state, &e),
                // A newer backend's event: counted, and nothing else.
                Err(_) => state.seq = e["seq"].as_u64().unwrap_or(state.seq).max(state.seq),
            }
        }
        if state.seq == 0 {
            state = initial_state(thread);
        }
        let (handle, mut actor, rx) = self.actor(state, launch)?;
        // Questions kept open after their turns ended are taken up again (or cancelled, if they
        // can't be any more).
        actor.core.take_up_requests(false);
        if !self.reattach(&mut actor).await? {
            // The process that ran its turn went with the backend before this one, or can't be
            // followed.
            let t = actor.core.thread();
            if matches!(t.status, ThreadStatus::Running | ThreadStatus::Waiting) || t.run.is_some() {
                actor.core.lost_run = t.run.as_ref().map(|r| r.id.clone());
                recover_lost(&mut actor.core);
            }
        }
        self.run(&handle, actor, rx);
        Ok(handle)
    }

    /// Re-attaches a thread just loaded to its run, if it has one that outlived the backend
    /// before: its turn and open requests are as they were when the run was last saved, and the
    /// session carries on reading the run from there. Whether it did; if it couldn't, the run is
    /// stopped.
    async fn reattach(&self, actor: &mut Actor) -> Result<bool> {
        let Some(run) = actor.core.thread().run.clone() else {
            return Ok(false);
        };
        if run.spawner.to_string() == "direct" {
            return Ok(false);
        }
        let record = match self.inner.store.get_run(&run.id).await {
            Ok(Some(r)) if r.ended_at.is_none() => r,
            Ok(_) => return Ok(false),
            // Whether it has a run to carry on with can't be told: nothing is made of the
            // thread (no turn ended as lost), and the error is the caller's.
            Err(e) => return Err(Error::Store(e)),
        };
        // A run saved with no turn running (null) had none: it may be waiting only on a background
        // subagent's request. A run saved before runs had their turn has the last one.
        let saved_turn: Option<Option<Turn>> = record
            .data
            .as_ref()
            .and_then(|d| d.get("turn"))
            .map(|t| serde_json::from_value(t.clone()).ok());
        if matches!(
            actor.core.thread().status,
            ThreadStatus::Running | ThreadStatus::Waiting
        ) {
            let last = last_turn(actor.core.snapshot());
            actor.core.turn = saved_turn.unwrap_or_else(|| {
                Some(Turn {
                    id: last.unwrap_or_else(|| new_id("turn")),
                    interrupted: false,
                    carried: 0,
                    progressed: false,
                })
            });
        }
        actor.core.adopt_run(record.clone());
        // The configuration and policy as they are now, not as they were when the actor was made
        // (before looking the run up): re-attaching may answer the run's open requests at once. A
        // configure() that comes after this waits for the load, and then changes the thread.
        let id = actor.core.thread().id.clone();
        actor.core.config = self.config(&id);
        actor.core.policy = self.policy(&id);
        let spawner = &self.inner.spawner;
        let ok = spawner.can_attach() && record.spawner == spawner.name() && {
            let (s, c) = (&mut actor.session, &mut actor.core);
            s.reattach(c, &record)
        };
        if !ok {
            actor.core.turn = None;
            self.abandon(record).await;
            return Ok(false);
        }
        let c = &mut actor.core;
        // Requests the session didn't take up again can't be answered.
        let open = c.open_request_ids();
        let stale: Vec<String> = open_requests(c.snapshot())
            .map(|r| r.id().to_string())
            .filter(|id| !c.is_taken_up(id))
            .collect();
        for id in stale {
            c.emit_resolved(&id, &cancel_resolution());
        }
        // With none left (one answered before the restart is closed, say), the turn runs on, or
        // the thread is idle if none was running.
        if open.is_empty() && c.thread().status == ThreadStatus::Waiting {
            let status = if c.turn.is_some() {
                ThreadStatus::Running
            } else {
                ThreadStatus::Idle
            };
            c.set_thread(|t| t.status = status);
        }
        c.set_thread(|t| {
            if let Some(r) = &mut t.run {
                r.reattached_at = Some(now_iso());
            }
        });
        c.reattached_run = Some(run.id.clone());
        if c.turn.is_some() {
            c.add_item(json!({
                "id": new_id("n"), "type": "notice", "level": "info", "code": "run.reattached",
                "text": "The backend restarted while this turn was running, and picked it up again.",
            }));
        }
        Ok(true)
    }
}

/// Stops a thread's harness and lets the thread go, once whatever it has is saved.
async fn discard(h: Handle) {
    if let Ok(close) = h.call(|a| a.session.close(&mut a.core)).await {
        close.await;
    }
    let _ = h.call(|a| a.core.dispose()).await;
    let task = h.task.lock().unwrap().take();
    if let Some(task) = task {
        let _ = task.await;
    }
}

async fn abandon(
    spawner: &Arc<dyn Spawner>,
    store: &Arc<dyn Store>,
    on_error: &Arc<dyn Fn(Error) + Send + Sync>,
    run: RunRecord,
) {
    spawner.stop_run(&run);
    if let Err(e) = store
        .put_run(&RunRecord {
            ended_at: Some(now_iso()),
            ..run
        })
        .await
    {
        on_error(Error::Store(e));
    }
}

/// Whether a string is base64 (the standard alphabet, padded), as the protocol's validator has it.
fn is_base64(s: &str) -> bool {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return false;
    }
    let pad = b.iter().rev().take_while(|&&c| c == b'=').count();
    pad <= 2
        && b[..b.len() - pad]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
}

fn cancel_resolution() -> Resolution {
    serde_json::from_value(json!({"outcome": "cancel"})).unwrap()
}

/// The last turn the thread's items were made in.
fn last_turn(s: &Snapshot) -> Option<String> {
    s.items.iter().rev().find_map(Item::turn_id).map(String::from)
}

/// The turn a thread's items say is still running: its last, if it has no turn_result. (A thread
/// waiting with none running is waiting on a background subagent's request.)
fn open_turn(s: &Snapshot) -> Option<String> {
    let last = last_turn(s)?;
    let ended = s
        .items
        .iter()
        .any(|i| matches!(i, Item::TurnResult(r) if r.turn_id.as_deref() == Some(last.as_str())));
    (!ended).then_some(last)
}

/// Ends a turn whose process was lost when the backend stopped, and stops the subagents that went
/// with it (a background one may be running with no turn).
fn recover_lost(c: &mut ThreadContext) {
    let status = c.thread().status;
    let open = open_turn(c.snapshot());
    let turn = status == ThreadStatus::Running || (status == ThreadStatus::Waiting && open.is_some());
    if turn {
        c.turn = Some(Turn {
            id: open.unwrap_or_else(|| new_id("turn")),
            interrupted: false,
            carried: 0,
            progressed: false,
        });
    }
    let running: Vec<String> = c
        .snapshot()
        .items
        .iter()
        .filter_map(|i| match i {
            Item::ToolCall(t) if t.subagent.as_ref().is_some_and(|s| s.status == SubagentStatus::Running) => {
                Some(t.id.clone())
            }
            _ => None,
        })
        .collect();
    c.stop_subagents(&running);
    // Its open requests can't be answered now (but for questions that can be answered late).
    c.take_up_requests(true);
    if turn {
        c.add_item(json!({
            "id": new_id("n"), "type": "notice", "level": "warning", "code": "run.lost",
            "text": "The backend stopped while this turn was running, and couldn't pick its run up again.",
        }));
        // Not carried over: loading a thread starts no process. Its queued messages go with the next.
        let end = TurnEnd {
            ok: false,
            error: Some("The backend stopped while this turn was running.".into()),
            ..Default::default()
        };
        c.finish_turn(end, false, false);
    } else if c.thread().status == ThreadStatus::Waiting {
        c.set_thread(|t| t.status = ThreadStatus::Idle);
    }
    c.set_thread(|t| t.run = None);
}

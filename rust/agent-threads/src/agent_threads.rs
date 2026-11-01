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

use crate::harness::{Harness, McpServer, Skill, ThreadConfig, TurnEnd};
use crate::ids::{new_id, now_iso};
use crate::permissions::PermissionPolicy;
use crate::protocol::{
    Attachment, Command, Item, PermissionMode, Resolution, Snapshot, Thread, ThreadEvent, ThreadStatus,
};
use crate::reducer::{apply_event, initial_state};
use crate::spawner::{Spawner, direct};
use crate::store::{RunRecord, Store, StoreError};
use crate::stores::memory::MemoryStore;
use crate::thread::{Actor, Host, Job, Outgoing, ThreadContext, Turn};
use crate::tools::Tool;

/// What goes wrong.
#[derive(Clone, Debug)]
pub enum Error {
    /// A command that can't be carried out: an unknown thread, a malformed command, or an
    /// AgentThreads that's closed.
    Command(String),
    /// The store failed.
    Store(StoreError),
    /// Something else: a harness that misbehaved, say (for `on_error`).
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Command(m) | Error::Other(m) => f.write_str(m),
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
    /// The thread's id; a new one by default.
    pub id: Option<String>,
    /// The thread's own tools, MCP servers, skills, policy and system prompt, on top of the
    /// instance's. They aren't stored: after a restart, set them again with
    /// [`configure`](AgentThreads::configure).
    pub capabilities: Capabilities,
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
        rx.await.map_err(|_| Error::Command("the thread is closed".into()))?.map_err(Error::Store)
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
    events: broadcast::Sender<ThreadEvent>,
    threads: Mutex<HashMap<String, Handle>>,
    configs: StdMutex<HashMap<String, Capabilities>>,
    closed: AtomicBool,
    stopped: Mutex<bool>,
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
            vec![crate::claude::claude_code(Default::default()), crate::codex::codex(Default::default())]
        } else {
            options.harnesses
        };
        let on_error = options.on_error.unwrap_or_else(|| Arc::new(|e| eprintln!("agent-threads: {e}")));
        let (events, _) = broadcast::channel(options.event_capacity.max(16));
        AgentThreads {
            inner: Arc::new(Inner {
                store: options.store.unwrap_or_else(|| Arc::new(MemoryStore::new())),
                harnesses,
                spawner: options.spawner.unwrap_or_else(direct),
                capabilities: options.capabilities,
                on_error,
                events,
                threads: Mutex::new(HashMap::new()),
                configs: StdMutex::new(HashMap::new()),
                closed: AtomicBool::new(false),
                stopped: Mutex::new(false),
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
            None => std::env::current_dir().map_err(|e| Error::Command(format!("there's no working directory: {e}")))?,
        };
        let mut thread = json!({
            "id": options.id.unwrap_or_else(|| new_id("th")),
            "harness": harness,
            "status": "idle",
            "permission_mode": options.permission_mode.unwrap_or(PermissionMode::Default),
            "cwd": cwd.to_string_lossy(),
            "created_at": now_iso(),
        });
        for (k, v) in [("title", &options.title), ("model", &options.model), ("effort", &options.effort)] {
            if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                thread[k] = json!(v);
            }
        }
        if !options.metadata.is_empty() {
            thread["metadata"] = Value::Object(options.metadata);
        }
        let typed: Thread = serde_json::from_value(thread.clone()).map_err(|e| Error::Command(e.to_string()))?;
        i.configs.lock().unwrap().insert(typed.id.clone(), options.capabilities);
        i.store.create_thread(&thread).await?;
        let mut threads = i.threads.lock().await;
        let (handle, mut actor, rx) = self.actor(initial_state(typed.clone()))?;
        actor.core.emit_value(json!({"type": "thread.updated", "thread": thread}));
        self.run(&handle, actor, rx);
        threads.insert(typed.id.clone(), handle.clone());
        drop(threads);
        handle.saved().await?;
        Ok(typed)
    }

    /// Sets a thread's own tools, MCP servers, skills, policy or system prompt, which aren't
    /// stored: e.g. for a thread created before the app restarted. They apply from its next turn.
    pub async fn configure(&self, thread_id: &str, capabilities: Capabilities) -> Result<()> {
        self.open()?;
        self.inner.configs.lock().unwrap().insert(thread_id.to_string(), capabilities);
        let handle = self.inner.threads.lock().await.get(thread_id).cloned();
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
        let handle = self.inner.threads.lock().await.get(thread_id).cloned();
        if let Some(h) = handle
            && let Ok(t) = h.call(|a| a.core.thread().clone()).await
        {
            return Ok(Some(t));
        }
        Ok(self.inner.store.get_thread(thread_id).await?.and_then(|t| serde_json::from_value(t).ok()))
    }

    /// Every thread, oldest first.
    pub async fn list(&self) -> Result<Vec<Thread>> {
        let stored = self.inner.store.list_threads().await?;
        let live = self.inner.threads.lock().await.clone();
        let mut out = Vec::new();
        for t in stored {
            let Ok(t) = serde_json::from_value::<Thread>(t) else { continue };
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
        let handle = self.inner.threads.lock().await.remove(thread_id);
        if let Some(h) = handle {
            if let Ok(close) = h.call(|a| a.session.close(&mut a.core)).await {
                close.await;
            }
            let _ = h.call(|a| a.core.dispose()).await;
        }
        self.inner.configs.lock().unwrap().remove(thread_id);
        Ok(self.inner.store.delete_thread(thread_id).await?)
    }

    /// The thread's state now, including text streamed so far.
    pub async fn snapshot(&self, thread_id: &str) -> Result<Snapshot> {
        self.open()?;
        self.load(thread_id).await?.call(|a| a.core.snapshot().clone()).await
    }

    /// The thread's saved events after `seq` (at most `limit`), for a client catching up.
    pub async fn events_since(&self, thread_id: &str, seq: u64, limit: Option<usize>) -> Result<Vec<ThreadEvent>> {
        let handle = self.inner.threads.lock().await.get(thread_id).cloned();
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
        Ok(events.into_iter().filter_map(|e| serde_json::from_value(e).ok()).collect())
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
                    let t = a.core.thread();
                    let current = t.run.as_ref().is_some_and(|r| r.id == run_id);
                    let reattached = current && t.run.as_ref().is_some_and(|r| r.reattached_at.is_some());
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

    // ---------- commands ----------

    /// Carries out a command from a client. A command it can't carry out (an unknown thread, a
    /// closed AgentThreads) is an `Error::Command`.
    pub async fn handle(&self, command: Command) -> Result<()> {
        match command {
            Command::Send(c) => {
                self.send(&c.thread_id, &c.text, SendOptions { attachments: c.attachments, client_id: c.client_id }).await
            }
            Command::Interrupt(c) => self.interrupt(&c.thread_id).await,
            Command::Respond(c) => self.respond(&c.thread_id, &c.request_id, c.resolution).await,
            Command::SetOptions(c) => {
                let o = ThreadOptions { model: c.model, effort: c.effort, permission_mode: c.permission_mode };
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
        let message = Outgoing { text: text.to_string(), attachments: options.attachments, client_id: options.client_id };
        self.ready(thread_id).await?.call(move |a| a.core.send(message)).await
    }

    /// Stops the running turn, if there is one.
    pub async fn interrupt(&self, thread_id: &str) -> Result<()> {
        self.ready(thread_id).await?.call(|a| a.core.interrupt()).await
    }

    /// Answers an open request; does nothing if it isn't open.
    pub async fn respond(&self, thread_id: &str, request_id: &str, resolution: Resolution) -> Result<()> {
        let request_id = request_id.to_string();
        self.ready(thread_id).await?.call(move |a| a.respond(&request_id, resolution)).await
    }

    /// Changes the thread's model, effort or permission mode, from its next turn.
    pub async fn set_options(&self, thread_id: &str, options: ThreadOptions) -> Result<()> {
        self.ready(thread_id)
            .await?
            .call(move |a| {
                let before = serde_json::to_value(a.core.thread()).ok();
                a.core.set_thread(|t| {
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
                if serde_json::to_value(a.core.thread()).ok() != before {
                    a.core.options_changed();
                }
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
        {
            let mut stopped = i.stopped.lock().await;
            if !*stopped {
                *stopped = true;
                i.closed.store(true, Ordering::SeqCst);
                if let Some(p) = i.pruner.lock().unwrap().take() {
                    p.abort();
                }
                self.stop_all(stop).await;
            }
        }
        self.save_all().await
    }

    /// Stops every thread's harness.
    async fn stop_all(&self, stop: bool) {
        let handles: Vec<Handle> = self.inner.threads.lock().await.values().cloned().collect();
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
        let handles: Vec<(String, Handle)> =
            self.inner.threads.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut failed = Vec::new();
        for (id, h) in handles {
            if let Err(e) = h.saved().await {
                failed.push(e.to_string());
                continue;
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
            self.inner.threads.lock().await.remove(&id);
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
        let prompts: Vec<&str> =
            [&all.system_prompt, &own.system_prompt].into_iter().flatten().map(String::as_str).filter(|s| !s.is_empty()).collect();
        ThreadConfig {
            tools,
            mcp_servers,
            skills: all.skills.iter().chain(own.skills.iter()).cloned().collect(),
            system_prompt: (!prompts.is_empty()).then(|| prompts.join("\n\n")),
        }
    }

    fn policy(&self, thread_id: &str) -> PermissionPolicy {
        let own = self.inner.configs.lock().unwrap().get(thread_id).and_then(|c| c.permissions.clone());
        own.or_else(|| self.inner.capabilities.permissions.clone()).unwrap_or_default()
    }

    fn host(&self) -> Arc<Host> {
        let i = &self.inner;
        Arc::new(Host { store: i.store.clone(), spawner: i.spawner.clone(), events: i.events.clone(), on_error: i.on_error.clone() })
    }

    /// A thread's actor, not yet running.
    fn actor(&self, state: Snapshot) -> Result<(Handle, Actor, tokio::sync::mpsc::UnboundedReceiver<Job>)> {
        let id = state.thread.id.clone();
        let harness = self.harness(&state.thread.harness).ok_or_else(|| {
            Error::Command(format!("thread {id} runs on {}, which isn't configured", state.thread.harness))
        })?;
        let (tx, actor, rx) = Actor::start(self.host(), state, self.config(&id), self.policy(&id), |ctx| harness.open(ctx));
        Ok((Handle { tx, task: Arc::new(StdMutex::new(None)) }, actor, rx))
    }

    fn run(&self, handle: &Handle, actor: Actor, rx: tokio::sync::mpsc::UnboundedReceiver<Job>) {
        // A first job, so whatever loading it made is saved straight away.
        let _ = handle.tx.send(Box::new(|_| {}));
        *handle.task.lock().unwrap() = Some(tokio::spawn(actor.run(rx)));
    }

    /// The live thread, loaded from the store if it isn't yet.
    async fn load(&self, thread_id: &str) -> Result<Handle> {
        let mut threads = self.inner.threads.lock().await;
        if let Some(h) = threads.get(thread_id) {
            return Ok(h.clone());
        }
        let h = self.from_store(thread_id).await?;
        threads.insert(thread_id.to_string(), h.clone());
        Ok(h)
    }

    async fn from_store(&self, thread_id: &str) -> Result<Handle> {
        let store = &self.inner.store;
        let Some(thread) = store.get_thread(thread_id).await? else {
            return Err(Error::Command(format!("there's no thread {thread_id}")));
        };
        let thread: Thread = serde_json::from_value(thread).map_err(|e| Error::Command(format!("thread {thread_id} can't be read: {e}")))?;
        let snap: Option<Snapshot> = store.load_snapshot(thread_id).await?.and_then(|s| serde_json::from_value(s).ok());
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
        let (handle, mut actor, rx) = self.actor(state)?;
        if !self.reattach(&mut actor).await {
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
    async fn reattach(&self, actor: &mut Actor) -> bool {
        let Some(run) = actor.core.thread().run.clone() else { return false };
        if run.spawner.to_string() == "direct" {
            return false;
        }
        let record = match self.inner.store.get_run(&run.id).await {
            Ok(Some(r)) if r.ended_at.is_none() => r,
            Ok(_) => return false,
            Err(e) => {
                (self.inner.on_error)(Error::Store(e));
                return false;
            }
        };
        let saved_turn: Option<Turn> =
            record.data.as_ref().and_then(|d| d.get("turn")).and_then(|t| serde_json::from_value(t.clone()).ok());
        if matches!(actor.core.thread().status, ThreadStatus::Running | ThreadStatus::Waiting) {
            let last = last_turn(actor.core.snapshot());
            actor.core.turn = Some(saved_turn.unwrap_or_else(|| Turn {
                id: last.unwrap_or_else(|| new_id("turn")),
                interrupted: false,
                carried: 0,
                progressed: false,
            }));
        }
        actor.core.adopt_run(record.clone());
        let spawner = &self.inner.spawner;
        let ok = spawner.can_attach() && record.spawner == spawner.name() && {
            let (s, c) = (&mut actor.session, &mut actor.core);
            s.reattach(c, &record)
        };
        if !ok {
            actor.core.turn = None;
            self.abandon(record).await;
            return false;
        }
        let c = &mut actor.core;
        // Requests the session didn't take up again can't be answered.
        let open = c.open_request_ids();
        let stale: Vec<String> = c.snapshot().requests.iter().map(|r| r.id().to_string()).filter(|id| !open.contains(id)).collect();
        for id in stale {
            c.emit_resolved(&id, &cancel_resolution());
        }
        c.set_thread(|t| {
            if let Some(r) = &mut t.run {
                r.reattached_at = Some(now_iso());
            }
        });
        if c.turn.is_some() {
            c.add_item(json!({
                "id": new_id("n"), "type": "notice", "level": "info", "code": "run.reattached",
                "text": "The backend restarted while this turn was running, and picked it up again.",
            }));
        }
        true
    }
}

async fn abandon(spawner: &Arc<dyn Spawner>, store: &Arc<dyn Store>, on_error: &Arc<dyn Fn(Error) + Send + Sync>, run: RunRecord) {
    spawner.stop_run(&run);
    if let Err(e) = store.put_run(&RunRecord { ended_at: Some(now_iso()), ..run }).await {
        on_error(Error::Store(e));
    }
}

fn cancel_resolution() -> Resolution {
    serde_json::from_value(json!({"outcome": "cancel"})).unwrap()
}

/// The last turn the thread's items were made in.
fn last_turn(s: &Snapshot) -> Option<String> {
    s.items.iter().rev().find_map(Item::turn_id).map(String::from)
}

/// Ends a turn whose process was lost when the backend stopped.
fn recover_lost(c: &mut ThreadContext) {
    if matches!(c.thread().status, ThreadStatus::Running | ThreadStatus::Waiting) {
        let id = last_turn(c.snapshot()).unwrap_or_else(|| new_id("turn"));
        c.turn = Some(Turn { id, interrupted: false, carried: 0, progressed: false });
        let requests: Vec<String> = c.snapshot().requests.iter().map(|r| r.id().to_string()).collect();
        for id in requests {
            c.emit_resolved(&id, &cancel_resolution());
        }
        c.add_item(json!({
            "id": new_id("n"), "type": "notice", "level": "warning", "code": "run.lost",
            "text": "The backend stopped while this turn was running, and couldn't pick its run up again.",
        }));
        // Not carried over: loading a thread starts no process. Its queued messages go with the next.
        let end = TurnEnd { ok: false, error: Some("The backend stopped while this turn was running.".into()), ..Default::default() };
        c.finish_turn(end, false, false);
    }
    c.set_thread(|t| t.run = None);
}

//! One thread, live: its state (folded from its events with the reducer), the running turn, the
//! steering queue and open requests. Every change is an event, numbered, applied, sent to the
//! subscribers, and saved to the store in order (deltas aren't saved).
//!
//! Each thread runs on a task of its own (an actor), which owns its [`ThreadContext`] and its
//! driver's [`HarnessSession`] and runs one job at a time, as Node's event loop does for the Node
//! backend: what the harness says, the app's commands, timers and the answers of async work (a
//! policy, a tool, the store) are all jobs posted to it. Events made by a batch of jobs are saved
//! together, after it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::agent_threads::Error;
use crate::harness::{
    HarnessMessage, HarnessMessageHandler, HarnessSession, LaunchOptions, Message, RunCheckpoint, ThreadConfig, TurnEnd,
};
use crate::ids::{new_id, now_iso};
use crate::permissions::{Decided, PermissionContext, PermissionDecision, PermissionPolicy, PermissionQuery, decide};
use crate::protocol::{
    Attachment, DeltaEventKind, Item, RateLimit, Resolution, ResolutionOutcome, Snapshot, SubagentState,
    SubagentStatus, Thread, ThreadEvent, ThreadRequest, TurnSession, Usage, UserMessage,
};
use crate::reducer::{apply_event, open_requests, utf16_len};
use crate::sessions::RewindError;
use crate::spawner::Spawner;
use crate::store::{RunRecord, Store, StoreError, StoreErrorKind};

pub(crate) type Job = Box<dyn FnOnce(&mut Actor) + Send>;

/// Whether an item is a background subagent's call that's still running.
pub fn running_in_background(it: &Item) -> bool {
    matches!(it, Item::ToolCall(c) if c.subagent.as_ref().is_some_and(|s| s.background && s.status == SubagentStatus::Running))
}
/// A job for a thread's session (a `S`), as [`ThreadContext::poster`] posts it.
pub type SessionJob<S> = Box<dyn FnOnce(&mut S, &mut ThreadContext) + Send>;
/// What's done with the user's answer to a request.
pub type Answered = Box<dyn FnOnce(&mut Actor, Resolution) + Send>;
type Persisted = Box<dyn FnOnce(&mut Actor, Result<(), StoreError>) + Send>;

/// A thread's running turn.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Turn {
    pub id: String,
    pub interrupted: bool,
    /// The thread's session_id when it started (none: it starts a new session).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// How many turns in a row (this one included) are retries for messages left queued that took
    /// none in: carried over from the turn before, or sent again with an explicit message.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub carried: u32,
    /// The harness took in a queued message during it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub progressed: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// How many retries in a row for queued messages may take none in.
const MAX_CARRIED: u32 = 3;

// Steered messages, and who has them. A steered message is queued (its item has `queued`, and its
// id is in `queue`) until the harness echoes it back as taken in (took_in); nothing else unqueues
// it. Until then it's either with the session's live process (written to its stdin) or with
// nobody. When a turn ends with messages queued, end_turn either carries them over (a new turn,
// which the live process takes them into, or a new process if there's none) or gives up on them:
// then the session releases them, stopping any process that has them so it can't act on them
// unseen, and they're sent again, first, with the next message the user sends.

struct OpenRequest {
    request: ThreadRequest,
    answered: Answered,
    /// The tool it's about (permission_key), for an answer given `always`.
    standing: Option<String>,
}

/// What the core asks of the session, once the job that asked is done with it.
enum Effect {
    Start(Vec<Message>),
    Steer(Message),
    CarryOver(Vec<Message>),
    Interrupt,
    Release,
    OptionsChanged,
    Compact,
    ConfigChanged,
}

/// Something waiting for the next save.
enum Waiter {
    /// Everything so far saved, or the store's error.
    Saved(oneshot::Sender<Result<(), StoreError>>),
    /// A driver's persist().
    Persist(Persisted),
}

/// A message as sent: its text and attachments, and the client's id for it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Outgoing {
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub client_id: Option<String>,
}

/// What a thread needs from the AgentThreads that holds it.
pub(crate) struct Host {
    pub store: Arc<dyn Store>,
    pub spawner: Arc<dyn Spawner>,
    pub events: broadcast::Sender<ThreadEvent>,
    pub on_error: Arc<dyn Fn(Error) + Send + Sync>,
    /// Fill in events' `raw` (the raw option).
    pub raw: bool,
    pub on_harness_message: Option<HarnessMessageHandler>,
}

/// A thread on its task: the core and the driver's session.
pub struct Actor {
    pub(crate) core: ThreadContext,
    pub(crate) session: Box<dyn HarnessSession>,
}

/// The core's side, for one thread: what a driver is given.
pub struct ThreadContext {
    thread_id: String,
    pub(crate) config: ThreadConfig,
    /// How its harness process is started: stored with the thread.
    pub(crate) launch: LaunchOptions,
    pub(crate) policy: PermissionPolicy,
    host: Arc<Host>,
    pub(crate) turn: Option<Turn>,
    /// The backend is shutting down: a turn that ends doesn't start another.
    pub(crate) closing: bool,
    /// The run it had when it was loaded, which was lost (not re-attached to).
    pub(crate) lost_run: Option<String>,
    /// The run it had when it was loaded, which it re-attached to.
    pub(crate) reattached_run: Option<String>,
    /// The live state, with the text streamed so far.
    state: Snapshot,
    /// The saved events' state, without deltas: what a change is a change to.
    saved: Snapshot,
    queue: Vec<String>,
    requests: Vec<(String, OpenRequest)>,
    always: HashMap<String, bool>,
    unsaved: Vec<ThreadEvent>,
    thread_changed: bool,
    flush_queued: bool,
    snapshot_due: bool,
    /// Why the last write failed, while writes are failing.
    failure: Option<StoreError>,
    retrying: bool,
    backoff_ms: u64,
    /// The run record last saved, while its run goes on (with a durable spawner).
    run: Option<(RunRecord, String)>,
    /// Items text has streamed into since the turn began (whose text may not be saved yet).
    streaming: Vec<String>,
    /// App tools' structured output, by tool call, until the harness gives the call its result.
    structured: HashMap<String, Value>,
    effects: VecDeque<Effect>,
    waiters: Vec<Waiter>,
    /// The harness message being handled, which events made now have as their `raw` (with the raw
    /// option).
    raw: Option<Value>,
    tx: mpsc::UnboundedSender<Job>,
    /// Stops retrying writes: the backend is closing.
    pub(crate) disposed: bool,
    /// The task ends.
    exit: bool,
}

/// A timer a driver set, which it can cancel.
pub struct Timer {
    cancelled: Arc<AtomicBool>,
    handle: tokio::task::AbortHandle,
}

impl Timer {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.handle.abort();
    }
}

impl ThreadContext {
    // ---------- what drivers read ----------

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn thread(&self) -> &Thread {
        &self.state.thread
    }

    pub fn snapshot(&self) -> &Snapshot {
        &self.state
    }

    pub fn config(&self) -> &ThreadConfig {
        &self.config
    }

    /// How the thread's harness process is started: its args, environment, directories and config
    /// directory.
    pub fn launch(&self) -> &LaunchOptions {
        &self.launch
    }

    pub fn spawner(&self) -> &Arc<dyn Spawner> {
        &self.host.spawner
    }

    /// The running turn's id, if one is running.
    pub fn turn_id(&self) -> Option<&str> {
        self.turn.as_ref().map(|t| t.id.as_str())
    }

    /// Whether the running turn was interrupted.
    pub fn interrupted(&self) -> bool {
        self.turn.as_ref().is_some_and(|t| t.interrupted)
    }

    /// Steered messages the harness hasn't taken in yet, oldest first.
    pub fn queued(&self) -> Vec<UserMessage> {
        self.queue
            .iter()
            .filter_map(|id| match self.item(id) {
                Some(Item::UserMessage(m)) => Some(m.clone()),
                _ => None,
            })
            .collect()
    }

    /// The item with the id, as saved.
    pub fn item(&self, id: &str) -> Option<&Item> {
        self.saved.items.iter().rev().find(|i| i.id() == id)
    }

    /// The calls of the subagents an item is inside, innermost first.
    pub fn ancestors(&self, id: &str) -> Vec<&Item> {
        let mut out: Vec<&Item> = Vec::new();
        let mut parent = self.item(id).and_then(Item::parent_id);
        while let Some(p) = parent {
            if out.iter().any(|a| a.id() == p) {
                break;
            }
            let Some(it) = self.item(p) else { break };
            out.push(it);
            parent = it.parent_id();
        }
        out
    }

    /// Whether an item is inside a background subagent that's still running: what it does carries
    /// on after the turn it was started in has ended.
    pub fn in_background(&self, id: &str) -> bool {
        self.ancestors(id).into_iter().any(running_in_background)
    }

    // ---------- jobs ----------

    /// Runs `f` with the session (a `S`) as a job of its own, after the one running now.
    pub fn post<S: HarnessSession>(&self, f: impl FnOnce(&mut S, &mut ThreadContext) + Send + 'static) {
        let _ = self.tx.send(Box::new(move |a: &mut Actor| a.with_session(f)));
    }

    /// A function that posts jobs for the session (a `S`) from another task; it says whether the
    /// thread is still there to take them.
    pub fn poster<S: HarnessSession>(&self) -> impl Fn(SessionJob<S>) -> bool + Send + Sync + 'static {
        let tx = self.tx.clone();
        move |f| tx.send(Box::new(move |a: &mut Actor| a.with_session(f))).is_ok()
    }

    /// Runs `fut` off the thread's task, then `then` with its output as a job.
    pub fn spawn<S: HarnessSession, T: Send + 'static>(
        &self,
        fut: impl Future<Output = T> + Send + 'static,
        then: impl FnOnce(&mut S, &mut ThreadContext, T) + Send + 'static,
    ) {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let out = fut.await;
            let _ = tx.send(Box::new(move |a: &mut Actor| {
                a.with_session(move |s: &mut S, c| then(s, c, out))
            }));
        });
    }

    /// Runs `f` after `after`, unless the timer is cancelled first.
    pub fn timer<S: HarnessSession>(
        &self,
        after: Duration,
        f: impl FnOnce(&mut S, &mut ThreadContext) + Send + 'static,
    ) -> Timer {
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let tx = self.tx.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            let _ = tx.send(Box::new(move |a: &mut Actor| {
                if !flag.load(Ordering::SeqCst) {
                    a.with_session(f);
                }
            }));
        })
        .abort_handle();
        Timer { cancelled, handle }
    }

    /// An answer to a request (for ask() and reopen()) that runs `f` with the session.
    pub fn answered<S: HarnessSession>(
        f: impl FnOnce(&mut S, &mut ThreadContext, Resolution) + Send + 'static,
    ) -> Answered {
        Box::new(move |a: &mut Actor, r| a.with_session(move |s: &mut S, c| f(s, c, r)))
    }

    // ---------- events ----------

    /// Numbers an event (`type` and its fields), applies it, sends it, and queues it to be saved.
    fn emit(&mut self, mut event: Value) {
        // An item or request has the harness message it came from, and its event doesn't as well.
        if let Some(raw) = &self.raw {
            match event["type"].as_str() {
                Some("item.added") => event["item"]["raw"] = raw.clone(),
                Some("request.opened") => event["request"]["raw"] = raw.clone(),
                _ => event["raw"] = raw.clone(),
            }
        }
        let saved = event["type"] != "delta";
        event["thread_id"] = json!(self.thread_id);
        event["seq"] = json!(self.state.seq + saved as u64);
        let e: ThreadEvent = match serde_json::from_value(event.clone()) {
            Ok(e) => e,
            Err(err) => {
                self.error(Error::Other(format!(
                    "agent-threads made an invalid event ({err}): {event}"
                )));
                return;
            }
        };
        apply_event(&mut self.state, &e);
        if saved {
            apply_event(&mut self.saved, &e);
            self.unsaved.push(e.clone());
            self.flush_queued = true;
        }
        let _ = self.host.events.send(e);
    }

    pub(crate) fn emit_resolved(&mut self, request_id: &str, resolution: &Resolution) {
        self.emit(json!({"type": "request.resolved", "request_id": request_id, "resolution": resolution}));
    }

    /// Adds an item (an `Item` as JSON), in the running turn.
    pub fn add_item(&mut self, mut item: Value) {
        if let Some(turn) = &self.turn
            && item.get("turn_id").is_none()
        {
            item["turn_id"] = json!(turn.id);
        }
        if let Some(o) = item.as_object_mut()
            && o.get("parent_id").is_some_and(|p| p.is_null() || p == "")
        {
            o.remove("parent_id");
        }
        self.emit(json!({"type": "item.added", "item": item}));
    }

    /// Changes an item's fields (null removes one); sends nothing if nothing changes.
    pub fn update_item(&mut self, id: &str, mut patch: Value) {
        if self.item(id).is_none() {
            return;
        }
        // An app tool's structured output goes with its call's result (harnesses pass on only the
        // text).
        if patch.get("result").is_some_and(Value::is_object)
            && let Some(structured) = self.structured.remove(id)
            && patch["result"].get("structured").is_none()
        {
            patch["result"]["structured"] = structured;
        }
        let item = serde_json::to_value(self.item(id)).unwrap_or_default();
        let mut changed = Map::new();
        for (k, v) in patch.as_object().into_iter().flatten() {
            if k == "id" || k == "type" {
                continue;
            }
            let differs = if v.is_null() {
                item.get(k).is_some()
            } else {
                item.get(k) != Some(v)
            };
            if differs {
                changed.insert(k.clone(), v.clone());
            }
        }
        if !changed.is_empty() {
            self.emit(json!({"type": "item.updated", "item_id": id, "patch": changed}));
        }
    }

    /// An app tool returned structured output for the tool call `tool_call_id`: it goes in the
    /// call's `result.structured` when the harness gives the call its result.
    pub fn tool_output(&mut self, tool_call_id: &str, structured: Option<Value>) {
        if let Some(s) = structured {
            self.structured.insert(tool_call_id.to_string(), s);
        }
    }

    /// Streams text onto the end of an assistant_message or reasoning item's text; sends nothing
    /// for "".
    pub fn delta(&mut self, item_id: &str, kind: DeltaEventKind, text: &str) {
        if text.is_empty() {
            return;
        }
        if !self.streaming.iter().any(|s| s == item_id) {
            self.streaming.push(item_id.to_string());
        }
        // Where it goes: the length of the item's text so far, the deltas before it included.
        let offset = self
            .state
            .items
            .iter()
            .rev()
            .find(|i| i.id() == item_id)
            .and_then(Item::streamed_text)
            .map_or(0, utf16_len);
        self.emit(json!({"type": "delta", "item_id": item_id, "kind": kind, "offset": offset, "text": text}));
    }

    /// Changes the thread; sends nothing if nothing changes (`updated_at` aside).
    pub fn set_thread(&mut self, change: impl FnOnce(&mut Thread)) {
        let mut next = self.state.thread.clone();
        change(&mut next);
        next.id = self.state.thread.id.clone();
        next.created_at = self.state.thread.created_at.clone();
        next.updated_at = self.state.thread.updated_at.clone();
        if serde_json::to_value(&next).ok() == serde_json::to_value(&self.state.thread).ok() {
            return;
        }
        next.updated_at = Some(now_iso());
        self.thread_changed = true;
        self.emit(json!({"type": "thread.updated", "thread": next}));
    }

    /// The harness reported usage limits: they replace the thread's `rate_limits` with the same
    /// ids, which are kept sorted by id (with a thread.updated if that changes them).
    pub fn rate_limits(&mut self, limits: Vec<RateLimit>) {
        if limits.is_empty() {
            return;
        }
        self.set_thread(|t| {
            for l in limits {
                match t.rate_limits.iter_mut().find(|x| x.id == l.id) {
                    Some(x) => *x = l,
                    None => t.rate_limits.push(l),
                }
            }
            t.rate_limits.sort_by(|a, b| a.id.cmp(&b.id));
        });
    }

    /// Handles a line the harness process `run_id` wrote (`message` is it parsed, if it's JSON):
    /// runs `handle`, which translates it, with the events it makes taking it as their `raw` (with
    /// the raw option on), and then passes it to the app's `on_harness_message`.
    pub fn from_harness(
        &mut self,
        run_id: &str,
        line: &str,
        message: Option<Value>,
        handle: impl FnOnce(&mut ThreadContext, Option<&Value>),
    ) {
        let before = if self.host.raw && message.is_some() {
            std::mem::replace(&mut self.raw, message.clone())
        } else {
            self.raw.take()
        };
        handle(self, message.as_ref());
        self.raw = before;
        if let Some(f) = self.host.on_harness_message.clone() {
            let m = HarnessMessage {
                thread_id: self.thread_id.clone(),
                run_id: run_id.to_string(),
                harness: self.state.thread.harness.clone(),
                line: line.to_string(),
                message,
            };
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&m))).is_err() {
                self.error(Error::Other("the app's on_harness_message panicked".into()));
            }
        }
    }

    /// The harness took in the queued message with this id. Whether it was queued.
    pub fn took_in(&mut self, id: &str) -> bool {
        let Some(at) = self.queue.iter().position(|q| q == id) else {
            return false;
        };
        self.queue.remove(at);
        self.update_item(id, json!({"queued": null}));
        if let Some(turn) = &mut self.turn {
            turn.progressed = true;
        }
        true
    }

    // ---------- turns ----------

    /// Sends a message: starts a turn, or steers the running one.
    pub(crate) fn send(&mut self, message: Outgoing) {
        let id = new_id("um");
        if self.turn.is_none() {
            // Messages still queued from before weren't delivered: they go first, in this turn, and
            // stay queued until the harness takes them in. Such a turn is a retry for them.
            let left = self.queued();
            let turn = Turn {
                id: new_id("turn"),
                interrupted: false,
                session: self.session_now(),
                carried: !left.is_empty() as u32,
                progressed: false,
            };
            let turn_id = turn.id.clone();
            self.turn = Some(turn);
            for m in &left {
                self.update_item(&m.id, json!({"turn_id": turn_id}));
            }
            self.add_item(user_item(&id, &message, false));
            self.emit(json!({"type": "turn.started", "turn_id": turn_id}));
            self.set_thread(|t| {
                t.status = crate::protocol::ThreadStatus::Running;
                t.error = None;
            });
            let mut messages: Vec<Message> = left.iter().map(queued_message).collect();
            messages.push(Message {
                id,
                text: message.text,
                attachments: message.attachments,
            });
            self.effects.push_back(Effect::Start(messages));
            return;
        }
        self.add_item(user_item(&id, &message, true));
        self.queue.push(id.clone());
        self.effects.push_back(Effect::Steer(Message {
            id,
            text: message.text,
            attachments: message.attachments,
        }));
    }

    /// The session a turn starting now starts in, for its Turn.
    fn session_now(&self) -> Option<String> {
        self.state.thread.session_id.clone()
    }

    /// Compacts the harness's context: a turn with no message. The caller checks one can start.
    pub(crate) fn compact(&mut self) {
        let turn = Turn {
            id: new_id("turn"),
            interrupted: false,
            session: self.session_now(),
            carried: 0,
            progressed: false,
        };
        let turn_id = turn.id.clone();
        self.turn = Some(turn);
        self.emit(json!({"type": "turn.started", "turn_id": turn_id}));
        self.set_thread(|t| {
            t.status = crate::protocol::ThreadStatus::Running;
            t.error = None;
        });
        self.effects.push_back(Effect::Compact);
    }

    pub(crate) fn interrupt(&mut self) {
        let Some(turn) = &mut self.turn else { return };
        if turn.interrupted {
            return;
        }
        turn.interrupted = true;
        self.effects.push_back(Effect::Interrupt);
        // No event says so, but a run that outlives the backend is saved with its turn.
        if self.host.spawner.durable() {
            self.flush_queued = true;
        }
    }

    pub(crate) fn options_changed(&mut self) {
        self.effects.push_back(Effect::OptionsChanged);
    }

    pub(crate) fn config_changed(&mut self) {
        self.effects.push_back(Effect::ConfigChanged);
    }

    /// The running turn ended. `live`: whether the session has a process running that has the
    /// queued messages (HarnessSession::live).
    pub fn end_turn(&mut self, end: TurnEnd, live: bool) {
        self.finish_turn(end, live, true);
    }

    /// Ends the running turn. Its queued messages are carried over to a new turn unless `carry` is
    /// false (shutting down, or recovering a turn the backend lost), or they've been tried enough.
    pub(crate) fn finish_turn(&mut self, end: TurnEnd, live: bool, carry: bool) {
        let Some(turn) = self.turn.clone() else { return };
        // What a background subagent that's still running does carries on after the turn: its
        // text still streaming, its calls (and their structured output, still to go with their
        // results) and its requests.
        // Text streamed but never finished (its process went first) is kept as it was shown.
        self.finish_text(|c, id| !c.in_background(id));
        let ending: Vec<String> = self
            .structured
            .keys()
            .filter(|id| !self.in_background(id))
            .cloned()
            .collect();
        for id in ending {
            self.structured.remove(&id);
        }
        let cut: Vec<(String, Option<SubagentState>)> = self
            .state
            .items
            .iter()
            .filter_map(|it| match it {
                Item::ToolCall(c)
                    if c.turn_id.as_deref() == Some(&turn.id)
                        && matches!(
                            c.status,
                            crate::protocol::ToolStatus::Running | crate::protocol::ToolStatus::Pending
                        )
                        && !self.in_background(&c.id) =>
                {
                    let subagent = match self.item(&c.id) {
                        Some(Item::ToolCall(saved)) => saved.subagent.clone(),
                        _ => None,
                    };
                    Some((c.id.clone(), subagent))
                }
                _ => None,
            })
            .collect();
        for (id, subagent) in cut {
            let mut patch = json!({"status": "cancelled"});
            // A subagent cut short (by an interrupt, or its process ending) is stopped with its call.
            if let Some(mut s) = subagent.filter(|s| s.status == SubagentStatus::Running) {
                s.status = SubagentStatus::Stopped;
                patch["subagent"] = json!(s);
            }
            self.update_item(&id, patch);
        }
        let mut i = 0;
        while i < self.requests.len() {
            let r = &self.requests[i].1.request;
            if r.turn_id().is_some_and(|t| t != turn.id) || r.tool_call_id().is_some_and(|c| self.in_background(c)) {
                i += 1;
                continue;
            }
            let (id, _) = self.requests.remove(i);
            self.emit_resolved(&id, &cancel());
        }
        let ok = end.ok && !turn.interrupted;
        let error = (!ok && !turn.interrupted).then(|| {
            end.error
                .clone()
                .filter(|e| !e.is_empty())
                .unwrap_or_else(|| "The turn failed.".into())
        });
        let mut result = json!({"id": new_id("tr"), "type": "turn_result", "ok": ok});
        if turn.interrupted {
            result["interrupted"] = json!(true);
        }
        if let Some(e) = &error {
            result["error"] = json!(e);
        }
        if let Some(u) = &end.usage {
            result["usage"] = json!(u);
        }
        if let Some(d) = end.duration_ms {
            result["duration_ms"] = json!(d);
        }
        if let Some(id) = &self.state.thread.session_id {
            let mut session = json!({"id": id});
            if let Some(at) = end.session_at.as_ref().filter(|a| !a.is_empty()) {
                session["at"] = json!(at);
            }
            if turn.session.is_none() {
                session["started"] = json!(true);
            }
            result["session"] = session;
        }
        self.add_item(result);
        self.emit(json!({"type": "turn.completed", "turn_id": turn.id}));
        self.turn = None;
        let usage = add_usage(self.state.thread.usage.as_ref(), end.usage.as_ref());

        // Queued messages are carried over to the next turn, unless:
        // - shutting down (which closes the process that has them), or the turn was lost (its
        //   process is gone): they wait, queued, for the next message;
        // - that's been tried enough: a retry that was interrupted (the user wants it stopped), one
        //   that failed with no process left holding them, or too many in a row that took none in.
        //   Then a process that has them is stopped, and they wait too. A retry that failed while
        //   its process lives and holds them carries over again (to the limit), since that process
        //   would otherwise take them in unseen.
        let left = self.queued();
        let retry = turn.carried > 0;
        let carried = if turn.progressed { 0 } else { turn.carried };
        let give_up = left.is_empty()
            || !carry
            || self.closing
            || carried >= MAX_CARRIED
            || (retry && turn.interrupted)
            || (carried > 0 && !ok && !live);
        if give_up {
            let waiting = !self.requests.is_empty();
            self.set_thread(|t| {
                t.status = if error.is_some() {
                    crate::protocol::ThreadStatus::Error
                } else if waiting {
                    crate::protocol::ThreadStatus::Waiting
                } else {
                    crate::protocol::ThreadStatus::Idle
                };
                t.error = error.clone();
                t.usage = usage.clone();
            });
            if !left.is_empty() && carry && !self.closing {
                self.effects.push_back(Effect::Release);
            }
            if !left.is_empty() && !self.closing {
                self.undelivered(left.len());
            }
            self.snapshot_due = true;
            return;
        }
        // The next turn starts straight away, so the thread doesn't go idle in between.
        let next = Turn {
            id: new_id("turn"),
            interrupted: false,
            session: self.session_now(),
            carried: carried + 1,
            progressed: false,
        };
        let next_id = next.id.clone();
        self.turn = Some(next);
        for m in &left {
            self.update_item(&m.id, json!({"turn_id": next_id}));
        }
        self.emit(json!({"type": "turn.started", "turn_id": next_id}));
        self.set_thread(|t| {
            t.status = crate::protocol::ThreadStatus::Running;
            t.error = None;
            t.usage = usage;
        });
        self.effects
            .push_back(Effect::CarryOver(left.iter().map(queued_message).collect()));
    }

    /// Keeps text streamed into the items `which` picks, but never finished, as it was shown.
    fn finish_text(&mut self, which: impl Fn(&ThreadContext, &str) -> bool) {
        let unfinished: Vec<(String, String)> = self
            .state
            .items
            .iter()
            .filter(|it| which(self, it.id()))
            .filter_map(|it| {
                let text = it.streamed_text()?;
                let saved = self.item(it.id())?.streamed_text()?;
                (saved != text).then(|| (it.id().to_string(), text.to_string()))
            })
            .collect();
        for (id, text) in unfinished {
            self.update_item(&id, json!({"text": text}));
        }
        let done: Vec<String> = self.streaming.iter().filter(|id| which(self, id)).cloned().collect();
        self.streaming.retain(|id| !done.contains(id));
    }

    /// The harness started a turn by itself, with no message (Claude does, to tell the agent that a
    /// background subagent has ended). Does nothing if a turn is running.
    pub fn begin_turn(&mut self) {
        if self.turn.is_some() || self.closing || self.disposed {
            return;
        }
        let turn = Turn {
            id: new_id("turn"),
            interrupted: false,
            session: self.session_now(),
            carried: 0,
            progressed: false,
        };
        let id = turn.id.clone();
        self.turn = Some(turn);
        self.emit(json!({"type": "turn.started", "turn_id": id}));
        self.set_thread(|t| {
            t.status = crate::protocol::ThreadStatus::Running;
            t.error = None;
        });
    }

    /// The subagents of these calls that are still running were stopped (their harness process
    /// ended): their calls still running are cancelled, and their open requests too.
    pub fn stop_subagents(&mut self, ids: &[String]) {
        let mut stopped: Vec<String> = Vec::new();
        for id in ids {
            let Some(Item::ToolCall(c)) = self.item(id) else {
                continue;
            };
            let Some(mut s) = c.subagent.clone().filter(|s| s.status == SubagentStatus::Running) else {
                continue;
            };
            if stopped.contains(id) {
                continue;
            }
            stopped.push(id.clone());
            s.status = SubagentStatus::Stopped;
            self.update_item(id, json!({"subagent": s}));
        }
        if stopped.is_empty() {
            return;
        }
        let within =
            |ctx: &ThreadContext, id: &str| ctx.ancestors(id).iter().any(|a| stopped.iter().any(|s| s == a.id()));
        self.finish_text(within);
        let done: Vec<String> = self.structured.keys().filter(|id| within(self, id)).cloned().collect();
        for id in done {
            self.structured.remove(&id);
        }
        let cut: Vec<String> = self
            .state
            .items
            .iter()
            .filter_map(|it| match it {
                Item::ToolCall(c)
                    if matches!(
                        c.status,
                        crate::protocol::ToolStatus::Running | crate::protocol::ToolStatus::Pending
                    ) && within(self, &c.id) =>
                {
                    Some(c.id.clone())
                }
                _ => None,
            })
            .collect();
        for id in cut {
            self.update_item(&id, json!({"status": "cancelled"}));
        }
        let mut i = 0;
        while i < self.requests.len() {
            if !self.requests[i]
                .1
                .request
                .tool_call_id()
                .is_some_and(|c| within(self, c))
            {
                i += 1;
                continue;
            }
            let (id, _) = self.requests.remove(i);
            self.emit_resolved(&id, &cancel());
        }
        if self.requests.is_empty()
            && self.turn.is_none()
            && self.state.thread.status == crate::protocol::ThreadStatus::Waiting
        {
            self.set_thread(|t| t.status = crate::protocol::ThreadStatus::Idle);
        }
    }

    /// Sets the thread running again once it has no open requests, or idle if no turn is running
    /// (a background subagent's request can be answered after its turn).
    pub(crate) fn requests_done(&mut self) {
        if !self.requests.is_empty() {
            return;
        }
        if self.turn.is_some() {
            self.set_thread(|t| t.status = crate::protocol::ThreadStatus::Running);
        } else if self.state.thread.status == crate::protocol::ThreadStatus::Waiting {
            self.set_thread(|t| t.status = crate::protocol::ThreadStatus::Idle);
        }
    }

    fn undelivered(&mut self, n: usize) {
        let text = if n == 1 {
            "A message wasn't delivered; it goes with the next one you send.".to_string()
        } else {
            format!("{n} messages weren't delivered; they go with the next one you send.")
        };
        self.add_item(
            json!({"id": new_id("n"), "type": "notice", "level": "warning", "code": "undelivered", "text": text}),
        );
    }

    // ---------- requests ----------

    /// The permission policy's answer: at once when it has one, or later.
    pub fn decide(&self, query: PermissionQuery) -> Decided {
        let key = crate::permissions::permission_key(query.kind, query.server.as_deref(), &query.name);
        if let Some(&allow) = self.always.get(&key) {
            return Decided::Now(if allow {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny(None)
            });
        }
        let thread = self.state.thread.clone();
        let ctx = PermissionContext {
            thread_id: self.thread_id.clone(),
            metadata: thread.metadata.clone(),
            thread,
        };
        decide(&self.policy, query, ctx)
    }

    /// Opens a request (a `ThreadRequest` as JSON, without its id; for the tool call `tool_call_id`,
    /// which is set `pending`), and calls `answered` when the user responds. It isn't called when
    /// the request is cancelled because its turn ended. `standing` (the tool's permission_key) lets
    /// an answer given `always` stand for the thread.
    pub fn ask(
        &mut self,
        mut request: Value,
        tool_call_id: Option<&str>,
        answered: Answered,
        standing: Option<String>,
    ) -> String {
        let id = new_id(match request["type"].as_str() {
            Some("question") => "q",
            Some("plan") => "plan",
            _ => "perm",
        });
        request["id"] = json!(id);
        if let Some(turn) = &self.turn {
            request["turn_id"] = json!(turn.id);
        }
        let call = tool_call_id
            .and_then(|c| self.item(c))
            .map(|i| (i.id().to_string(), i.parent_id().map(String::from)));
        if let Some((call, parent)) = &call {
            request["tool_call_id"] = json!(call);
            if let Some(p) = parent {
                request["parent_id"] = json!(p);
            }
            self.update_item(call, json!({"status": "pending"}));
        }
        let parsed: ThreadRequest = match serde_json::from_value(request.clone()) {
            Ok(r) => r,
            Err(e) => {
                self.error(Error::Other(format!(
                    "agent-threads made an invalid request ({e}): {request}"
                )));
                return id;
            }
        };
        self.requests.push((
            id.clone(),
            OpenRequest {
                request: parsed,
                answered,
                standing,
            },
        ));
        self.emit(json!({"type": "request.opened", "request": request}));
        self.set_thread(|t| t.status = crate::protocol::ThreadStatus::Waiting);
        id
    }

    /// Takes up a request opened before the backend restarted, which is still open: `answered` is
    /// called when the user responds, as for ask(). If it isn't open, `answered` is given back.
    pub fn reopen(&mut self, request_id: &str, answered: Answered, standing: Option<String>) -> Result<(), Answered> {
        if self.requests.iter().any(|(id, _)| id == request_id) {
            return Err(answered);
        }
        let Some(request) = open_requests(&self.state).find(|r| r.id() == request_id).cloned() else {
            return Err(answered);
        };
        self.requests.push((
            request_id.to_string(),
            OpenRequest {
                request,
                answered,
                standing,
            },
        ));
        Ok(())
    }

    /// Asks with `request` as ask() does, unless `existing` (a request the user was asked with
    /// before the backend restarted) is still open: then that's taken up again. The request's id.
    pub fn ask_again(
        &mut self,
        existing: Option<&str>,
        request: Value,
        tool_call_id: Option<&str>,
        answered: Answered,
        standing: Option<String>,
    ) -> String {
        let answered = match existing {
            Some(id) => match self.reopen(id, answered, standing.clone()) {
                Ok(()) => return id.to_string(),
                Err(a) => a,
            },
            None => answered,
        };
        self.ask(request, tool_call_id, answered, standing)
    }

    /// Closes a request the harness no longer wants answered.
    pub fn cancel_request(&mut self, id: &str) {
        let Some(at) = self.requests.iter().position(|(r, _)| r == id) else {
            return;
        };
        self.requests.remove(at);
        self.emit_resolved(id, &cancel());
        self.requests_done();
    }

    pub(crate) fn open_request_ids(&self) -> Vec<String> {
        self.requests.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Saves the thread's run as it is now (with a spawner whose runs outlive the backend), before
    /// the driver does something that mustn't be done twice, then runs `then` with whether it
    /// could. After a restart, the run is re-attached as of this.
    pub fn persist<S: HarnessSession>(
        &mut self,
        then: impl FnOnce(&mut S, &mut ThreadContext, Result<(), StoreError>) + Send + 'static,
    ) {
        let then: Persisted = Box::new(move |a: &mut Actor, r| a.with_session(move |s: &mut S, c| then(s, c, r)));
        if !self.host.spawner.durable() {
            let _ = self.tx.send(Box::new(move |a: &mut Actor| then(a, Ok(()))));
            return;
        }
        self.waiters.push(Waiter::Persist(then));
        self.flush_queued = true;
    }

    /// Something went wrong that isn't the turn's: for the app's on_error.
    pub fn error(&self, error: Error) {
        (self.host.on_error)(error);
    }

    // ---------- runs ----------

    /// With a durable spawner, the runs to save with the events: the session's running one, if it
    /// changed since it was last saved, and the one before it as ended if that's done.
    fn runs(&self, cp: Option<RunCheckpoint>) -> (Vec<RunRecord>, Option<(RunRecord, String)>) {
        let spawner = &self.host.spawner;
        if !spawner.durable() {
            return (Vec::new(), None);
        }
        let mut runs = Vec::new();
        let now = now_iso();
        let thread = &self.saved.thread;
        let before = self.run.as_ref().map(|(r, _)| r);
        let mut run = self.run.clone();
        if let Some(before) = before
            && Some(&before.id) != cp.as_ref().map(|c| &c.id)
        {
            if before.ended_at.is_none() {
                runs.push(RunRecord {
                    ended_at: Some(now.clone()),
                    ..before.clone()
                });
            }
            run = None;
        }
        // A run that's over is saved once more, as it ended.
        let Some(cp) = cp else { return (runs, run) };
        if before.is_some_and(|b| b.id == cp.id && b.ended_at.is_some()) {
            return (runs, run);
        }
        let mut data = Map::new();
        if let Some(dir) = &cp.dir {
            data.insert("dir".into(), json!(dir));
        }
        if let Some(input) = cp.input {
            data.insert("input".into(), json!(input));
        }
        data.insert("turn".into(), json!(self.turn));
        if let Some(state) = &cp.state {
            data.insert("state".into(), state.clone());
        }
        if let Some(live) = self.live_text() {
            data.insert("live".into(), Value::Object(live));
        }
        // App tools' structured output whose calls the harness hasn't given their result yet.
        if !self.structured.is_empty() {
            data.insert("structured".into(), json!(self.structured));
        }
        let started_at = match (before, &thread.run) {
            (Some(b), _) if b.id == cp.id => b.started_at.clone(),
            (_, Some(r)) if r.id == cp.id && r.started_at.is_some() => r.started_at.clone().unwrap(),
            _ => now.clone(),
        };
        let record = RunRecord {
            id: cp.id.clone(),
            thread_id: self.thread_id.clone(),
            spawner: spawner.name().to_string(),
            offset: Some(cp.offset),
            started_at,
            ended_at: cp.ended.then_some(now),
            data: Some(Value::Object(data)),
            extra: Map::new(),
        };
        let json = serde_json::to_string(&record).unwrap_or_default();
        if self.run.as_ref().map(|(_, j)| j) != Some(&json) {
            runs.push(record.clone());
        }
        (runs, Some((record, json)))
    }

    /// Text streamed into items that the saved events don't have yet (deltas aren't saved), by
    /// item: saved with the run, since the run's output it came from won't be read again.
    fn live_text(&self) -> Option<Map<String, Value>> {
        let mut live = Map::new();
        for id in &self.streaming {
            let now = self
                .state
                .items
                .iter()
                .rev()
                .find(|i| i.id() == id)
                .and_then(Item::streamed_text);
            let saved = self.item(id).and_then(Item::streamed_text);
            if let (Some(now), Some(saved)) = (now, saved)
                && now != saved
            {
                live.insert(id.clone(), json!(now));
            }
        }
        (!live.is_empty()).then_some(live)
    }

    /// The run record saved last, for a backend that re-attached to it, with the text that had
    /// streamed in as of it: shown again, as deltas, before the run's output is read on.
    pub(crate) fn adopt_run(&mut self, record: RunRecord) {
        let json = serde_json::to_string(&record).unwrap_or_default();
        let live = record
            .data
            .as_ref()
            .and_then(|d| d.get("live"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(s) = record
            .data
            .as_ref()
            .and_then(|d| d.get("structured"))
            .and_then(Value::as_object)
        {
            self.structured = s.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        }
        self.run = Some((record, json));
        for (id, text) in live {
            let Some(text) = text.as_str() else { continue };
            let (kind, have) = match self.item(&id) {
                Some(Item::AssistantMessage(m)) => (DeltaEventKind::Text, m.text.clone()),
                Some(Item::Reasoning(r)) => (DeltaEventKind::Reasoning, r.text.clone()),
                _ => continue,
            };
            if let Some(rest) = text.strip_prefix(have.as_str()) {
                self.delta(&id, kind, rest);
            }
        }
    }

    /// A saved-events waiter: resolves once everything so far is saved, or with the store's error.
    pub(crate) fn saved_waiter(&mut self) -> oneshot::Receiver<Result<(), StoreError>> {
        let (tx, rx) = oneshot::channel();
        self.waiters.push(Waiter::Saved(tx));
        self.flush_queued = true;
        rx
    }

    pub(crate) fn emit_value(&mut self, event: Value) {
        self.emit(event);
    }

    pub(crate) fn dispose(&mut self) {
        self.disposed = true;
        self.exit = true;
    }
}

impl Actor {
    /// A thread loaded from `state`, on a new task. Its session is made by `open`.
    pub(crate) fn start(
        host: Arc<Host>,
        state: Snapshot,
        config: ThreadConfig,
        launch: LaunchOptions,
        policy: PermissionPolicy,
        open: impl FnOnce(&ThreadContext) -> Box<dyn HarnessSession>,
    ) -> (mpsc::UnboundedSender<Job>, Actor, mpsc::UnboundedReceiver<Job>) {
        let (tx, rx) = mpsc::unbounded_channel();
        // Messages left queued (by a harness that kept failing, or before a restart) go with the
        // next.
        let queue = state
            .items
            .iter()
            .filter_map(|i| match i {
                Item::UserMessage(m) if m.queued => Some(m.id.clone()),
                _ => None,
            })
            .collect();
        let core = ThreadContext {
            thread_id: state.thread.id.clone(),
            config,
            launch,
            policy,
            host,
            turn: None,
            closing: false,
            lost_run: None,
            reattached_run: None,
            saved: state.clone(),
            state,
            queue,
            requests: Vec::new(),
            always: HashMap::new(),
            unsaved: Vec::new(),
            thread_changed: false,
            flush_queued: false,
            snapshot_due: false,
            failure: None,
            retrying: false,
            backoff_ms: 0,
            run: None,
            streaming: Vec::new(),
            structured: HashMap::new(),
            effects: VecDeque::new(),
            waiters: Vec::new(),
            raw: None,
            tx: tx.clone(),
            disposed: false,
            exit: false,
        };
        let session = open(&core);
        (tx, Actor { core, session }, rx)
    }

    /// Runs the thread's jobs until it's disposed of.
    pub(crate) async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Job>) {
        while let Some(job) = rx.recv().await {
            self.job(job);
            // Jobs that are waiting go in the same batch, whose events are saved together.
            for _ in 0..256 {
                let Ok(job) = rx.try_recv() else { break };
                self.job(job);
            }
            while self.core.flush_queued {
                self.flush().await;
            }
            if self.core.exit {
                break;
            }
        }
    }

    pub(crate) fn job(&mut self, job: Job) {
        job(self);
        self.drain();
    }

    pub(crate) fn with_session<S: HarnessSession>(&mut self, f: impl FnOnce(&mut S, &mut ThreadContext)) {
        if let Some(s) = self.session.as_any_mut().downcast_mut::<S>() {
            f(s, &mut self.core);
        }
    }

    /// Does what the core asked of the session.
    fn drain(&mut self) {
        while let Some(effect) = self.core.effects.pop_front() {
            let (s, c) = (&mut self.session, &mut self.core);
            match effect {
                Effect::Start(m) => s.start(c, m),
                Effect::Steer(m) => s.steer(c, m),
                Effect::CarryOver(m) => s.carry_over(c, m),
                Effect::Interrupt => s.interrupt(c),
                Effect::Release => s.release(c),
                Effect::OptionsChanged => s.options_changed(c),
                Effect::Compact => s.compact(c),
                Effect::ConfigChanged => s.config_changed(c),
            }
        }
    }

    /// Takes the conversation back to before the turn `turn_id`: its items and every later turn's
    /// go, and the session goes where the harness says (see sessions.rs). An error for a turn the
    /// thread hasn't, or one the harness can't rewind to. The caller checks no turn is running.
    pub(crate) fn rewind(&mut self, turn_id: &str) -> Result<(), RewindError> {
        let c = &mut self.core;
        let items = &c.saved.items;
        // The main turns' results, with their places in the items.
        let results: Vec<(usize, &crate::protocol::TurnResult)> = items
            .iter()
            .enumerate()
            .filter_map(|(i, it)| match it {
                Item::TurnResult(r) if r.parent_id.is_none() => Some((i, r)),
                _ => None,
            })
            .collect();
        let Some(index) = results.iter().position(|(_, r)| r.turn_id.as_deref() == Some(turn_id)) else {
            return Err(RewindError(format!("there's no turn {turn_id} in the thread")));
        };
        let sessions: Vec<Option<TurnSession>> = results.iter().map(|(_, r)| r.session.clone()).collect();
        let point = match self.session.rewind_point(&sessions, index) {
            None => {
                return Err(RewindError(format!(
                    "{} threads can't be rewound",
                    c.state.thread.harness
                )));
            }
            Some(p) => p?,
        };
        // The turn and those after it, in the order they ran (a message carried over to a later turn
        // keeps its place in the items, so their order isn't the turns'). What isn't any turn's goes
        // too, after the last turn kept and the first item of one that goes.
        let dropped: HashSet<&str> = results[index..]
            .iter()
            .filter_map(|(_, r)| r.turn_id.as_deref())
            .collect();
        let kept = index.checked_sub(1).map(|k| results[k].0);
        let first = items
            .iter()
            .position(|i| i.turn_id().is_some_and(|t| dropped.contains(t)));
        let after = |i: usize, at: Option<usize>| at.is_none_or(|a| i > a);
        let (indices, gone): (Vec<usize>, Vec<String>) = items
            .iter()
            .enumerate()
            .filter(|(i, it)| match it.turn_id() {
                Some(t) => dropped.contains(t),
                None => after(*i, kept) && after(*i, first),
            })
            .map(|(i, it)| (i, it.id().to_string()))
            .unzip();
        c.queue.retain(|id| !gone.contains(id));
        // A rewind not yet made (resume_at) went back to before a later turn of the same session:
        // with no mark of its own to go to, this one still needs that one made, as the turns since
        // added nothing to the session but the ones it took back are still in it.
        let t = &c.state.thread;
        let resume_at = point.resume_at.or_else(|| {
            (point.session_id.is_some() && point.session_id == t.session_id)
                .then(|| t.resume_at.clone())
                .flatten()
        });
        c.emit(json!({"type": "items.removed", "item_ids": gone, "indices": indices}));
        self.retire();
        let c = &mut self.core;
        c.set_thread(|t| {
            t.session_id = point.session_id;
            t.resume_at = resume_at;
        });
        c.add_item(
            json!({"id": new_id("n"), "type": "notice", "level": "info", "code": "rewind", "text": REWIND_TEXT}),
        );
        Ok(())
    }

    /// The next turn starts a new session. The caller checks no turn is running.
    pub(crate) fn new_session(&mut self) {
        if self.core.state.thread.session_id.is_none() {
            return;
        }
        self.retire();
        let c = &mut self.core;
        c.set_thread(|t| {
            t.session_id = None;
            t.resume_at = None;
        });
        c.add_item(
            json!({"id": new_id("n"), "type": "notice", "level": "info", "code": "session.new", "text": NEW_SESSION_TEXT}),
        );
    }

    /// The harness's session changes (new_session, rewind): what's still going on in the old one
    /// stops. Its running subagents (a background one, with no turn) are stopped and its open
    /// requests cancelled, and its process is retired, so that nothing it says after reaches the
    /// thread (Claude would start a turn of its own when a background subagent ended, in the old
    /// session).
    fn retire(&mut self) {
        let c = &mut self.core;
        let running: Vec<String> = c
            .saved
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
        for id in c.open_request_ids() {
            c.cancel_request(&id);
        }
        if c.turn.is_none() && c.state.thread.status == crate::protocol::ThreadStatus::Waiting {
            c.set_thread(|t| t.status = crate::protocol::ThreadStatus::Idle);
        }
        self.session.retire(c);
    }

    /// Answers an open request; does nothing if it isn't open.
    pub(crate) fn respond(&mut self, request_id: &str, resolution: Resolution) {
        let c = &mut self.core;
        let Some(at) = c.requests.iter().position(|(id, _)| id == request_id) else {
            return;
        };
        let (_, open) = c.requests.remove(at);
        // The answers to secret questions go only to the harness: what's sent and saved hides them.
        c.emit_resolved(request_id, &redact(&open.request, &resolution));
        c.requests_done();
        if resolution.always
            && let Some(standing) = open.standing
            && matches!(resolution.outcome, ResolutionOutcome::Allow | ResolutionOutcome::Deny)
        {
            c.always
                .insert(standing, resolution.outcome == ResolutionOutcome::Allow);
        }
        (open.answered)(self, resolution);
        self.drain();
    }

    /// Appends the unsaved events, then the thread. Events stay unsaved until the store has them,
    /// so a write that fails is tried again (with the events after it), in order, and nothing is
    /// lost or numbered around a gap.
    pub(crate) async fn flush(&mut self) {
        self.core.flush_queued = false;
        let cp = if self.session.durable() {
            self.session.checkpoint(&self.core)
        } else {
            let t = &self.core.saved.thread;
            t.run
                .as_ref()
                .filter(|r| r.spawner.to_string() == self.core.host.spawner.name())
                .map(|r| RunCheckpoint {
                    id: r.id.clone(),
                    offset: 0,
                    dir: None,
                    input: None,
                    state: None,
                    ended: false,
                })
        };
        let c = &mut self.core;
        // Taken at the same moment as the events, so the run's offset and state are as of them.
        let events = c.unsaved.clone();
        let (runs, run) = c.runs(cp);
        let thread_changed = c.thread_changed;
        let store = c.host.store.clone();
        let result: Result<(), StoreError> = async {
            if !events.is_empty() || !runs.is_empty() {
                let values: Vec<Value> = events.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
                match store.append_events(&c.thread_id, &values, &runs).await {
                    Ok(()) => {}
                    // An append reported as failed may have happened anyway: keep only what the
                    // store lacks.
                    Err(e) if e.kind == StoreErrorKind::Seq => {
                        let last = store.last_seq(&c.thread_id).await?;
                        let rest: Vec<Value> = values
                            .into_iter()
                            .filter(|v| v["seq"].as_u64().unwrap_or(0) > last)
                            .collect();
                        if rest.len() == events.len() {
                            return Err(e);
                        }
                        store.append_events(&c.thread_id, &rest, &runs).await?;
                    }
                    Err(e) => return Err(e),
                }
                c.unsaved.drain(..events.len());
                c.run = run;
            }
            if thread_changed {
                c.thread_changed = false;
                if let Err(e) = store.update_thread(&c.stored_thread()).await {
                    c.thread_changed = true;
                    return Err(e);
                }
            }
            Ok(())
        }
        .await;
        match &result {
            Ok(()) => {
                c.failure = None;
                c.backoff_ms = 0;
            }
            Err(e) => {
                c.failure = Some(e.clone());
                c.error(Error::Store(e.clone()));
                self.retry_later();
            }
        }
        let c = &mut self.core;
        let all_saved = c.unsaved.is_empty() && !c.thread_changed;
        if all_saved && c.snapshot_due {
            c.snapshot_due = false;
            let snapshot = serde_json::to_value(&c.saved).unwrap();
            if let Err(e) = store.save_snapshot(&c.thread_id, &snapshot).await {
                c.error(Error::Store(e));
            }
        }
        for w in std::mem::take(&mut self.core.waiters) {
            match w {
                Waiter::Saved(tx) => {
                    let r = if all_saved {
                        Ok(())
                    } else {
                        Err(self
                            .core
                            .failure
                            .clone()
                            .unwrap_or_else(|| StoreError::failed("not saved")))
                    };
                    let _ = tx.send(r);
                }
                Waiter::Persist(then) => {
                    then(self, result.clone());
                    self.drain();
                }
            }
        }
    }

    fn retry_later(&mut self) {
        let c = &mut self.core;
        if c.retrying || c.disposed {
            return;
        }
        c.retrying = true;
        c.backoff_ms = (c.backoff_ms * 2).clamp(250, 30_000);
        let tx = c.tx.clone();
        let after = Duration::from_millis(c.backoff_ms);
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            let _ = tx.send(Box::new(|a: &mut Actor| {
                a.core.retrying = false;
                if !a.core.disposed {
                    a.core.flush_queued = true;
                }
            }));
        });
    }
}

fn cancel() -> Resolution {
    Resolution {
        always: false,
        answers: Default::default(),
        message: None,
        outcome: ResolutionOutcome::Cancel,
        permission_mode: None,
    }
}

/// The notices a rewind and a new session add.
const REWIND_TEXT: &str = "The conversation was rewound to here: the agent doesn't remember what came after.";
const NEW_SESSION_TEXT: &str = "A new conversation starts here: the agent doesn't remember what came before.";

/// What a secret answer is shown as.
pub(crate) const SECRET: &str = "[secret]";

/// A resolution as it may be shown and saved: a secret question's answers replaced with SECRET.
fn redact(request: &ThreadRequest, resolution: &Resolution) -> Resolution {
    let ThreadRequest::Question(q) = request else {
        return resolution.clone();
    };
    let secret: HashSet<&str> = q.questions.iter().filter(|q| q.secret).map(|q| q.id.as_str()).collect();
    let mut out = resolution.clone();
    for (id, a) in out.answers.iter_mut() {
        if secret.contains(id.as_str()) && !a.is_empty() {
            *a = vec![SECRET.to_string()];
        }
    }
    out
}

fn queued_message(m: &UserMessage) -> Message {
    Message {
        id: m.id.clone(),
        text: m.text.clone(),
        attachments: m.attachments.clone(),
    }
}

fn user_item(id: &str, m: &Outgoing, steered: bool) -> Value {
    let mut item = json!({"id": id, "type": "user_message", "text": m.text});
    if !m.attachments.is_empty() {
        item["attachments"] = json!(m.attachments);
    }
    if let Some(c) = m.client_id.as_ref().filter(|c| !c.is_empty()) {
        item["client_id"] = json!(c);
    }
    if steered {
        item["steered"] = json!(true);
        item["queued"] = json!(true);
    }
    item
}

/// a + b, with costs rounded to a picodollar so sums don't drift.
pub(crate) fn add_usage(a: Option<&Usage>, b: Option<&Usage>) -> Option<Usage> {
    let Some(b) = b else { return a.cloned() };
    let Some(a) = a else { return Some(b.clone()) };
    let sum = |x: Option<u64>, y: Option<u64>| match (x, y) {
        (None, None) => None,
        (x, y) => Some(x.unwrap_or(0) + y.unwrap_or(0)),
    };
    Some(Usage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_read_tokens: sum(a.cache_read_tokens, b.cache_read_tokens),
        cache_write_tokens: sum(a.cache_write_tokens, b.cache_write_tokens),
        cost_usd: match (a.cost_usd, b.cost_usd) {
            (None, None) => None,
            (x, y) => Some(round_cost(x.unwrap_or(0.0) + y.unwrap_or(0.0))),
        },
    })
}

/// A cost rounded to a picodollar.
pub(crate) fn round_cost(x: f64) -> f64 {
    (x * 1e12).round() / 1e12
}

impl ThreadContext {
    /// The thread as the store keeps it: with its launch options, which clients aren't sent.
    pub(crate) fn stored_thread(&self) -> Value {
        let mut thread = serde_json::to_value(&self.state.thread).unwrap();
        if !self.launch.is_empty() {
            thread["launch"] = serde_json::to_value(&self.launch).unwrap();
        }
        thread
    }

    /// Changes how the harness process is started, from the next one; it's saved with the thread.
    pub(crate) fn set_launch(&mut self, launch: LaunchOptions) {
        if launch == self.launch {
            return;
        }
        self.launch = launch;
        self.thread_changed = true;
        self.flush_queued = true;
        // Its process is started with them: the next turn needs another.
        self.config_changed();
    }

    /// Saves the thread's run (with a durable spawner) though no event changed.
    pub(crate) fn request_save(&mut self) {
        if self.host.spawner.durable() {
            self.flush_queued = true;
        }
    }

    /// Saves a snapshot with the next save, once everything is saved.
    pub(crate) fn save_snapshot_next(&mut self) {
        self.snapshot_due = true;
        self.flush_queued = true;
    }
}

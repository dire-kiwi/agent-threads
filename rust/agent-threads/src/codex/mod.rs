//! The Codex driver: runs `codex app-server` (JSON-RPC over stdio), one process per thread (started
//! at its first message, kept between turns), and translates its items into the thread's events by
//! the rules in spec/fixtures/README.md. A message is turn/start (or turn/steer while a turn runs);
//! the server's approval and question requests go through the permission policy; the app's tools
//! are dynamic tools answered over item/tool/call, or (where Codex can't take those) a loopback MCP
//! server. With a spawner whose runs outlive the backend, it checkpoints what it needs to carry on
//! reading a run (the JSON-RPC client's pending requests, Codex's open ones, the turn, what it
//! streamed) and re-attaches to it after a restart.

mod home;
mod translate;

use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::agent_threads::Error;
use crate::attachments::{Part, message_parts, path_text};
use crate::claude::{forward_events, last_chars, title};
use crate::harness::{BoxFuture, ControlReply, Harness, HarnessSession, Message, RunCheckpoint, TurnEnd};
use crate::ids::{new_id, now_iso, now_ms, private_temp_dir};
use crate::mcp_http::{LoopbackMcp, ToolServer, serve_tools};
use crate::permissions::{Decided, PermissionDecision, PermissionQuery, permission_key};
use crate::protocol::{DeltaEventKind, Item, Resolution, ResolutionOutcome, ToolKind, ToolStatus};
use crate::skills::write_skills;
use crate::spawner::{ExitStatus, HarnessProcess, ProcessEvent, Signal, SpawnOptions};
use crate::store::RunRecord;
use crate::thread::{SECRET, SessionJob, ThreadContext, Timer};
use crate::tools::{Cancellation, Tool, ToolContext, ToolOutput, run_tool};
use home::{
    SessionState, Totals, default_codex_home, prepare_codex_home, read_session_state, user_codex_home,
    write_session_state,
};
use translate::{
    APP_SERVER, codex_done, codex_policy, codex_rate_limits, codex_tool, codex_usage, is_tool_item, mcp_server_config,
    questions, todos, totals_as_usage,
};

/// How the app's tools reach Codex.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AppTools {
    /// As dynamic tools (experimental in Codex). A Codex that refuses them gets the MCP server.
    #[default]
    Dynamic,
    /// On a loopback MCP server.
    Mcp,
}

/// How the Codex harness runs.
#[derive(Clone, Debug)]
pub struct CodexOptions {
    /// The `codex` binary.
    pub bin: String,
    /// Arguments before Codex's own: e.g. the script, when `bin` is `node`.
    pub bin_args: Vec<String>,
    /// More arguments, after `app-server`.
    pub args: Vec<String>,
    /// Changes to the backend's environment: a value sets a variable, `None` removes it.
    pub env: HashMap<String, Option<String>>,
    /// The app's CODEX_HOME, where Codex keeps the app's sessions (resuming a thread needs them),
    /// so it should last as long as the threads do. `~/.agent-threads/codex` by default.
    pub home: Option<PathBuf>,
    /// The CODEX_HOME whose login (auth.json) is linked into `home` if it has none of its own: the
    /// user's ($CODEX_HOME, or ~/.codex) by default. `None` links none.
    pub login: Option<PathBuf>,
    /// Run with the user's own CODEX_HOME, and so their config, MCP servers and skills. Off by
    /// default: a thread sees only the app's.
    pub user_config: bool,
    /// How the app's tools reach Codex: dynamic tools by default.
    pub app_tools: AppTools,
    /// More config for thread/start (Codex's config.toml keys, dotted), under the driver's own.
    pub config: Map<String, Value>,
    /// How long an interrupted turn has to end before the process is stopped. 10s by default.
    pub stop_grace: Duration,
    /// How long a process has to exit after its input is closed before it's sent SIGTERM. 5s by
    /// default.
    pub close_grace: Duration,
}

impl Default for CodexOptions {
    fn default() -> Self {
        CodexOptions {
            bin: "codex".into(),
            bin_args: Vec::new(),
            args: Vec::new(),
            env: HashMap::new(),
            home: None,
            login: Some(user_codex_home()),
            user_config: false,
            app_tools: AppTools::Dynamic,
            config: Map::new(),
            stop_grace: Duration::from_secs(10),
            close_grace: Duration::from_secs(5),
        }
    }
}

/// The Codex harness, `codex`.
pub fn codex(options: CodexOptions) -> Arc<dyn Harness> {
    Arc::new(CodexHarness(Arc::new(options)))
}

struct CodexHarness(Arc<CodexOptions>);

impl Harness for CodexHarness {
    fn name(&self) -> &str {
        "codex"
    }
    fn open(&self, _ctx: &ThreadContext) -> Box<dyn HarnessSession> {
        Box::new(CodexSession::new(self.0.clone()))
    }
}

/// How long a thread's MCP tools (the app's, on the loopback server) may take: the policy may ask
/// the user.
const APP_TOOL_TIMEOUT_SEC: u64 = 3600;

/// An error response to one of our requests, or the process ending before it was answered.
#[derive(Clone, Debug)]
struct RpcError {
    message: String,
    /// The error response's error object, if it was one.
    error: Option<Value>,
}

type Then = Box<dyn FnOnce(&mut CodexSession, &mut ThreadContext, &str, Result<Value, RpcError>) + Send>;
type TurnFn = Box<dyn FnOnce(&mut CodexSession, &mut ThreadContext, Option<String>) + Send>;
type ReadyFn = Box<dyn FnOnce(&mut CodexSession, &mut ThreadContext, Result<String, String>) + Send>;
type Done = Box<dyn FnOnce(&mut CodexSession, &mut ThreadContext, bool, String) + Send>;

/// A request of ours not yet answered: its method, what the caller noted with it, and what's done
/// with the answer.
struct Pending {
    id: u64,
    method: String,
    meta: Option<Value>,
    then: Then,
    /// The app's (control): its result is passed on as it came, null included.
    raw: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PendingState {
    id: u64,
    method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RpcState {
    next: u64,
    pending: Vec<PendingState>,
}

/// A request of Codex's not yet answered: the turn it came in, the request, and whether we've
/// started on it.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OpenRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn: Option<String>,
    msg: Value,
    /// An app tool it asked to run, which has started running (so isn't run again after a
    /// restart).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    started: bool,
}

/// A message sent (by turn/start or turn/steer), by what Codex echoes when it takes it in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Sent {
    ids: Vec<String>,
    key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Launched {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

/// An MCP tool call running: for an elicitation (which only names its server) and the app's MCP
/// tools.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct McpCall {
    id: String,
    server: String,
    name: String,
    args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

/// What a run's checkpoint holds: what's needed to carry on reading it, as of the offset saved
/// with it. (The same as the Node backend's.)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunState {
    v: u32,
    thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    starting: bool,
    compacting: bool,
    total: Option<Totals>,
    error: Option<String>,
    home: String,
    dynamic: Option<Vec<Value>>,
    mcp_app: bool,
    baseline: Option<Totals>,
    hidden_skills: Vec<String>,
    noticed_servers: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skills_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp: Option<Endpoint>,
    streamed: Vec<String>,
    summary_part: Vec<(String, i64)>,
    children: Vec<(String, String)>,
    last_child: Vec<(String, String)>,
    mcp_calls: Vec<McpCall>,
    open: Vec<(Value, OpenRequest)>,
    asked: Vec<(Value, String)>,
    sent: Vec<Sent>,
    held: Vec<String>,
    rpc: RpcState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launched: Option<Launched>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop_at: Option<u64>,
}

enum Ready {
    Waiting(Vec<ReadyFn>),
    Started(String),
    Failed(String),
}

/// One `codex app-server` process, and what's needed to read it.
struct Run {
    proc: Option<Arc<dyn HarnessProcess>>,
    offset: Option<u64>,
    spawned: bool,
    exited: bool,
    /// Stopped on purpose (to restart), so its end doesn't end the turn.
    retired: bool,
    done: watch::Sender<bool>,
    stderr: VecDeque<String>,
    cancel: Cancellation,
    next: u64,
    pending: Vec<Pending>,
    /// Why requests fail straight away: the process has ended.
    rpc_closed: Option<String>,
    ready: Ready,
    /// Codex's thread: the thread's own, as against its subagents'.
    thread_id: Option<String>,
    /// The Codex turn running on the thread, once its id is known.
    turn_id: Option<String>,
    /// A turn/start (or compaction) was sent and its turn hasn't ended.
    starting: bool,
    turn_waiters: Vec<TurnFn>,
    /// The running turn is a compaction.
    compacting: bool,
    /// The thread's token totals, as Codex last reported them in this run.
    total: Option<Totals>,
    /// The running turn's last error that won't be retried.
    error: Option<String>,
    /// The CODEX_HOME it runs with.
    home: String,
    /// The dynamic tools Codex has for the session (it keeps those it was started with); none if
    /// they aren't known (the session was started elsewhere).
    dynamic: Option<Vec<Value>>,
    /// Some of the app's tools are on the loopback MCP server.
    mcp_app: bool,
    /// Codex's token totals for the session after its last turn, when they're known.
    baseline: Option<Totals>,
    /// Skills Codex found that aren't the app's (the user's, the project's): they're turned off.
    hidden_skills: Vec<String>,
    noticed_servers: bool,
    mcp: Option<LoopbackMcp>,
    /// Where Codex was told the loopback MCP server is.
    mcp_endpoint: Option<Endpoint>,
    skills_dir: Option<PathBuf>,
    streamed: HashSet<String>,
    summary_part: HashMap<String, i64>,
    children: HashMap<String, String>,
    last_child: HashMap<String, String>,
    mcp_calls: Vec<McpCall>,
    open: Vec<(Value, OpenRequest)>,
    asked: Vec<(Value, String)>,
    sent: Vec<Sent>,
    held: HashSet<String>,
    launched: Option<Launched>,
    detached: bool,
}

impl Run {
    fn new() -> Self {
        Run {
            proc: None,
            offset: None,
            spawned: false,
            exited: false,
            retired: false,
            done: watch::Sender::new(false),
            stderr: VecDeque::new(),
            cancel: Cancellation::new(),
            next: 1,
            pending: Vec::new(),
            rpc_closed: None,
            ready: Ready::Waiting(Vec::new()),
            thread_id: None,
            turn_id: None,
            starting: false,
            turn_waiters: Vec::new(),
            compacting: false,
            total: None,
            error: None,
            home: String::new(),
            dynamic: None,
            mcp_app: false,
            baseline: None,
            hidden_skills: Vec::new(),
            noticed_servers: false,
            mcp: None,
            mcp_endpoint: None,
            skills_dir: None,
            streamed: HashSet::new(),
            summary_part: HashMap::new(),
            children: HashMap::new(),
            last_child: HashMap::new(),
            mcp_calls: Vec::new(),
            open: Vec::new(),
            asked: Vec::new(),
            sent: Vec::new(),
            held: HashSet::new(),
            launched: None,
            detached: false,
        }
    }

    fn write(&self, msg: &Value) {
        if !self.exited
            && !self.detached
            && let Some(p) = &self.proc
        {
            p.write(&msg.to_string());
        }
    }

    fn notify(&self, method: &str) {
        if self.rpc_closed.is_none() {
            self.write(&json!({"method": method}));
        }
    }

    /// Answers one of the server's requests.
    fn respond(&self, id: &Value, result: Value) {
        if self.rpc_closed.is_none() {
            self.write(&json!({"id": id, "result": result}));
        }
    }

    fn respond_error(&self, id: &Value, message: &str, code: i64) {
        if self.rpc_closed.is_none() {
            self.write(&json!({"id": id, "error": {"code": code, "message": message}}));
        }
    }

    fn is_open(&self, id: &Value) -> bool {
        self.open.iter().any(|(r, _)| r == id)
    }

    fn take_open(&mut self, id: &Value) -> Option<OpenRequest> {
        let at = self.open.iter().position(|(r, _)| r == id)?;
        Some(self.open.remove(at).1)
    }

    fn open_ids(&self) -> Vec<String> {
        self.open.iter().map(|(id, _)| id_string(id)).collect()
    }

    fn asked(&self, id: &Value) -> Option<String> {
        self.asked.iter().find(|(r, _)| r == id).map(|(_, a)| a.clone())
    }

    fn dynamic_tool(&self, name: &str) -> Option<&Value> {
        self.dynamic.as_ref()?.iter().find(|t| t["name"] == name)
    }

    fn state(&self) -> Option<RunState> {
        Some(RunState {
            v: 1,
            thread_id: self.thread_id.clone()?,
            turn_id: self.turn_id.clone(),
            starting: self.starting,
            compacting: self.compacting,
            total: self.total.clone(),
            error: self.error.clone(),
            home: self.home.clone(),
            dynamic: self.dynamic.clone(),
            mcp_app: self.mcp_app,
            baseline: self.baseline.clone(),
            hidden_skills: self.hidden_skills.clone(),
            noticed_servers: self.noticed_servers,
            skills_dir: self.skills_dir.as_ref().map(|d| d.to_string_lossy().into()),
            mcp: self.mcp_endpoint.clone(),
            streamed: self.streamed.iter().cloned().collect(),
            summary_part: self.summary_part.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            children: self.children.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            last_child: self.last_child.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            mcp_calls: self.mcp_calls.clone(),
            open: self.open.clone(),
            asked: self.asked.clone(),
            sent: self.sent.clone(),
            held: self.held.iter().cloned().collect(),
            rpc: RpcState {
                next: self.next,
                pending: self
                    .pending
                    .iter()
                    .map(|p| PendingState {
                        id: p.id,
                        method: p.method.clone(),
                        meta: p.meta.clone(),
                    })
                    .collect(),
            },
            launched: self.launched.clone(),
            stale: false,
            stop_at: None,
        })
    }

    /// Takes up a checkpoint's state (all but the JSON-RPC client's pending requests, which the
    /// session restores).
    fn restore(&mut self, st: &RunState) {
        self.thread_id = Some(st.thread_id.clone());
        self.turn_id = st.turn_id.clone();
        self.starting = st.starting;
        self.compacting = st.compacting;
        self.total = st.total.clone();
        self.error = st.error.clone();
        self.home = st.home.clone();
        self.dynamic = st.dynamic.clone();
        self.mcp_app = st.mcp_app;
        self.baseline = st.baseline.clone();
        self.hidden_skills = st.hidden_skills.clone();
        self.noticed_servers = st.noticed_servers;
        self.skills_dir = st.skills_dir.as_ref().map(PathBuf::from);
        self.mcp_endpoint = st.mcp.clone();
        self.streamed = st.streamed.iter().cloned().collect();
        self.summary_part = st.summary_part.iter().cloned().collect();
        self.children = st.children.iter().cloned().collect();
        self.last_child = st.last_child.iter().cloned().collect();
        self.mcp_calls = st.mcp_calls.clone();
        self.open = st.open.clone();
        self.asked = st.asked.clone();
        self.sent = st.sent.clone();
        self.held = st.held.iter().cloned().collect();
        self.launched = st.launched.clone();
        self.next = st.rpc.next;
        self.ready = Ready::Started(st.thread_id.clone());
    }

    fn finish(&self) {
        self.done.send_replace(true);
    }
}

/// A request id as the shim's input records compare it: as text.
fn id_string(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

/// Whether Codex still wants something answered.
#[derive(Clone)]
enum Wanted {
    /// One of its requests: not resolved, its turn not over, its run not gone.
    Request {
        run: String,
        id: Value,
        turn: Option<String>,
    },
    /// A call on the loopback MCP server: its turn not over, its run not gone.
    Run { run: String, turn: Option<String> },
}

/// A permission query and what's needed to answer it.
struct Permit {
    run: String,
    request: Option<Value>,
    query: PermissionQuery,
    wanted: Wanted,
    existing: Option<String>,
}

pub(crate) struct CodexSession {
    o: Arc<CodexOptions>,
    runs: HashMap<String, Run>,
    current: Option<String>,
    last: Option<String>,
    stale: bool,
    stop_timer: Option<Timer>,
    stop_at: Option<u64>,
    tmp: Option<PathBuf>,
    closed: bool,
    /// The app's control requests not yet answered: where each answer goes, taken out by whichever
    /// comes first, the answer or the backend letting go of the run.
    controls: Vec<Arc<StdMutex<Option<ControlReply>>>>,
}

/// The app's tools on the loopback MCP server, served from the thread's task.
struct LoopbackTools {
    post: Box<dyn Fn(SessionJob<CodexSession>) -> bool + Send + Sync>,
    run: String,
}

#[async_trait]
impl ToolServer for LoopbackTools {
    async fn tools(&self) -> Vec<Value> {
        let (tx, rx) = oneshot::channel();
        let run = self.run.clone();
        (self.post)(Box::new(move |s, ctx| {
            let list = s.runs.get(&run).map(|r| mcp_tools(ctx, r)).unwrap_or_default();
            let _ = tx.send(list.iter().map(|t| tool_spec(t.as_ref())).collect());
        }));
        rx.await.unwrap_or_default()
    }

    async fn call(&self, name: String, args: Value) -> ToolOutput {
        let (tx, rx) = oneshot::channel();
        let run = self.run.clone();
        (self.post)(Box::new(move |s, ctx| s.mcp_app_tool(ctx, &run, name, args, tx)));
        rx.await
            .unwrap_or_else(|_| ToolOutput::error("The tool call was cancelled."))
    }
}

/// A tool as Codex has it as a dynamic tool.
fn tool_spec(t: &dyn Tool) -> Value {
    json!({"name": t.name(), "description": t.description(), "inputSchema": t.input_schema()})
}

/// The app's tools that go on the MCP server: those the session hasn't as dynamic tools, as they
/// are now.
fn mcp_tools(ctx: &ThreadContext, run: &Run) -> Vec<Arc<dyn Tool>> {
    ctx.config()
        .tools
        .iter()
        .filter(|t| run.dynamic_tool(t.name()) != Some(&tool_spec(t.as_ref())))
        .cloned()
        .collect()
}

impl CodexSession {
    fn new(o: Arc<CodexOptions>) -> Self {
        CodexSession {
            o,
            runs: HashMap::new(),
            current: None,
            last: None,
            stale: false,
            stop_timer: None,
            stop_at: None,
            tmp: None,
            closed: false,
            controls: Vec::new(),
        }
    }

    fn run(&mut self, id: &str) -> Option<&mut Run> {
        self.runs.get_mut(id)
    }

    fn live_id(&self) -> Option<String> {
        let id = self.current.as_ref()?;
        let run = self.runs.get(id)?;
        (!run.exited && !run.retired).then(|| id.clone())
    }

    fn dir(&mut self) -> std::io::Result<PathBuf> {
        if self.tmp.is_none() {
            self.tmp = Some(private_temp_dir()?);
        }
        Ok(self.tmp.clone().unwrap())
    }

    fn notice(&self, ctx: &mut ThreadContext, text: &str) {
        ctx.add_item(json!({"id": new_id("n"), "type": "notice", "level": "warning", "text": text}));
    }

    // ---------- JSON-RPC ----------

    /// Sends a request; `then` gets its answer (as a job, if the process has gone already).
    fn request(
        &mut self,
        ctx: &ThreadContext,
        run: &str,
        method: &str,
        params: Value,
        meta: Option<Value>,
        then: Then,
    ) {
        self.send_request(ctx, run, method, params, meta, then, false);
    }

    /// Sends a request; `raw` passes its result on as it came (a null one too), for the app's.
    #[allow(clippy::too_many_arguments)]
    fn send_request(
        &mut self,
        ctx: &ThreadContext,
        run: &str,
        method: &str,
        params: Value,
        meta: Option<Value>,
        then: Then,
        raw: bool,
    ) {
        let fail = |message: String, then: Then| {
            let run = run.to_string();
            ctx.post::<CodexSession>(move |s, ctx| then(s, ctx, &run, Err(RpcError { message, error: None })));
        };
        let Some(r) = self.runs.get_mut(run) else {
            return fail("the run has gone".into(), then);
        };
        if let Some(closed) = r.rpc_closed.clone() {
            return fail(closed, then);
        }
        let id = r.next;
        r.next += 1;
        r.pending.push(Pending {
            id,
            method: method.to_string(),
            meta,
            then,
            raw,
        });
        r.write(&if params.is_null() {
            json!({"id": id, "method": method})
        } else {
            json!({"id": id, "method": method, "params": params})
        });
    }

    /// Takes a response to one of our requests; whether it was one.
    fn take_response(&mut self, ctx: &mut ThreadContext, run: &str, msg: &Value) -> bool {
        if msg.get("method").is_some() || msg.get("id").is_none() {
            return false;
        }
        let Some(r) = self.runs.get_mut(run) else { return true };
        let Some(at) = r.pending.iter().position(|p| msg["id"].as_u64() == Some(p.id)) else {
            return true;
        };
        let p = r.pending.remove(at);
        let result = if msg.get("error").is_some_and(|e| !e.is_null()) {
            let message = msg["error"]["message"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("{} failed", p.method));
            Err(RpcError {
                message,
                error: msg.get("error").cloned(),
            })
        } else {
            Ok(match msg.get("result") {
                Some(r) if p.raw => r.clone(),
                None if p.raw => Value::Null,
                Some(Value::Null) | None => json!({}),
                Some(r) => r.clone(),
            })
        };
        (p.then)(self, ctx, run, result);
        true
    }

    // ---------- turns ----------

    fn when_ready(&mut self, ctx: &mut ThreadContext, run: &str, f: ReadyFn) {
        let Some(r) = self.runs.get_mut(run) else {
            return f(self, ctx, Err("the run has gone".into()));
        };
        match &mut r.ready {
            Ready::Waiting(w) => w.push(f),
            Ready::Started(t) => {
                let t = t.clone();
                f(self, ctx, Ok(t));
            }
            Ready::Failed(e) => {
                let e = e.clone();
                f(self, ctx, Err(e));
            }
        }
    }

    fn set_ready(&mut self, ctx: &mut ThreadContext, run: &str, result: Result<String, String>) {
        let Some(r) = self.runs.get_mut(run) else { return };
        let ready = match &result {
            Ok(t) => Ready::Started(t.clone()),
            Err(e) => Ready::Failed(e.clone()),
        };
        let Ready::Waiting(waiters) = std::mem::replace(&mut r.ready, ready) else {
            return;
        };
        for f in waiters {
            f(self, ctx, result.clone());
        }
    }

    /// Calls `f` with the running turn's id once it's known, or none if none is coming.
    fn with_turn(&mut self, ctx: &mut ThreadContext, run: &str, f: TurnFn) {
        let Some(r) = self.runs.get_mut(run) else {
            return f(self, ctx, None);
        };
        if let Some(t) = r.turn_id.clone() {
            f(self, ctx, Some(t));
        } else if r.starting && !r.exited {
            r.turn_waiters.push(f);
        } else {
            f(self, ctx, None);
        }
    }

    fn set_turn(&mut self, ctx: &mut ThreadContext, run: &str, turn: String) {
        let Some(r) = self.runs.get_mut(run) else { return };
        r.turn_id = Some(turn.clone());
        for f in std::mem::take(&mut r.turn_waiters) {
            f(self, ctx, Some(turn.clone()));
        }
    }

    fn turn_ended(&mut self, ctx: &mut ThreadContext, run: &str) {
        let Some(r) = self.runs.get_mut(run) else { return };
        r.turn_id = None;
        r.starting = false;
        r.compacting = false;
        for f in std::mem::take(&mut r.turn_waiters) {
            f(self, ctx, None);
        }
    }

    /// Messages as a turn's input: their text and attachments, one after the other.
    fn input(&mut self, ctx: &ThreadContext, messages: &[Message]) -> Vec<Value> {
        let mut input = Vec::new();
        let mut errors = Vec::new();
        for m in messages {
            let mut dir = || self.dir();
            for p in message_parts(m, &mut dir, &mut errors) {
                input.push(match p {
                    Part::Text(text) => json!({"type": "text", "text": text, "text_elements": []}),
                    Part::Image { media_type, data } => json!({"type": "image", "url": format!("data:{media_type};base64,{data}")}),
                    Part::Path { image: true, path, .. } => json!({"type": "localImage", "path": path}),
                    Part::Path { path, name, media_type, written, .. } => {
                        json!({"type": "text", "text": path_text(&path, &name, media_type.as_deref(), written), "text_elements": []})
                    }
                });
            }
        }
        for e in errors {
            ctx.error(Error::Other(e));
        }
        input
    }

    /// Starts a Codex turn with the messages.
    fn turn_start(&mut self, ctx: &mut ThreadContext, run: &str, messages: &[Message]) {
        let input = self.input(ctx, messages);
        let sent = self.sent(run, messages.iter().map(|m| m.id.clone()).collect(), &input);
        if let Some(r) = self.run(run) {
            r.starting = true;
        }
        let effort = ctx.thread().effort.clone();
        self.when_ready(
            ctx,
            run,
            Box::new(move |s, ctx, ready| {
                let run = match s.runs.iter().find(|(_, r)| r.sent.contains(&sent)) {
                    Some((id, _)) => id.clone(),
                    None => s.current.clone().unwrap_or_default(),
                };
                let thread_id = match ready {
                    Ok(t) => t,
                    Err(e) => {
                        s.refused(&run, &sent);
                        return s.turn_failed(ctx, &run, &e);
                    }
                };
                let mut params = json!({"threadId": thread_id, "input": input});
                if let Some(e) = effort {
                    params["effort"] = json!(e);
                }
                let meta = json!({"sent": sent});
                s.request(ctx, &run, "turn/start", params, Some(meta), turn_started(sent));
            }),
        );
    }

    /// Messages are being sent to the process, as this input.
    fn sent(&mut self, run: &str, ids: Vec<String>, input: &[Value]) -> Sent {
        let sent = Sent {
            ids,
            key: echo_key(&Value::Array(input.to_vec())),
        };
        if let Some(r) = self.run(run) {
            r.sent.push(sent.clone());
            r.held.extend(sent.ids.iter().cloned());
        }
        sent
    }

    /// Codex refused messages it was sent.
    fn refused(&mut self, run: &str, sent: &Sent) {
        let Some(r) = self.run(run) else { return };
        if let Some(at) = r.sent.iter().position(|s| s == sent) {
            r.sent.remove(at);
        }
        for id in &sent.ids {
            if !r.sent.iter().any(|s| s.ids.contains(id)) {
                r.held.remove(id);
            }
        }
    }

    /// A turn couldn't be started: it ends with the error.
    fn turn_failed(&mut self, ctx: &mut ThreadContext, run: &str, error: &str) {
        if self.runs.get(run).is_none_or(|r| r.exited || r.retired) || self.current.as_deref() != Some(run) {
            return;
        }
        self.turn_ended(ctx, run);
        if ctx.turn_id().is_some() {
            let live = self.live_id().is_some();
            ctx.end_turn(
                TurnEnd {
                    ok: false,
                    error: Some(error.to_string()),
                    ..Default::default()
                },
                live,
            );
        }
    }

    // ---------- the process ----------

    fn ensure(&mut self, ctx: &mut ThreadContext, fresh: bool) -> String {
        let live = self.live_id();
        if let Some(live) = &live
            && !(fresh && self.stale)
        {
            return live.clone();
        }
        if let Some(live) = live {
            self.stop(ctx, &live, true, false);
        }
        self.stale = false;
        let id = new_id("run");
        self.runs.insert(id.clone(), Run::new());
        self.current = Some(id.clone());
        self.spawn_waiting(ctx);
        id
    }

    fn spawn_waiting(&mut self, ctx: &mut ThreadContext) {
        let Some(id) = self.current.clone() else { return };
        if self.runs.get(&id).is_none_or(|r| r.spawned) {
            return;
        }
        if self.runs.values().any(|r| r.retired && !r.exited) {
            return;
        }
        self.runs.get_mut(&id).unwrap().spawned = true;
        self.spawn(ctx, &id);
    }

    fn stop(&mut self, ctx: &mut ThreadContext, id: &str, retire: bool, now: bool) {
        let grace = self.o.close_grace;
        let Some(run) = self.run(id) else { return };
        if retire {
            run.retired = true;
        }
        if run.exited {
            return;
        }
        let Some(proc) = run.proc.clone() else {
            if !run.spawned {
                run.spawned = true;
                run.exited = true;
                run.finish();
                self.set_ready(ctx, id, Err("the session is closed".into()));
            }
            return;
        };
        if proc.stop(grace, now) {
            return;
        }
        proc.close_input();
        if now {
            proc.kill(Signal::Term);
        }
        for (after, signal) in [(grace, Signal::Term), (grace * 2, Signal::Kill)] {
            let id = id.to_string();
            ctx.timer::<CodexSession>(after, move |s, _| {
                if let Some(r) = s.runs.get(&id)
                    && !r.exited
                    && let Some(p) = &r.proc
                {
                    p.kill(signal);
                }
            });
        }
    }

    fn stop_after(&mut self, ctx: &mut ThreadContext, id: &str, after: Duration) {
        let turn = ctx.turn_id().map(String::from);
        self.clear_stop();
        self.stop_at = Some(now_ms() + after.as_millis() as u64);
        let id = id.to_string();
        self.stop_timer = Some(ctx.timer::<CodexSession>(after, move |s, ctx| {
            s.stop_at = None;
            if ctx.turn_id().map(String::from) == turn && s.runs.get(&id).is_some_and(|r| !r.exited) {
                s.stop(ctx, &id, false, false);
            }
        }));
    }

    fn clear_stop(&mut self) {
        if let Some(t) = self.stop_timer.take() {
            t.cancel();
        }
        self.stop_at = None;
    }

    /// Starts the process and the thread: initialize, skills, thread/start or thread/resume.
    fn spawn(&mut self, ctx: &mut ThreadContext, id: &str) {
        if self.closed || self.runs.get(id).is_none_or(|r| r.retired) {
            if let Some(r) = self.run(id) {
                r.exited = true;
                r.finish();
            }
            return self.set_ready(ctx, id, Err("the session is closed".into()));
        }
        let o = self.o.clone();
        let home = if o.user_config {
            Ok(user_codex_home())
        } else {
            prepare_codex_home(&o.home.clone().unwrap_or_else(default_codex_home), o.login.as_deref())
        };
        let home = match home {
            Ok(h) => h,
            Err(e) => return self.spawn_failed(ctx, id, e.to_string()),
        };
        let mut env: HashMap<String, String> = std::env::vars().collect();
        for (k, v) in &o.env {
            match v {
                Some(v) => env.insert(k.clone(), v.clone()),
                None => env.remove(k),
            };
        }
        env.insert("CODEX_HOME".into(), home.to_string_lossy().into());
        let options = SpawnOptions {
            command: o.bin.clone(),
            args: o
                .bin_args
                .iter()
                .cloned()
                .chain(["app-server".to_string()])
                .chain(o.args.iter().cloned())
                .collect(),
            cwd: ctx.thread().cwd.as_ref().map(PathBuf::from),
            env,
            thread_id: ctx.thread_id().to_string(),
            run_id: id.to_string(),
        };
        let (proc, rx) = match ctx.spawner().spawn(options) {
            Ok(p) => p,
            Err(e) => return self.spawn_failed(ctx, id, e.to_string()),
        };
        let t = ctx.thread();
        let launched = Launched {
            model: t.model.clone(),
            effort: t.effort.clone(),
            permission_mode: t.permission_mode.map(|m| m.to_string()),
        };
        let run = self.run(id).unwrap();
        run.proc = Some(proc);
        run.launched = Some(launched);
        forward_events::<CodexSession>(ctx, id, rx, |s, ctx, id, e| s.event(ctx, id, e));
        let spawner = ctx.spawner().name().to_string();
        let run_id = id.to_string();
        ctx.set_thread(|t| {
            t.run = serde_json::from_value(json!({"id": run_id, "spawner": spawner, "started_at": now_iso()})).ok();
        });
        let params = json!({
            "clientInfo": {"name": "agent-threads", "title": "agent-threads", "version": "0.0.0"},
            "capabilities": {"experimentalApi": true},
        });
        let home = home.to_string_lossy().to_string();
        self.request(
            ctx,
            id,
            "initialize",
            params,
            None,
            Box::new(move |s, ctx, run, r| match r {
                Err(e) => s.start_failed(ctx, run, e.message),
                Ok(_) => s.initialized(ctx, run, home),
            }),
        );
    }

    fn spawn_failed(&mut self, ctx: &mut ThreadContext, id: &str, error: String) {
        self.exited(
            ctx,
            id,
            ExitStatus {
                error: Some(error.clone()),
                ..Default::default()
            },
        );
        self.set_ready(ctx, id, Err(error));
    }

    fn initialized(&mut self, ctx: &mut ThreadContext, run: &str, home: String) {
        let Some(r) = self.run(run) else { return };
        r.notify("initialized");
        let skills = ctx.config().skills.clone();
        if skills.is_empty() {
            return self.after_skills(ctx, run, home);
        }
        let written = self
            .dir()
            .and_then(|d| write_skills(&d.join(format!("skills-{run}")), &skills));
        match written {
            Ok(dir) => {
                self.run(run).unwrap().skills_dir = Some(dir.clone());
                self.request(
                    ctx,
                    run,
                    "skills/extraRoots/set",
                    json!({"extraRoots": [dir.to_string_lossy()]}),
                    None,
                    Box::new(move |s, ctx, run, r| {
                        if let Err(e) = r {
                            s.notice(ctx, &format!("Codex couldn't load the app's skills: {}", e.message));
                        }
                        s.after_skills(ctx, run, home);
                    }),
                );
            }
            Err(e) => {
                self.notice(ctx, &format!("Codex couldn't load the app's skills: {e}"));
                self.after_skills(ctx, run, home);
            }
        }
    }

    fn after_skills(&mut self, ctx: &mut ThreadContext, run: &str, home: String) {
        let Some(r) = self.run(run) else { return };
        r.home = home;
        if self.o.user_config {
            return self.start_thread(ctx, run);
        }
        // The skills Codex finds that aren't the app's: the user's ($HOME/.agents/skills...), the
        // project's and the machine's, which a separate CODEX_HOME doesn't keep it from loading.
        // (Its own built-in ones stay.)
        let cwds: Vec<Value> = ctx.thread().cwd.iter().map(|c| json!(c)).collect();
        self.request(
            ctx,
            run,
            "skills/list",
            json!({"cwds": cwds, "forceReload": true}),
            None,
            Box::new(|s, ctx, run, r| match r {
                Err(e) => s.start_failed(
                    ctx,
                    run,
                    format!("Codex couldn't list its skills, to leave out the user's: {}", e.message),
                ),
                Ok(r) => {
                    let Some(run_state) = s.run(run) else { return };
                    // Codex reports paths with symlinks resolved, so the app's are told apart by
                    // their real paths.
                    let own = run_state.skills_dir.as_ref().map(|d| canonical(d));
                    let mut paths: Vec<String> = Vec::new();
                    for e in r["data"].as_array().into_iter().flatten() {
                        for sk in e["skills"].as_array().into_iter().flatten() {
                            let Some(path) = sk["path"].as_str() else { continue };
                            if sk["scope"] == "system"
                                || own.as_ref().is_some_and(|o| canonical(Path::new(path)).starts_with(o))
                            {
                                continue;
                            }
                            if !paths.iter().any(|p| p == path) {
                                paths.push(path.to_string());
                            }
                        }
                    }
                    run_state.hidden_skills = paths;
                    s.start_thread(ctx, run);
                }
            }),
        );
    }

    /// thread/resume for a thread that has a session, or thread/start (also if Codex hasn't the
    /// session).
    fn start_thread(&mut self, ctx: &mut ThreadContext, run: &str) {
        let Some(session) = ctx.thread().session_id.clone() else {
            return self.new_thread(ctx, run);
        };
        let r = self.run(run).unwrap();
        // Codex keeps the dynamic tools the session started with, and resuming can't change them.
        let state = read_session_state(Path::new(&r.home), &session);
        r.dynamic = state.as_ref().map(|s| s.dynamic_tools.clone());
        r.baseline = state.and_then(|s| s.totals);
        let mut params = match self.thread_params(ctx, run, false) {
            Ok(p) => p,
            Err(e) => return self.start_failed(ctx, run, e),
        };
        params["threadId"] = json!(session);
        params["excludeTurns"] = json!(true);
        self.request(
            ctx,
            run,
            "thread/resume",
            params,
            None,
            Box::new(|s, ctx, run, r| match r {
                Ok(r) => s.thread_started(ctx, run, &r),
                Err(e) => {
                    let m = e.message.to_lowercase();
                    if !["not found", "no rollout", "unknown thread", "does not exist"].iter().any(|x| m.contains(x)) {
                        return s.start_failed(ctx, run, e.message);
                    }
                    let text = format!(
                        "Codex couldn't resume its session ({}), so this is a new one: it doesn't remember the thread so far.",
                        e.message
                    );
                    s.notice(ctx, &text);
                    s.new_thread(ctx, run);
                }
            }),
        );
    }

    /// thread/start: a new session, with the app's tools as dynamic tools (or on the MCP server).
    fn new_thread(&mut self, ctx: &mut ThreadContext, run: &str) {
        let dynamic: Vec<Value> = if self.o.app_tools == AppTools::Mcp {
            Vec::new()
        } else {
            ctx.config().tools.iter().map(|t| tool_spec(t.as_ref())).collect()
        };
        self.run(run).unwrap().dynamic = Some(dynamic);
        let params = match self.thread_params(ctx, run, true) {
            Ok(p) => p,
            Err(e) => return self.start_failed(ctx, run, e),
        };
        self.request(
            ctx,
            run,
            "thread/start",
            params,
            None,
            Box::new(|s, ctx, run, r| match r {
                Ok(r) => s.new_thread_started(ctx, run, &r),
                Err(e) => {
                    let has_dynamic = s
                        .runs
                        .get(run)
                        .and_then(|r| r.dynamic.as_ref())
                        .is_some_and(|d| !d.is_empty());
                    if !has_dynamic || !mentions_dynamic_tools(&e.message) {
                        return s.start_failed(ctx, run, e.message);
                    }
                    // A Codex without dynamic tools gets the app's tools on the MCP server instead.
                    s.run(run).unwrap().dynamic = Some(Vec::new());
                    let params = match s.thread_params(ctx, run, true) {
                        Ok(p) => p,
                        Err(e) => return s.start_failed(ctx, run, e),
                    };
                    s.request(
                        ctx,
                        run,
                        "thread/start",
                        params,
                        None,
                        Box::new(|s, ctx, run, r| match r {
                            Ok(r) => s.new_thread_started(ctx, run, &r),
                            Err(e) => s.start_failed(ctx, run, e.message),
                        }),
                    );
                }
            }),
        );
    }

    fn new_thread_started(&mut self, ctx: &mut ThreadContext, run: &str, r: &Value) {
        let Some(rs) = self.run(run) else { return };
        // A new session's totals start at nothing.
        rs.baseline = Some(Totals {
            cache_write_input_tokens: Some(0),
            ..Default::default()
        });
        if let Some(t) = r["thread"]["id"].as_str() {
            self.save_state(ctx, run, t);
        }
        self.thread_started(ctx, run, r);
    }

    fn thread_started(&mut self, ctx: &mut ThreadContext, run: &str, r: &Value) {
        let Some(thread_id) = r["thread"]["id"].as_str().map(String::from) else {
            return self.start_failed(ctx, run, "Codex didn't say which thread it started".into());
        };
        self.run(run).unwrap().thread_id = Some(thread_id.clone());
        if ctx.thread().session_id.as_deref() != Some(thread_id.as_str()) {
            let sid = thread_id.clone();
            ctx.set_thread(|t| t.session_id = Some(sid));
        }
        self.set_ready(ctx, run, Ok(thread_id));
    }

    /// The thread can't run: the process is stopped (and its end ends nothing), and the turn ends
    /// with why.
    fn start_failed(&mut self, ctx: &mut ThreadContext, run: &str, error: String) {
        let ours = self.runs.get(run).is_some_and(|r| !r.exited && !r.retired) && self.current.as_deref() == Some(run);
        if ours {
            self.stop(ctx, run, true, true);
            if ctx.turn_id().is_some() {
                let live = self.live_id().is_some();
                ctx.end_turn(
                    TurnEnd {
                        ok: false,
                        error: Some(format!("Codex couldn't start the thread: {error}")),
                        ..Default::default()
                    },
                    live,
                );
            }
        }
        self.set_ready(ctx, run, Err(error));
    }

    /// Records the session's dynamic tools and totals, where they're known.
    fn save_state(&self, ctx: &ThreadContext, run: &str, session: &str) {
        let Some(r) = self.runs.get(run) else { return };
        let Some(dynamic) = &r.dynamic else { return };
        let state = SessionState {
            dynamic_tools: dynamic.clone(),
            totals: r.baseline.clone(),
        };
        if let Err(e) = write_session_state(Path::new(&r.home), session, &state) {
            ctx.error(Error::Other(format!("Codex's session state couldn't be saved: {e}")));
        }
    }

    /// thread/start's (`fresh`) or thread/resume's parameters.
    fn thread_params(&mut self, ctx: &mut ThreadContext, run: &str, fresh: bool) -> Result<Value, String> {
        let config = ctx.config().clone();
        let t = ctx.thread().clone();
        let mut servers = Map::new();
        let noticed = self.runs.get(run).is_some_and(|r| r.noticed_servers);
        for (name, s) in &config.mcp_servers {
            match mcp_server_config(s) {
                Ok(c) => {
                    servers.insert(name.clone(), c);
                }
                Err(why) if !noticed => self.notice(ctx, &format!("The MCP server {name} isn't available: {why}.")),
                Err(_) => {}
            }
        }
        let post: Box<dyn Fn(_) -> bool + Send + Sync> = Box::new(ctx.poster::<CodexSession>());
        let base_config = self.o.config.clone();
        let r = self.run(run).unwrap();
        r.noticed_servers = true;
        r.mcp_app = !mcp_tools(ctx, r).is_empty();
        if r.mcp_app {
            if r.mcp.is_none() {
                let server = Arc::new(LoopbackTools {
                    post,
                    run: run.to_string(),
                });
                let mcp = serve_tools(APP_SERVER, server, None)
                    .map_err(|e| format!("the app's tools couldn't be served: {e}"))?;
                r.mcp_endpoint = Some(Endpoint {
                    port: mcp.port,
                    token: mcp.token.clone(),
                });
                r.mcp = Some(mcp);
            }
            let mcp = r.mcp.as_ref().unwrap();
            // The policy decides on the app's tools when they're called, so Codex needn't ask.
            servers.insert(
                APP_SERVER.into(),
                json!({
                    "url": mcp.url(),
                    "http_headers": {"Authorization": format!("Bearer {}", mcp.token)},
                    "default_tools_approval_mode": "approve",
                    "tool_timeout_sec": APP_TOOL_TIMEOUT_SEC,
                }),
            );
        }
        let mut cfg = base_config;
        // So the agent can ask the user questions outside plan mode.
        cfg.insert("features.default_mode_request_user_input".into(), json!(true));
        cfg.insert("suppress_unstable_features_warning".into(), json!(true));
        if !servers.is_empty() {
            cfg.insert("mcp_servers".into(), Value::Object(servers));
        }
        if !r.hidden_skills.is_empty() {
            let skills: Vec<Value> = r
                .hidden_skills
                .iter()
                .map(|p| json!({"path": p, "enabled": false}))
                .collect();
            cfg.insert("skills".into(), json!({"config": skills}));
        }
        let (approval, sandbox) = codex_policy(t.permission_mode);
        let mut params = json!({"approvalPolicy": approval, "sandbox": sandbox, "config": cfg});
        if let Some(cwd) = &t.cwd {
            params["cwd"] = json!(cwd);
        }
        if let Some(m) = &t.model {
            params["model"] = json!(m);
        }
        let dynamic = if fresh {
            r.dynamic.clone().unwrap_or_default()
        } else {
            Vec::new()
        };
        if !dynamic.is_empty() {
            let tools: Vec<Value> = dynamic
                .into_iter()
                .map(|mut d| {
                    d["type"] = json!("function");
                    d
                })
                .collect();
            params["dynamicTools"] = Value::Array(tools);
        }
        if let Some(p) = &config.system_prompt {
            params["developerInstructions"] = json!(p);
        }
        Ok(params)
    }

    fn exited(&mut self, ctx: &mut ThreadContext, id: &str, status: ExitStatus) {
        let Some(run) = self.runs.get_mut(id) else { return };
        if run.exited || run.detached {
            return;
        }
        run.exited = true;
        run.spawned = true;
        run.cancel.cancel();
        let message = exit_error(&status, &run.stderr, false);
        run.rpc_closed = Some(message.clone());
        // Requests still waiting fail, after this.
        for p in std::mem::take(&mut run.pending) {
            let (run_id, message) = (id.to_string(), message.clone());
            ctx.post::<CodexSession>(move |s, ctx| (p.then)(s, ctx, &run_id, Err(RpcError { message, error: None })));
        }
        if let Some(mcp) = run.mcp.take() {
            mcp.close();
        }
        if let Some(dir) = &run.skills_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        let retired = run.retired;
        let error = exit_error(&status, &run.stderr, true);
        self.turn_ended(ctx, id);
        if self.current.as_deref() == Some(id) {
            self.current = None;
            if let Some(last) = self.last.replace(id.to_string())
                && last != id
            {
                self.runs.remove(&last);
            }
        }
        if ctx.thread().run.as_ref().is_some_and(|r| r.id == id) {
            ctx.set_thread(|t| t.run = None);
        }
        // A run that ends while its turn is running ends the turn (as interrupted, if it was).
        if !retired && ctx.turn_id().is_some() {
            self.clear_stop();
            let live = self.live_id().is_some();
            ctx.end_turn(
                TurnEnd {
                    ok: false,
                    error: Some(error),
                    ..Default::default()
                },
                live,
            );
        }
        if let Some(run) = self.runs.get(id) {
            run.finish();
        }
        let ready_error = message;
        self.set_ready(ctx, id, Err(ready_error));
        let keep = [self.current.clone(), self.last.clone()];
        self.runs
            .retain(|rid, r| !r.exited || keep.iter().any(|k| k.as_deref() == Some(rid)));
        self.spawn_waiting(ctx);
    }

    // ---------- what Codex says ----------

    fn event(&mut self, ctx: &mut ThreadContext, id: &str, event: ProcessEvent) {
        match event {
            ProcessEvent::Line { line, end } => {
                let Some(run) = self.run(id) else { return };
                if run.detached {
                    return;
                }
                if end.is_some() {
                    run.offset = end;
                }
                let m = serde_json::from_str::<Value>(&line).ok();
                ctx.from_harness(id, &line, m, |ctx, m| self.line(ctx, id, m));
            }
            ProcessEvent::Stderr(line) => {
                if let Some(run) = self.run(id) {
                    run.stderr.push_back(line);
                    if run.stderr.len() > 20 {
                        run.stderr.pop_front();
                    }
                }
            }
            ProcessEvent::CaughtUp => {
                if let Some(run) = self.run(id)
                    && let Some(p) = &run.proc
                {
                    p.retire(&run.open_ids());
                }
            }
            ProcessEvent::Exit(status) => self.exited(ctx, id, status),
        }
    }

    /// A line of Codex's output, parsed (none if it isn't JSON).
    fn line(&mut self, ctx: &mut ThreadContext, id: &str, m: Option<&Value>) {
        // Not a message: the app server writes only JSON-RPC to stdout, but be safe.
        let Some(m) = m.filter(|m| m.is_object()) else {
            return;
        };
        let m = m.clone();
        if self.take_response(ctx, id, &m) {
            return;
        }
        let run = self.runs.get(id).unwrap();
        if run.retired || self.current.as_deref() != Some(id) {
            // A run being stopped: its requests go unanswered.
            if let Some(rid) = m.get("id") {
                run.respond_error(rid, "this session is being stopped", -32000);
            }
            return;
        }
        if let Some(rid) = m.get("id") {
            // A request read again after a restart, and answered before it (though that wasn't
            // saved): Codex has its answer, and the user isn't asked again.
            if run.proc.as_ref().is_some_and(|p| p.answered(&id_string(rid))) {
                return;
            }
            self.server_request(ctx, id, m, None);
        } else {
            self.notification(ctx, id, &m);
        }
    }

    /// The subagent call a message from a child thread belongs to: `Some(None)` for the thread's
    /// own, `None` for a thread it doesn't know.
    fn parent(&self, run: &str, thread: &Value) -> Option<Option<String>> {
        let r = self.runs.get(run)?;
        match (thread.as_str(), &r.thread_id) {
            (Some(t), Some(own)) if t != own => r.children.get(t).map(|c| Some(c.clone())),
            _ => Some(None),
        }
    }

    fn notification(&mut self, ctx: &mut ThreadContext, run: &str, m: &Value) {
        let p = &m["params"];
        let Some(parent) = self.parent(run, &p["threadId"]) else {
            return;
        };
        let own = parent.is_none();
        let child = if own {
            None
        } else {
            p["threadId"].as_str().map(String::from)
        };
        match m["method"].as_str().unwrap_or("") {
            method @ ("item/started" | "item/completed") => {
                self.item(ctx, run, &p["item"], method == "item/completed", parent, child);
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                self.delta(
                    ctx,
                    run,
                    p["itemId"].as_str().unwrap_or(""),
                    DeltaEventKind::Text,
                    &p["delta"],
                    parent.as_deref(),
                );
            }
            "item/reasoning/summaryTextDelta" => {
                // Summary parts are joined by a blank line, as the completed item's text is.
                let item_id = p["itemId"].as_str().unwrap_or("");
                let r = self.run(run).unwrap();
                let part = r.summary_part.get(item_id).copied();
                let index = p["summaryIndex"].as_i64();
                let has_delta = p["delta"].as_str().is_some_and(|d| !d.is_empty());
                if let (Some(part), Some(index)) = (part, index)
                    && index > part
                    && has_delta
                {
                    self.delta(
                        ctx,
                        run,
                        item_id,
                        DeltaEventKind::Reasoning,
                        &json!("\n\n"),
                        parent.as_deref(),
                    );
                }
                if let Some(index) = index {
                    self.run(run).unwrap().summary_part.insert(item_id.to_string(), index);
                }
                self.delta(
                    ctx,
                    run,
                    item_id,
                    DeltaEventKind::Reasoning,
                    &p["delta"],
                    parent.as_deref(),
                );
            }
            "item/reasoning/textDelta" => {
                self.delta(
                    ctx,
                    run,
                    p["itemId"].as_str().unwrap_or(""),
                    DeltaEventKind::Reasoning,
                    &p["delta"],
                    parent.as_deref(),
                );
            }
            "turn/plan/updated" => self.plan(ctx, p, parent.as_deref()),
            "turn/started" => {
                if own && let Some(t) = p["turn"]["id"].as_str() {
                    let r = self.run(run).unwrap();
                    r.starting = true;
                    r.error = None;
                    self.set_turn(ctx, run, t.to_string());
                }
            }
            "turn/completed" => {
                if own {
                    self.turn_completed(ctx, run, &p["turn"]);
                } else {
                    self.child_done(
                        ctx,
                        run,
                        p["threadId"].as_str().unwrap_or(""),
                        &p["turn"],
                        parent.as_deref().unwrap(),
                    );
                }
            }
            "account/rateLimits/updated" => {
                if p["rateLimits"].is_object() {
                    ctx.rate_limits(codex_rate_limits(&p["rateLimits"]));
                }
            }
            "thread/tokenUsage/updated" => {
                if own
                    && !p["tokenUsage"]["total"].is_null()
                    && let Ok(t) = serde_json::from_value(p["tokenUsage"]["total"].clone())
                {
                    self.run(run).unwrap().total = Some(t);
                }
            }
            "warning" => {
                if own
                    && !p["threadId"].is_null()
                    && let Some(msg) = p["message"].as_str().filter(|m| !m.is_empty())
                {
                    self.notice(ctx, msg);
                }
            }
            "error" => {
                if !own {
                    return;
                }
                if p["willRetry"].as_bool().unwrap_or(false) {
                    let text = p["error"]["message"].as_str().unwrap_or("Codex is retrying.");
                    ctx.add_item(
                        json!({"id": new_id("n"), "type": "notice", "level": "warning", "code": "retry", "text": text}),
                    );
                } else {
                    self.run(run).unwrap().error = p["error"]["message"].as_str().map(String::from);
                }
            }
            "mcpServer/startupStatus/updated" => {
                let name = p["name"].as_str().unwrap_or("");
                if own && p["status"] == "failed" && (ctx.config().mcp_servers.contains_key(name) || name == APP_SERVER)
                {
                    let text = match p["error"].as_str().filter(|e| !e.is_empty()) {
                        Some(e) => format!("The MCP server {name} didn't start: {e}"),
                        None => format!("The MCP server {name} didn't start."),
                    };
                    self.notice(ctx, &text);
                }
            }
            "serverRequest/resolved" => {
                // Codex no longer wants an answer (it answered itself, or gave up).
                let r = self.run(run).unwrap();
                let rid = &p["requestId"];
                if r.take_open(rid).is_none() {
                    return;
                }
                if let Some(ours) = r.asked(rid) {
                    ctx.cancel_request(&ours);
                }
            }
            _ => {}
        }
    }

    fn delta(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        item_id: &str,
        kind: DeltaEventKind,
        text: &Value,
        parent: Option<&str>,
    ) {
        let Some(text) = text.as_str().filter(|t| !t.is_empty()) else {
            return;
        };
        let r = self.run(run).unwrap();
        if r.streamed.insert(item_id.to_string()) {
            let ty = if kind == DeltaEventKind::Text {
                "assistant_message"
            } else {
                "reasoning"
            };
            let mut item = json!({"id": item_id, "type": ty, "text": ""});
            if let Some(p) = parent {
                item["parent_id"] = json!(p);
            }
            ctx.add_item(item);
        }
        ctx.delta(item_id, kind, text);
    }

    fn item(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        item: &Value,
        done: bool,
        parent: Option<String>,
        child: Option<String>,
    ) {
        if !item.is_object() {
            return;
        }
        let item_id = item["id"].as_str().unwrap_or("").to_string();
        let under = |mut v: Value| {
            if let Some(p) = &parent {
                v["parent_id"] = json!(p);
            }
            v
        };
        match item["type"].as_str().unwrap_or("") {
            "userMessage" => {
                // A message taken in; a child's first one is its prompt, which isn't an item.
                if child.is_none() && !done {
                    self.took_in(ctx, run, &echo_key(&item["content"]));
                }
                return;
            }
            ty @ ("agentMessage" | "plan" | "reasoning") => {
                if !done {
                    return;
                }
                let join = |v: &Value| {
                    v.as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                let text = if ty == "reasoning" {
                    let summary = join(&item["summary"]);
                    if summary.is_empty() {
                        join(&item["content"])
                    } else {
                        summary
                    }
                } else {
                    item["text"].as_str().unwrap_or("").to_string()
                };
                let r = self.run(run).unwrap();
                if let Some(c) = &child
                    && ty == "agentMessage"
                {
                    r.last_child.insert(c.clone(), text.clone());
                }
                if r.streamed.contains(&item_id) {
                    ctx.update_item(&item_id, json!({"text": text}));
                } else if !text.is_empty() {
                    let ty = if ty == "reasoning" {
                        "reasoning"
                    } else {
                        "assistant_message"
                    };
                    ctx.add_item(under(json!({"id": item_id, "type": ty, "text": text})));
                }
                return;
            }
            "collabAgentToolCall" => {
                if item["tool"] != "spawnAgent" {
                    return; // wait, sendInput... aren't items of their own.
                }
                if !done {
                    if ctx.item(&item_id).is_none() {
                        let prompt = item["prompt"].as_str().unwrap_or("");
                        let mut call = json!({"id": item_id, "type": "tool_call", "name": "spawnAgent", "kind": "subagent", "input": {"prompt": prompt}, "status": "running"});
                        if !prompt.is_empty() {
                            call["title"] = json!(prompt);
                        }
                        ctx.add_item(under(call));
                    }
                    return;
                }
                let r = self.run(run).unwrap();
                for t in item["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    r.children.insert(t.to_string(), item_id.clone());
                }
                if item["status"] == "failed" {
                    ctx.update_item(&item_id, json!({"status": "failed"}));
                }
                return;
            }
            "contextCompaction" => {
                if !done && ctx.item(&item_id).is_none() {
                    let trigger = if self.runs.get(run).is_some_and(|r| r.compacting) {
                        "manual"
                    } else {
                        "auto"
                    };
                    ctx.add_item(under(json!({"id": item_id, "type": "compaction", "trigger": trigger})));
                }
                return;
            }
            _ => {}
        }
        if !is_tool_item(item) {
            return;
        }
        let r = self.run(run).unwrap();
        let fields = codex_tool(item, r.mcp_app);
        if item["type"] == "mcpToolCall" {
            r.mcp_calls.retain(|c| c.id != item_id);
            if !done {
                let args = if item["arguments"].is_null() {
                    json!({})
                } else {
                    item["arguments"].clone()
                };
                r.mcp_calls.push(McpCall {
                    id: item_id.clone(),
                    server: item["server"].as_str().unwrap_or("").into(),
                    name: item["tool"].as_str().unwrap_or("").into(),
                    args,
                    thread: child.clone().or_else(|| r.thread_id.clone()),
                });
            }
        }
        let existing = match ctx.item(&item_id) {
            Some(Item::ToolCall(c)) => Some(c.status),
            _ => None,
        };
        let mut call = Value::Object(fields);
        call["id"] = json!(item_id);
        call["type"] = json!("tool_call");
        call["status"] = json!("running");
        let call = under(call);
        if !done {
            if existing.is_none() {
                ctx.add_item(call);
            }
            return;
        }
        match existing {
            None => {
                let mut call = call;
                for (k, v) in codex_done(item, false) {
                    call[k] = v;
                }
                ctx.add_item(call);
            }
            Some(status) => ctx.update_item(&item_id, Value::Object(codex_done(item, status == ToolStatus::Denied))),
        }
    }

    /// A plan update: the turn's todo list, one item per turn and thread.
    fn plan(&mut self, ctx: &mut ThreadContext, p: &Value, parent: Option<&str>) {
        let id = format!("plan-{}-{}", js_str(&p["threadId"]), js_str(&p["turnId"]));
        let mut input = json!({"plan": p["plan"]});
        if let Some(e) = p["explanation"].as_str().filter(|e| !e.is_empty()) {
            input["explanation"] = json!(e);
        }
        if ctx.item(&id).is_some() {
            ctx.update_item(&id, json!({"input": input, "todos": todos(&p["plan"])}));
        } else {
            let mut item = json!({"id": id, "type": "tool_call", "name": "update_plan", "kind": "todo", "input": input, "todos": todos(&p["plan"]), "status": "completed"});
            if let Some(p) = parent {
                item["parent_id"] = json!(p);
            }
            ctx.add_item(item);
        }
    }

    fn took_in(&mut self, ctx: &mut ThreadContext, run: &str, key: &str) {
        let r = self.run(run).unwrap();
        let Some(at) = r.sent.iter().position(|s| s.key == key) else {
            return;
        };
        let ids = r.sent[at].ids.clone();
        // Sent more than once (steered, then carried over), they're all taken in now.
        r.sent.retain(|s| !s.ids.iter().any(|id| ids.contains(id)));
        for id in &ids {
            r.held.remove(id);
        }
        for id in ids {
            ctx.took_in(&id);
        }
    }

    fn turn_completed(&mut self, ctx: &mut ThreadContext, run: &str, turn: &Value) {
        let error = self.run(run).unwrap().error.clone();
        self.turn_ended(ctx, run);
        let r = self.run(run).unwrap();
        r.error = None;
        // The turn's requests are moot now; its open ones are cancelled with it.
        r.open.clear();
        // Codex reports the session's totals: the turn used how far they grew. (Where the
        // session's totals before it aren't known, the thread's usage stands in for them.)
        let usage = r.total.as_ref().map(|total| {
            let before = match &r.baseline {
                Some(b) => totals_as_usage(b),
                None => serde_json::to_value(&ctx.thread().usage).unwrap_or_default(),
            };
            codex_usage(total, &before)
        });
        if let Some(total) = r.total.clone() {
            r.baseline = Some(total);
            if let Some(t) = r.thread_id.clone() {
                self.save_state(ctx, run, &t);
            }
        }
        if ctx.turn_id().is_none() {
            return;
        }
        self.clear_stop();
        let failed = turn["status"] == "failed";
        let end = TurnEnd {
            ok: turn["status"] == "completed",
            error: failed.then(|| {
                turn["error"]["message"]
                    .as_str()
                    .map(String::from)
                    .or(error)
                    .unwrap_or_else(|| "The turn failed.".into())
            }),
            usage: usage.and_then(|u| serde_json::from_value(u).ok()),
            duration_ms: turn["durationMs"].as_f64().map(|d| d as u64),
        };
        let live = self.live_id().is_some();
        ctx.end_turn(end, live);
    }

    /// A subagent's turn ended: so did its call, with the subagent's last message.
    fn child_done(&mut self, ctx: &mut ThreadContext, run: &str, child: &str, turn: &Value, call: &str) {
        let status = match turn["status"].as_str() {
            Some("completed") => "completed",
            Some("interrupted") => "cancelled",
            _ => "failed",
        };
        let last = self.runs.get(run).and_then(|r| r.last_child.get(child).cloned());
        let content = if status == "failed" {
            turn["error"]["message"]
                .as_str()
                .map(String::from)
                .or(last)
                .unwrap_or_default()
        } else {
            last.unwrap_or_default()
        };
        ctx.update_item(call, json!({"status": status, "result": {"content": content}}));
    }

    // ---------- the server's requests ----------

    /// A request of Codex's; `resume` when it's one that was open when the backend restarted: the
    /// turn it came in, and the request the user was asked with, which is taken up again.
    fn server_request(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        m: Value,
        resume: Option<(Option<String>, Option<String>)>,
    ) {
        let id = m["id"].clone();
        let p = m["params"].clone();
        let parent = self.parent(run, &p["threadId"]).flatten();
        let (turn, existing) = match resume {
            Some((turn, existing)) => (turn, existing),
            None => (ctx.turn_id().map(String::from), None),
        };
        let r = self.run(run).unwrap();
        match r.open.iter_mut().find(|(x, _)| *x == id) {
            Some(o) => {
                o.1 = OpenRequest {
                    turn: turn.clone(),
                    msg: m.clone(),
                    started: false,
                }
            }
            None => r.open.push((
                id.clone(),
                OpenRequest {
                    turn: turn.clone(),
                    msg: m.clone(),
                    started: false,
                },
            )),
        }
        let wanted = Wanted::Request {
            run: run.to_string(),
            id: id.clone(),
            turn,
        };
        let decision = |ok: bool| json!({"decision": if ok { "accept" } else { "decline" }});
        match m["method"].as_str().unwrap_or("") {
            "item/commandExecution/requestApproval" => {
                let item_id = p["itemId"].as_str().map(String::from);
                let t = match item_id.as_deref().and_then(|i| ctx.item(i)) {
                    Some(it) => obj(serde_json::to_value(it).unwrap()),
                    None => {
                        let mut t = json!({"name": "commandExecution", "kind": "shell", "input": {"command": p["command"], "cwd": p["cwd"]}});
                        if let Some(c) = p["command"].as_str().filter(|c| !c.is_empty()) {
                            t["command"] = json!(translate::unwrap_command(c));
                        }
                        obj(t)
                    }
                };
                let q = self.query(ctx, &t, item_id.as_deref(), p["reason"].as_str(), parent.as_deref());
                let w = wanted.clone();
                let done: Done = Box::new(move |s, ctx, ok, _| s.answer(ctx, &w, decision(ok)));
                self.permit(
                    ctx,
                    Permit {
                        run: run.into(),
                        request: Some(id),
                        query: q,
                        wanted,
                        existing,
                    },
                    done,
                );
            }
            "item/fileChange/requestApproval" => {
                let item_id = p["itemId"].as_str().map(String::from);
                let t = match item_id.as_deref().and_then(|i| ctx.item(i)) {
                    Some(it) => obj(serde_json::to_value(it).unwrap()),
                    None => obj(
                        json!({"name": "fileChange", "kind": "edit", "input": {"grantRoot": p.get("grantRoot").cloned().unwrap_or(Value::Null)}}),
                    ),
                };
                let q = self.query(ctx, &t, item_id.as_deref(), p["reason"].as_str(), parent.as_deref());
                let w = wanted.clone();
                let done: Done = Box::new(move |s, ctx, ok, _| s.answer(ctx, &w, decision(ok)));
                self.permit(
                    ctx,
                    Permit {
                        run: run.into(),
                        request: Some(id),
                        query: q,
                        wanted,
                        existing,
                    },
                    done,
                );
            }
            "item/permissions/requestApproval" => {
                let reason = p["reason"].as_str().filter(|r| !r.is_empty());
                let mut input = json!({"permissions": p["permissions"], "cwd": p["cwd"]});
                if let Some(r) = reason {
                    input["reason"] = json!(r);
                }
                let t = obj(
                    json!({"name": "permissions", "kind": "other", "input": input, "title": reason.unwrap_or("More permissions")}),
                );
                let q = self.query(ctx, &t, p["itemId"].as_str(), reason, parent.as_deref());
                let (w, permissions) = (wanted.clone(), p["permissions"].clone());
                let done: Done = Box::new(move |s, ctx, ok, _| {
                    let permissions = if ok { permissions } else { json!({}) };
                    s.answer(ctx, &w, json!({"permissions": permissions, "scope": "turn"}));
                });
                self.permit(
                    ctx,
                    Permit {
                        run: run.into(),
                        request: Some(id),
                        query: q,
                        wanted,
                        existing,
                    },
                    done,
                );
            }
            "mcpServer/elicitation/request" => self.elicitation(ctx, run, id, &p, wanted, parent, existing),
            "item/tool/requestUserInput" => self.user_input(ctx, run, id, &p, wanted, parent, existing),
            "item/tool/call" => self.dynamic_tool(ctx, run, id, &p, wanted, parent, existing),
            method => {
                let r = self.run(run).unwrap();
                r.take_open(&id);
                r.respond_error(&id, &format!("agent-threads doesn't handle {method}"), -32601);
            }
        }
    }

    fn is_wanted(&self, ctx: &ThreadContext, w: &Wanted) -> bool {
        let (run, turn, id) = match w {
            Wanted::Request { run, id, turn } => (run, turn, Some(id)),
            Wanted::Run { run, turn } => (run, turn, None),
        };
        self.runs
            .get(run)
            .is_some_and(|r| id.is_none_or(|id| r.is_open(id)) && !r.exited && !r.retired && !r.detached)
            && self.current.as_deref() == Some(run.as_str())
            && ctx.turn_id() == turn.as_deref()
    }

    /// Answers a request of Codex's, if it still wants an answer.
    fn answer(&mut self, ctx: &ThreadContext, w: &Wanted, result: Value) {
        if !self.is_wanted(ctx, w) {
            return;
        }
        let Wanted::Request { run, id, .. } = w else { return };
        let r = self.run(run).unwrap();
        r.take_open(id);
        r.respond(id, result);
    }

    /// A permission query about a call (the item, or what the request says about it).
    fn query(
        &self,
        ctx: &ThreadContext,
        t: &Map<String, Value>,
        item_id: Option<&str>,
        reason: Option<&str>,
        parent: Option<&str>,
    ) -> PermissionQuery {
        let known = item_id.filter(|i| ctx.item(i).is_some());
        PermissionQuery {
            name: t.get("name").and_then(Value::as_str).unwrap_or("").into(),
            kind: t
                .get("kind")
                .and_then(|k| serde_json::from_value(k.clone()).ok())
                .unwrap_or(ToolKind::Other),
            input: t.get("input").cloned().unwrap_or(Value::Null),
            command: t.get("command").and_then(Value::as_str).map(String::from),
            title: Some(
                t.get("title")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| title(t)),
            )
            .filter(|s| !s.is_empty()),
            server: t.get("server").and_then(Value::as_str).map(String::from),
            reason: reason.filter(|r| !r.is_empty()).map(String::from),
            tool_call_id: known.map(String::from),
            parent_id: parent.map(String::from),
        }
    }

    /// Asks the policy (and, if it says so, the user) about a call, and calls `done` with the
    /// answer while it's wanted: synchronously when the policy answers synchronously, so effects
    /// keep their order.
    fn permit(&mut self, ctx: &mut ThreadContext, p: Permit, done: Done) {
        // The user was asked before the backend restarted: they still are.
        let decided = if p.existing.is_some() {
            Decided::Now(PermissionDecision::Ask)
        } else {
            ctx.decide(p.query.clone())
        };
        match decided {
            Decided::Now(d) => self.apply_permit(ctx, p, done, d),
            Decided::Later(f) => ctx.spawn::<CodexSession, _>(f, move |s, ctx, d| s.apply_permit(ctx, p, done, d)),
        }
    }

    fn apply_permit(&mut self, ctx: &mut ThreadContext, p: Permit, done: Done, d: PermissionDecision) {
        // A policy that took a while may answer after Codex stopped asking.
        if !self.is_wanted(ctx, &p.wanted) {
            return;
        }
        let call = p.query.tool_call_id.clone();
        match d {
            PermissionDecision::Allow => done(self, ctx, true, String::new()),
            PermissionDecision::Ask => {
                let q = &p.query;
                let mut request = json!({"type": "permission", "name": q.name, "kind": q.kind, "input": q.input});
                if let Some(t) = &q.title {
                    request["title"] = json!(t);
                }
                if let Some(r) = &q.reason {
                    request["reason"] = json!(r);
                }
                let standing = permission_key(q.kind, q.server.as_deref(), &q.name);
                let (wanted, call2) = (p.wanted.clone(), call.clone());
                let answered = ThreadContext::answered::<CodexSession>(move |s, ctx, res: Resolution| {
                    if !s.is_wanted(ctx, &wanted) {
                        return;
                    }
                    if res.outcome == ResolutionOutcome::Allow {
                        done(s, ctx, true, String::new());
                        if let Some(c) = &call2 {
                            ctx.update_item(c, json!({"status": "running"}));
                        }
                    } else {
                        let message = res
                            .message
                            .filter(|m| !m.is_empty())
                            .unwrap_or_else(|| "The user didn't allow this.".into());
                        done(s, ctx, false, message);
                        if let Some(c) = &call2 {
                            ctx.update_item(c, json!({"status": "denied"}));
                        }
                    }
                });
                let ours = ctx.ask_again(
                    p.existing.as_deref(),
                    request,
                    call.as_deref(),
                    answered,
                    Some(standing),
                );
                if let Some(rid) = p.request
                    && let Some(r) = self.run(&p.run)
                {
                    r.asked.retain(|(x, _)| *x != rid);
                    r.asked.push((rid, ours));
                }
            }
            PermissionDecision::Deny(why) => {
                done(
                    self,
                    ctx,
                    false,
                    why.unwrap_or_else(|| "The app's permission policy doesn't allow this.".into()),
                );
                if let Some(c) = &call {
                    ctx.update_item(c, json!({"status": "denied"}));
                }
            }
        }
    }

    /// An MCP server asking: Codex asks this way whether a tool on it may be called.
    #[allow(clippy::too_many_arguments)]
    fn elicitation(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        id: Value,
        p: &Value,
        wanted: Wanted,
        parent: Option<String>,
        existing: Option<String>,
    ) {
        let server = p["serverName"].as_str().unwrap_or("").to_string();
        let fields = p["requestedSchema"]["properties"].as_object().map_or(0, |o| o.len());
        // Only an elicitation that needs nothing filled in ("may it call this tool?") can be
        // answered.
        if p["mode"] != "form" || fields > 0 {
            return self.answer(ctx, &wanted, json!({"action": "decline"}));
        }
        let r = self.runs.get(run).unwrap();
        // The app's own tools are decided on when they're called.
        if server == APP_SERVER && r.mcp_app {
            return self.answer(ctx, &wanted, json!({"action": "accept", "content": {}}));
        }
        // The policy is asked about the tool and arguments the elicitation names. The running
        // call is only taken to be the one it's about if it's the only one that matches it.
        let message = p["message"].as_str().unwrap_or("").to_string();
        let named = named_tool(&message);
        let params = p["_meta"].get("tool_params").cloned();
        let thread = p["threadId"].as_str().map(String::from).or_else(|| r.thread_id.clone());
        let matching: Vec<&McpCall> = match &named {
            Some(n) => r
                .mcp_calls
                .iter()
                .filter(|c| {
                    c.server == server
                        && c.thread == thread
                        && &c.name == n
                        && params.as_ref().is_none_or(|p| &c.args == p)
                })
                .collect(),
            None => Vec::new(),
        };
        let it = if matching.len() == 1 {
            ctx.item(&matching[0].id).cloned()
        } else {
            None
        };
        let input = params.or_else(|| match &it {
            Some(Item::ToolCall(c)) => Some(c.input.clone()),
            _ => None,
        });
        let mut t = json!({"name": named.as_deref().unwrap_or("elicitation"), "kind": "mcp", "server": server, "input": input.unwrap_or(json!({}))});
        if it.is_none() {
            t["title"] = json!(message);
        }
        let it_id = it.as_ref().map(|i| i.id().to_string());
        let q = self.query(ctx, &obj(t), it_id.as_deref(), None, parent.as_deref());
        let w = wanted.clone();
        let done: Done = Box::new(move |s, ctx, ok, _| {
            s.answer(
                ctx,
                &w,
                if ok {
                    json!({"action": "accept", "content": {}})
                } else {
                    json!({"action": "decline"})
                },
            )
        });
        self.permit(
            ctx,
            Permit {
                run: run.into(),
                request: Some(id),
                query: q,
                wanted,
                existing,
            },
            done,
        );
    }

    /// A question for the user: a request_user_input call, and a question request for it.
    #[allow(clippy::too_many_arguments)]
    fn user_input(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        id: Value,
        p: &Value,
        wanted: Wanted,
        parent: Option<String>,
        existing: Option<String>,
    ) {
        let qs = questions(&p["questions"]);
        let item_id = p["itemId"].as_str().unwrap_or("").to_string();
        if ctx.item(&item_id).is_none() {
            let mut item = json!({"id": item_id, "type": "tool_call", "name": "request_user_input", "kind": "other", "input": {"questions": p["questions"]}, "status": "pending"});
            if let Some(p) = &parent {
                item["parent_id"] = json!(p);
            }
            ctx.add_item(item);
        }
        if qs.is_empty() {
            self.answer(ctx, &wanted, json!({"answers": {}}));
            return ctx.update_item(&item_id, json!({"status": "completed", "result": {"content": ""}}));
        }
        let order: Vec<String> = qs.iter().map(|q| js_str(&q["id"])).collect();
        let secret: HashSet<String> = qs
            .iter()
            .filter(|q| q["secret"] == true)
            .map(|q| js_str(&q["id"]))
            .collect();
        let (w, call) = (wanted.clone(), item_id.clone());
        let answered = ThreadContext::answered::<CodexSession>(move |s, ctx, res: Resolution| {
            if res.outcome != ResolutionOutcome::Answer {
                s.answer(ctx, &w, json!({"answers": {}}));
                return ctx.update_item(&call, json!({"status": "denied"}));
            }
            let mut answers = Map::new();
            let mut lines = Vec::new();
            // In the questions' order, then any others.
            let mut keys: Vec<&String> = order.iter().filter(|q| res.answers.contains_key(*q)).collect();
            let mut rest: Vec<&String> = res.answers.keys().filter(|k| !order.contains(k)).collect();
            rest.sort();
            keys.extend(rest);
            for q in keys {
                let a = &res.answers[q];
                answers.insert(q.clone(), json!({"answers": a}));
                // The real answer goes only to Codex; the call's result is shown and saved.
                let shown = if secret.contains(q) && !a.is_empty() {
                    SECRET.to_string()
                } else {
                    a.join(", ")
                };
                lines.push(format!("{q}: {shown}"));
            }
            s.answer(ctx, &w, json!({"answers": answers}));
            ctx.update_item(
                &call,
                json!({"status": "completed", "result": {"content": lines.join("\n")}}),
            );
        });
        let ours = ctx.ask_again(
            existing.as_deref(),
            json!({"type": "question", "questions": qs}),
            Some(&item_id),
            answered,
            None,
        );
        let r = self.run(run).unwrap();
        r.asked.retain(|(x, _)| *x != id);
        r.asked.push((id, ours));
    }

    /// item/tool/call: one of the app's tools, given as a dynamic tool.
    #[allow(clippy::too_many_arguments)]
    fn dynamic_tool(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        id: Value,
        p: &Value,
        wanted: Wanted,
        parent: Option<String>,
        existing: Option<String>,
    ) {
        let reply = |s: &mut CodexSession, ctx: &ThreadContext, w: &Wanted, text: &str, ok: bool| {
            s.answer(
                ctx,
                w,
                json!({"contentItems": [{"type": "inputText", "text": text}], "success": ok}),
            );
        };
        let name = p["tool"].as_str().unwrap_or("").to_string();
        let r = self.runs.get(run).unwrap();
        // Codex keeps a session's dynamic tools as they were: one that has gone or changed since is
        // answered with where the app's tools are now.
        let elsewhere = || {
            let names: Vec<String> = mcp_tools(ctx, r).iter().map(|t| t.name().to_string()).collect();
            if names.is_empty() {
                String::new()
            } else {
                format!(
                    " The app's other tools are on its {APP_SERVER} MCP server: {}.",
                    names.join(", ")
                )
            }
        };
        let Some(tool) = ctx.config().tool(&name).cloned() else {
            let text = if r.dynamic_tool(&name).is_some() {
                format!("The tool {name} isn't available any more.{}", elsewhere())
            } else {
                format!("There's no tool {name}.")
            };
            return reply(self, ctx, &wanted, &text, false);
        };
        if r.dynamic.is_some() && r.dynamic_tool(&name) != Some(&tool_spec(tool.as_ref())) {
            let text = format!("The tool {name} has changed: call it on the {APP_SERVER} MCP server instead.");
            return reply(self, ctx, &wanted, &text, false);
        }
        let args = if p["arguments"].is_null() {
            json!({})
        } else {
            p["arguments"].clone()
        };
        let t = obj(json!({"name": name, "kind": "app", "input": args, "title": name}));
        let call_id = p["callId"].as_str().map(String::from);
        let q = self.query(ctx, &t, call_id.as_deref(), None, parent.as_deref());
        let (w, run_id, rid) = (wanted.clone(), run.to_string(), id.clone());
        let done: Done = Box::new(move |s, ctx, ok, message| {
            if !ok {
                return reply(s, ctx, &w, &message, false);
            }
            // Saved as running before it runs, so a backend that restarts while it does answers it
            // rather than run it again (see reopen_request).
            if let Some(r) = s.run(&run_id)
                && let Some(o) = r.open.iter_mut().find(|(x, _)| *x == rid)
            {
                o.1.started = true;
            }
            ctx.persist::<CodexSession>(move |s, ctx, saved| {
                if saved.is_err() {
                    return reply(
                        s,
                        ctx,
                        &w,
                        "The app couldn't save its state, so it didn't run this tool.",
                        false,
                    );
                }
                if !s.is_wanted(ctx, &w) || s.runs.get(&run_id).is_none_or(|r| r.detached) {
                    return;
                }
                let fut = s.run_app(ctx, &run_id, &name, args, call_id.clone());
                ctx.spawn::<CodexSession, _>(fut, move |s, ctx, out| {
                    // The backend shut down while it ran (and cancelled it): it's left open, as
                    // saved, for the backend that re-attaches to answer.
                    if s.runs.get(&run_id).is_none_or(|r| r.detached) {
                        return;
                    }
                    if let Some(call) = &call_id {
                        ctx.tool_output(call, out.structured.clone());
                    }
                    reply(s, ctx, &w, &out.text, !out.is_error);
                    // Saved as answered, though no event says so: a restart doesn't answer it again.
                    ctx.persist::<CodexSession>(|_, _, _| {});
                });
            });
        });
        self.permit(
            ctx,
            Permit {
                run: run.into(),
                request: Some(id),
                query: q,
                wanted,
                existing,
            },
            done,
        );
    }

    /// tools/call on the loopback MCP server: one of the app's tools.
    fn mcp_app_tool(
        &mut self,
        ctx: &mut ThreadContext,
        run: &str,
        name: String,
        args: Value,
        reply: oneshot::Sender<ToolOutput>,
    ) {
        let Some(r) = self.runs.get(run) else { return };
        if !mcp_tools(ctx, r).iter().any(|t| t.name() == name) {
            let _ = reply.send(ToolOutput::error(format!("There's no tool {name}.")));
            return;
        }
        // The call it is, if only one running call matches it.
        let matching: Vec<&McpCall> = r
            .mcp_calls
            .iter()
            .filter(|c| c.server == APP_SERVER && c.name == name && c.args == args)
            .collect();
        let it = if matching.len() == 1 {
            ctx.item(&matching[0].id).cloned()
        } else {
            None
        };
        let wanted = Wanted::Run {
            run: run.into(),
            turn: ctx.turn_id().map(String::from),
        };
        let t = obj(json!({"name": name, "kind": "app", "input": args, "title": name}));
        let it_id = it.as_ref().map(|i| i.id().to_string());
        let q = self.query(ctx, &t, it_id.as_deref(), None, it.as_ref().and_then(|i| i.parent_id()));
        let run_id = run.to_string();
        let done: Done = Box::new(move |s, ctx, ok, message| {
            if !ok {
                let _ = reply.send(ToolOutput::error(message));
                return;
            }
            let fut = s.run_app(ctx, &run_id, &name, args, it_id.clone());
            ctx.spawn::<CodexSession, _>(fut, move |s, ctx, out| {
                if let Some(call) = &it_id
                    && s.runs.get(&run_id).is_some_and(|r| !r.detached)
                {
                    ctx.tool_output(call, out.structured.clone());
                }
                let _ = reply.send(out);
            });
        });
        self.permit(
            ctx,
            Permit {
                run: run.into(),
                request: None,
                query: q,
                wanted,
                existing: None,
            },
            done,
        );
    }

    fn run_app(
        &self,
        ctx: &ThreadContext,
        run: &str,
        name: &str,
        args: Value,
        tool_call_id: Option<String>,
    ) -> BoxFuture<ToolOutput> {
        let Some(tool) = ctx.config().tool(name).cloned() else {
            let text = format!("There's no tool {name}.");
            return Box::pin(async move { ToolOutput::error(text) });
        };
        let tctx = ToolContext {
            thread_id: ctx.thread_id().to_string(),
            metadata: ctx.thread().metadata.clone(),
            tool_call_id,
            cancelled: self.runs.get(run).map(|r| r.cancel.clone()).unwrap_or_default(),
        };
        Box::pin(run_tool(tool, args, tctx))
    }

    /// A request of Codex's that was open when the backend restarted.
    fn reopen_request(&mut self, ctx: &mut ThreadContext, run: &str, id: Value, open: OpenRequest) {
        if open.started {
            let r = self.run(run).unwrap();
            r.take_open(&id);
            // It went with the backend, and isn't run again, since it may have done what it does.
            let text = "The app restarted while this tool was running, so it may or may not have finished.";
            return r.respond(
                &id,
                json!({"contentItems": [{"type": "inputText", "text": text}], "success": false}),
            );
        }
        let existing = self.runs.get(run).and_then(|r| r.asked(&id));
        self.server_request(ctx, run, open.msg, Some((open.turn, existing)));
    }
}

/// What's done with turn/start's answer.
fn turn_started(sent: Sent) -> Then {
    Box::new(move |s, ctx, run, r| match r {
        Ok(r) => {
            if let Some(t) = r["turn"]["id"].as_str()
                && s.runs.get(run).is_some_and(|r| r.starting && r.turn_id.is_none())
            {
                s.set_turn(ctx, run, t.to_string());
            }
        }
        Err(e) => {
            s.refused(run, &sent);
            s.turn_failed(ctx, run, &e.message);
        }
    })
}

impl HarnessSession for CodexSession {
    fn start(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>) {
        let run = self.ensure(ctx, true);
        if messages.len() == 1 && messages[0].text.trim() == "/compact" && messages[0].attachments.is_empty() {
            let r = self.run(&run).unwrap();
            r.starting = true;
            r.compacting = true;
            self.when_ready(
                ctx,
                &run.clone(),
                Box::new(move |s, ctx, ready| match ready {
                    Err(e) => s.turn_failed(ctx, &run, &e),
                    Ok(thread_id) => s.request(
                        ctx,
                        &run,
                        "thread/compact/start",
                        json!({"threadId": thread_id}),
                        None,
                        Box::new(|s, ctx, run, r| {
                            if let Err(e) = r {
                                s.turn_failed(ctx, run, &e.message);
                            }
                        }),
                    ),
                }),
            );
            return;
        }
        self.turn_start(ctx, &run, &messages);
    }

    fn steer(&mut self, ctx: &mut ThreadContext, message: Message) {
        // With no process, there's no turn to steer: the message stays queued, and the turn's end
        // carries it over.
        let Some(run) = self.live_id() else { return };
        let input = self.input(ctx, std::slice::from_ref(&message));
        let sent = self.sent(&run, vec![message.id], &input);
        self.with_turn(
            ctx,
            &run.clone(),
            Box::new(move |s, ctx, turn| {
                let Some(turn) = turn else {
                    return s.refused(&run, &sent);
                };
                let thread_id = s.runs.get(&run).and_then(|r| r.thread_id.clone());
                let params = json!({"threadId": thread_id, "expectedTurnId": turn, "input": input});
                let meta = json!({"sent": sent});
                s.request(
                    ctx,
                    &run,
                    "turn/steer",
                    params,
                    Some(meta),
                    Box::new(move |s, _, run, r| {
                        // The turn ended first: the message is still queued, and goes with the next.
                        if r.is_err() {
                            s.refused(run, &sent);
                        }
                    }),
                );
            }),
        );
    }

    fn carry_over(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>) {
        match self.live_id() {
            Some(run) if !self.stale => self.turn_start(ctx, &run, &messages),
            live => {
                // The next turn runs with the options as they are now, so in a new process if they
                // changed.
                if let Some(run) = live {
                    self.stop(ctx, &run, true, true);
                }
                self.start(ctx, messages);
            }
        }
    }

    fn interrupt(&mut self, ctx: &mut ThreadContext) {
        let Some(run) = self.live_id() else { return };
        let grace = self.o.stop_grace;
        self.stop_after(ctx, &run, grace);
        let turn = ctx.turn_id().map(String::from);
        let send = move |s: &mut CodexSession, ctx: &mut ThreadContext| {
            if s.live_id().as_deref() != Some(run.as_str())
                || ctx.turn_id().map(String::from) != turn
                || s.runs.get(&run).is_none_or(|r| r.detached)
            {
                return;
            }
            s.with_turn(
                ctx,
                &run.clone(),
                Box::new(move |s, ctx, turn| {
                    let Some(r) = s.runs.get(&run) else { return };
                    if let Some(turn) = turn
                        && !r.exited
                    {
                        let params = json!({"threadId": r.thread_id, "turnId": turn});
                        s.request(ctx, &run, "turn/interrupt", params, None, Box::new(|_, _, _, _| {}));
                    }
                }),
            );
        };
        // A run that outlives the backend is saved first, its turn interrupted and when it's
        // stopped if the turn doesn't end: after a restart, one that Codex ignores the interrupt in
        // is still stopped.
        if ctx.spawner().durable() {
            ctx.persist::<CodexSession>(move |s, ctx, _| send(s, ctx));
        } else {
            send(self, ctx);
        }
    }

    fn live(&self) -> bool {
        self.live_id().is_some()
    }

    fn release(&mut self, ctx: &mut ThreadContext) {
        // A process that has the messages is stopped, so it can't act on them unseen.
        let Some(run) = self.live_id() else { return };
        let held = &self.runs[&run].held;
        if ctx.queued().iter().any(|m| held.contains(&m.id)) {
            self.stop(ctx, &run, true, true);
        }
    }

    fn options_changed(&mut self, _ctx: &mut ThreadContext) {
        self.stale = true;
    }

    fn close(&mut self, ctx: &mut ThreadContext) -> BoxFuture<()> {
        self.closed = true;
        self.clear_stop();
        if let Some(id) = self.current.clone() {
            self.stop(ctx, &id, false, false);
        }
        let waits: Vec<watch::Receiver<bool>> = self
            .runs
            .values()
            .filter(|r| !r.exited)
            .map(|r| r.done.subscribe())
            .collect();
        let tmp = self.tmp.take();
        Box::pin(async move {
            for mut w in waits {
                let _ = w.wait_for(|d| *d).await;
            }
            if let Some(tmp) = tmp {
                let _ = tokio::fs::remove_dir_all(tmp).await;
            }
        })
    }

    fn durable(&self) -> bool {
        true
    }

    fn checkpoint(&mut self, _ctx: &ThreadContext) -> Option<RunCheckpoint> {
        // The last run, until another starts: one that has exited is saved once more, as it ended.
        let id = self.current.clone().or_else(|| self.last.clone())?;
        let run = self.runs.get(&id)?;
        if run.retired {
            return None;
        }
        let offset = run.offset?;
        // While it's starting there's nothing to carry on with: a restart then stops it.
        let state = run.state().map(|mut st| {
            st.stale = self.stale;
            st.stop_at = self.stop_at;
            st
        });
        let proc = run.proc.as_ref();
        Some(RunCheckpoint {
            id,
            offset,
            dir: proc.and_then(|p| p.dir()),
            input: proc.and_then(|p| p.input_offset(&run.open_ids())),
            state: state.and_then(|s| serde_json::to_value(s).ok()),
            ended: run.exited,
        })
    }

    fn reattach(&mut self, ctx: &mut ThreadContext, record: &RunRecord) -> bool {
        let Some(st) = record
            .data
            .as_ref()
            .and_then(|d| d.get("state"))
            .and_then(|s| serde_json::from_value::<RunState>(s.clone()).ok())
        else {
            return false;
        };
        if st.v != 1 || !ctx.spawner().can_attach() || self.current.is_some() {
            return false;
        }
        let mut run = Run::new();
        run.restore(&st);
        run.spawned = true;
        run.offset = record.offset;
        // Our requests still unanswered: their answers do what they would have.
        for p in &st.rpc.pending {
            let sent: Option<Sent> = p
                .meta
                .as_ref()
                .and_then(|m| m.get("sent"))
                .and_then(|s| serde_json::from_value(s.clone()).ok());
            let mine = sent.filter(|s| run.sent.contains(s));
            let then: Then = match p.method.as_str() {
                "turn/start" => match mine {
                    Some(sent) => turn_started(sent),
                    None => Box::new(|s, ctx, run, r| match r {
                        Ok(r) => {
                            if let Some(t) = r["turn"]["id"].as_str()
                                && s.runs.get(run).is_some_and(|r| r.starting && r.turn_id.is_none())
                            {
                                s.set_turn(ctx, run, t.to_string());
                            }
                        }
                        Err(e) => s.turn_failed(ctx, run, &e.message),
                    }),
                },
                "turn/steer" => Box::new(move |s, _, run, r| {
                    if r.is_err()
                        && let Some(sent) = &mine
                    {
                        s.refused(run, sent);
                    }
                }),
                "thread/compact/start" => Box::new(|s, ctx, run, r| {
                    if let Err(e) = r {
                        s.turn_failed(ctx, run, &e.message);
                    }
                }),
                _ => Box::new(|_, _, _, _| {}),
            };
            run.pending.push(Pending {
                id: p.id,
                method: p.method.clone(),
                meta: p.meta.clone(),
                then,
                raw: false,
            });
        }
        let (proc, rx) = match ctx.spawner().attach(record) {
            Ok(p) => p,
            Err(e) => {
                ctx.error(Error::Other(format!(
                    "Codex's run {} can't be followed: {e}",
                    record.id
                )));
                return false;
            }
        };
        run.proc = Some(proc);
        let id = record.id.clone();
        self.runs.insert(id.clone(), run);
        self.current = Some(id.clone());
        forward_events::<CodexSession>(ctx, &id, rx, |s, ctx, id, e| s.event(ctx, id, e));
        // The app's tools on the loopback MCP server, where Codex was told they are.
        if let Some(ep) = &st.mcp {
            let server = Arc::new(LoopbackTools {
                post: Box::new(ctx.poster::<CodexSession>()),
                run: id.clone(),
            });
            match serve_tools(APP_SERVER, server, Some((ep.port, ep.token.clone()))) {
                Ok(mcp) => self.run(&id).unwrap().mcp = Some(mcp),
                Err(e) => self.notice(
                    ctx,
                    &format!("The app's tools aren't available to this turn any more: {e}"),
                ),
            }
        }
        // A process started with other options than the thread's now is replaced at the next turn.
        let t = ctx.thread();
        let now = Launched {
            model: t.model.clone(),
            effort: t.effort.clone(),
            permission_mode: t.permission_mode.map(|m| m.to_string()),
        };
        self.stale = st.stale || st.launched.as_ref() != Some(&now);
        // Codex's requests that were open: the user's questions are taken up again, an app tool
        // that was running is answered (not run again), and the rest are dealt with again.
        // One answered before the restart, though that wasn't saved, is closed: Codex has its
        // answer.
        for (rid, open) in st.open.clone() {
            let r = self.run(&id).unwrap();
            if r.proc.as_ref().is_some_and(|p| p.answered(&id_string(&rid))) {
                r.take_open(&rid);
                continue;
            }
            self.reopen_request(ctx, &id, rid, open);
        }
        if let Some(at) = st.stop_at {
            self.stop_after(ctx, &id, Duration::from_millis(at.saturating_sub(now_ms())));
        }
        true
    }

    fn detach(&mut self, _ctx: &mut ThreadContext) -> bool {
        let Some(id) = self.live_id() else { return false };
        let run = self.runs.get_mut(&id).unwrap();
        let Some(proc) = run.proc.clone() else { return false };
        if !proc.can_detach() {
            return false;
        }
        self.closed = true;
        if let Some(t) = self.stop_timer.take() {
            t.cancel();
        }
        run.detached = true;
        proc.detach();
        run.cancel.cancel();
        if let Some(mcp) = run.mcp.take() {
            mcp.close();
        }
        for slot in self.controls.drain(..) {
            if let Some(reply) = slot.lock().unwrap().take() {
                reply(Err(Error::Control {
                    message: "The backend closed before Codex answered.".into(),
                    error: None,
                }));
            }
        }
        true
    }

    fn control(&mut self, ctx: &mut ThreadContext, request: Value, reply: ControlReply) {
        let live = self
            .live_id()
            .filter(|id| self.runs.get(id).is_some_and(|r| r.proc.is_some() && !r.detached));
        let Some(id) = live else {
            return reply(Err(Error::Command(format!(
                "thread {} has no running Codex process",
                ctx.thread_id()
            ))));
        };
        let Some(method) = request["method"].as_str().map(String::from) else {
            return reply(Err(Error::Command(
                "a Codex control request is an object with a method (and params)".into(),
            )));
        };
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let slot = Arc::new(StdMutex::new(Some(reply)));
        self.controls.retain(|s| s.lock().unwrap().is_some());
        self.controls.push(slot.clone());
        self.send_request(
            ctx,
            &id,
            &method,
            params,
            None,
            Box::new(move |_, _, _, r| {
                if let Some(reply) = slot.lock().unwrap().take() {
                    reply(r.map_err(|e| Error::Control {
                        message: e.message,
                        error: e.error,
                    }));
                }
            }),
            true,
        );
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(o) => o,
        _ => Map::new(),
    }
}

/// A JSON value as JavaScript's template strings show it.
fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "undefined".into(),
        v => v.to_string(),
    }
}

/// The tool an elicitation's message names: `tool "<name>"`.
fn named_tool(message: &str) -> Option<String> {
    let at = message.find("tool \"")? + 6;
    let end = message[at..].find('"')?;
    (end > 0).then(|| message[at..at + end].to_string())
}

/// Whether an error says Codex doesn't take dynamic tools (/dynamic.?tools|experimental/i).
fn mentions_dynamic_tools(message: &str) -> bool {
    let m = message.to_lowercase();
    if m.contains("experimental") {
        return true;
    }
    m.match_indices("dynamic").any(|(at, _)| {
        let rest = &m[at + 7..];
        rest.starts_with("tools")
            || rest
                .chars()
                .next()
                .is_some_and(|c| rest[c.len_utf8()..].starts_with("tools"))
    })
}

/// A path with its symlinks resolved, where it exists.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// What identifies a message in Codex's userMessage item: its text inputs and how many images it
/// has.
fn echo_key(input: &Value) -> String {
    let parts: Vec<&Value> = input.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let texts: Vec<&Value> = parts
        .iter()
        .filter(|p| p["type"] == "text")
        .map(|p| &p["text"])
        .collect();
    let images = parts
        .iter()
        .filter(|p| p["type"] == "image" || p["type"] == "localImage")
        .count();
    json!([texts, images]).to_string()
}

fn exit_error(status: &ExitStatus, stderr: &VecDeque<String>, during_turn: bool) -> String {
    if let Some(e) = &status.error {
        return format!("Codex couldn't be started: {e}");
    }
    let how = match (&status.signal, status.code) {
        (Some(s), _) => format!("was stopped by {s}"),
        (None, Some(c)) => format!("exited with code {c}"),
        (None, None) => "exited with code null".into(),
    };
    let during = if during_turn { " during the turn" } else { "" };
    let tail = stderr.iter().cloned().collect::<Vec<_>>().join("\n");
    let tail = tail.trim();
    if tail.is_empty() {
        format!("Codex {how}{during}.")
    } else {
        format!("Codex {how}{during}.\n{}", last_chars(tail, 2000))
    }
}

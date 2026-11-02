//! The Claude Code driver: runs `claude -p` in stream-json mode, one process per thread (started at
//! its first message, kept between turns), and translates what it says into the thread's events by
//! the rules in spec/fixtures/README.md. Permissions come in as `can_use_tool` control requests, the
//! app's tools are an in-process MCP server answered over `mcp_message`, and steered messages go in
//! over stdin and join the turn when Claude echoes them back.

mod translate;

use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};

use crate::agent_threads::Error;
use crate::attachments::{Part, message_parts, path_text};
use crate::harness::{BoxFuture, Harness, HarnessSession, Message, RunCheckpoint, TurnEnd};
use crate::ids::{new_id, now_iso, now_ms, private_temp_dir};
use crate::permissions::{Decided, PermissionDecision, PermissionQuery, permission_key};
use crate::protocol::{DeltaEventKind, Item, Resolution, ResolutionOutcome, ToolKind, ToolStatus, Usage};
use crate::skills::write_skills;
use crate::spawner::{ExitStatus, HarnessProcess, ProcessEvent, Signal, SpawnOptions};
use crate::store::RunRecord;
use crate::thread::{ThreadContext, Timer, add_usage, running_in_background};
use crate::tools::{Cancellation, ToolContext, run_tool};

pub(crate) use translate::{APP_SERVER, result_text, slim, title};
use translate::{
    claude_permission_mode, claude_tool, claude_usage, edit_change, questions, subagent_result, subagent_started,
    subagent_task,
};

/// How the Claude Code harness runs.
#[derive(Clone, Debug)]
pub struct ClaudeCodeOptions {
    /// The `claude` binary.
    pub bin: String,
    /// Arguments before Claude's own: e.g. the script, when `bin` is `node`.
    pub bin_args: Vec<String>,
    /// More arguments, after the driver's.
    pub args: Vec<String>,
    /// Changes to the backend's environment: a value sets a variable, `None` removes it.
    pub env: HashMap<String, Option<String>>,
    /// Claude Code's config directory (CLAUDE_CONFIG_DIR), for a login of the app's own.
    pub config_dir: Option<PathBuf>,
    /// Let threads see the user's own Claude Code settings, MCP servers and skills. Off by default:
    /// a thread sees only the app's.
    pub user_settings: bool,
    /// How long an interrupted turn has to end before the process is stopped. 10s by default.
    pub stop_grace: Duration,
    /// How long Claude has, after a turn ends, to take in steered messages it hasn't yet; then the
    /// process is restarted with them. 30s by default.
    pub steer_grace: Duration,
    /// How long a process has to exit after its input is closed before it's sent SIGTERM. 5s by
    /// default.
    pub close_grace: Duration,
}

impl Default for ClaudeCodeOptions {
    fn default() -> Self {
        ClaudeCodeOptions {
            bin: "claude".into(),
            bin_args: Vec::new(),
            args: Vec::new(),
            env: HashMap::new(),
            config_dir: None,
            user_settings: false,
            stop_grace: Duration::from_secs(10),
            steer_grace: Duration::from_secs(30),
            close_grace: Duration::from_secs(5),
        }
    }
}

/// The Claude Code harness, `claude`.
pub fn claude_code(options: ClaudeCodeOptions) -> Arc<dyn Harness> {
    Arc::new(ClaudeHarness(Arc::new(options)))
}

struct ClaudeHarness(Arc<ClaudeCodeOptions>);

impl Harness for ClaudeHarness {
    fn name(&self) -> &str {
        "claude"
    }
    fn open(&self, _ctx: &ThreadContext) -> Box<dyn HarnessSession> {
        Box::new(ClaudeSession::new(self.0.clone()))
    }
}

/// A request of Claude's not yet answered: the turn it came in, and the request.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OpenRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn: Option<String>,
    request: Value,
}

/// The messages sent, by what Claude echoes when it takes one in.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Sent {
    ids: Vec<String>,
    echo: String,
}

/// The thread's options a process is started with: a different one needs another.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Launched {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

/// What a run's checkpoint holds: what's needed to carry on reading its output, as of the offset
/// saved with it. (The same as the Node backend's.)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunState {
    v: u32,
    ready: bool,
    waiting: Vec<String>,
    /// Our control requests not yet answered: their subtypes, by id.
    pending: Vec<(String, String)>,
    next: u64,
    msg_of_parent: Vec<(Option<String>, String)>,
    block_count: Vec<(String, u64)>,
    streamed: Vec<String>,
    summary_next: Option<String>,
    asked: Vec<(String, String)>,
    open: Vec<(String, OpenRequest)>,
    sent: Vec<Sent>,
    /// Its subagents' task ids, and their calls' ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tasks: Vec<(String, String)>,
    /// The calls whose subagents it ran.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    agents: Vec<String>,
    /// The turn Claude started by itself, and the usage of its turns held for the user's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_turn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held_usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plugin_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launched: Option<Launched>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    steer_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop_at: Option<u64>,
}

/// One `claude` process, and what's needed to read it.
struct Run {
    proc: Option<Arc<dyn HarnessProcess>>,
    /// How far into its output it's been read (with a durable spawner).
    offset: Option<u64>,
    /// It's been started (or there's nothing to start).
    spawned: bool,
    /// Claude answered `initialize`, so messages can go in.
    ready: bool,
    waiting: Vec<String>,
    /// Our control requests, by id: their subtypes.
    pending: Vec<(String, String)>,
    next: u64,
    exited: bool,
    /// Stopped on purpose (to restart), so its end doesn't end the turn.
    retired: bool,
    done: watch::Sender<bool>,
    stderr: VecDeque<String>,
    cancel: Cancellation,
    // What's needed to translate its output.
    msg_of_parent: HashMap<Option<String>, String>,
    block_count: HashMap<String, u64>,
    streamed: HashSet<String>,
    summary_next: Option<String>,
    /// Claude's request id -> our request's.
    asked: HashMap<String, String>,
    /// Claude's requests not yet answered, with the turn each came in, oldest first.
    open: Vec<(String, OpenRequest)>,
    /// The messages sent, oldest first, by what Claude echoes when it takes one in.
    sent: Vec<Sent>,
    /// Its subagents' task ids (which some task_* messages name them by) -> their calls' ids.
    tasks: HashMap<String, String>,
    /// The calls whose subagents it ran, which are stopped when it ends.
    agents: Vec<String>,
    /// The turn it started by itself (begin_turn), if it has.
    auto_turn: Option<String>,
    /// The usage of turns Claude made by itself while one of the user's waited, for that turn's.
    held_usage: Option<Usage>,
    /// The generated plugin with the thread's skills, for this run only.
    plugin_dir: Option<PathBuf>,
    launched: Option<Launched>,
    /// Left running when the backend shut down: nothing more is read or written.
    detached: bool,
}

impl Run {
    fn new() -> Self {
        Run {
            proc: None,
            offset: None,
            spawned: false,
            ready: false,
            waiting: Vec::new(),
            pending: Vec::new(),
            next: 1,
            exited: false,
            retired: false,
            done: watch::Sender::new(false),
            stderr: VecDeque::new(),
            cancel: Cancellation::new(),
            msg_of_parent: HashMap::new(),
            block_count: HashMap::new(),
            streamed: HashSet::new(),
            summary_next: None,
            asked: HashMap::new(),
            open: Vec::new(),
            sent: Vec::new(),
            tasks: HashMap::new(),
            agents: Vec::new(),
            auto_turn: None,
            held_usage: None,
            plugin_dir: None,
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

    /// Writes a user message (that's the items `ids`), once Claude is ready for one.
    fn send(&mut self, ids: Vec<String>, msg: Value) {
        self.sent.push(Sent {
            ids,
            echo: echo_key(&msg["message"]["content"]),
        });
        if self.ready {
            self.write(&msg);
        } else {
            self.waiting.push(msg.to_string());
        }
    }

    fn control(&mut self, request: Value) {
        let request_id = format!("req_{}", self.next);
        self.next += 1;
        self.pending.push((
            request_id.clone(),
            request["subtype"].as_str().unwrap_or("").to_string(),
        ));
        self.write(&json!({"type": "control_request", "request_id": request_id, "request": request}));
    }

    fn is_open(&self, id: &str) -> bool {
        self.open.iter().any(|(r, _)| r == id)
    }

    fn set_open(&mut self, id: &str, open: OpenRequest) {
        match self.open.iter_mut().find(|(r, _)| r == id) {
            Some(o) => o.1 = open,
            None => self.open.push((id.to_string(), open)),
        }
    }

    fn take_open(&mut self, id: &str) -> Option<OpenRequest> {
        let at = self.open.iter().position(|(r, _)| r == id)?;
        Some(self.open.remove(at).1)
    }

    fn respond(&mut self, request_id: &str, response: Value) {
        // Left running: what's open stays as it was saved, for the backend that re-attaches to
        // answer.
        if self.detached {
            return;
        }
        self.take_open(request_id);
        self.write(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}));
    }

    fn respond_error(&self, request_id: &str, error: &str) {
        self.write(&json!({"type": "control_response", "response": {"subtype": "error", "request_id": request_id, "error": error}}));
    }

    fn open_ids(&self) -> Vec<String> {
        self.open.iter().map(|(id, _)| id.clone()).collect()
    }

    fn state(&self) -> RunState {
        RunState {
            v: 1,
            ready: self.ready,
            waiting: self.waiting.clone(),
            pending: self.pending.clone(),
            next: self.next,
            msg_of_parent: self.msg_of_parent.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            block_count: self.block_count.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            streamed: self.streamed.iter().cloned().collect(),
            summary_next: self.summary_next.clone(),
            asked: self.asked.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            open: self.open.clone(),
            sent: self.sent.clone(),
            tasks: {
                let mut t: Vec<(String, String)> = self.tasks.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                t.sort();
                t
            },
            agents: self.agents.clone(),
            auto_turn: self.auto_turn.clone(),
            held_usage: self.held_usage.clone(),
            plugin_dir: self.plugin_dir.as_ref().map(|p| p.to_string_lossy().into()),
            launched: self.launched.clone(),
            stale: false,
            steer_at: None,
            stop_at: None,
        }
    }

    fn restore(&mut self, st: &RunState) {
        self.ready = st.ready;
        self.waiting = st.waiting.clone();
        self.pending = st.pending.clone();
        self.next = st.next;
        self.msg_of_parent = st.msg_of_parent.iter().cloned().collect();
        self.block_count = st.block_count.iter().cloned().collect();
        self.streamed = st.streamed.iter().cloned().collect();
        self.summary_next = st.summary_next.clone();
        self.asked = st.asked.iter().cloned().collect();
        self.open = st.open.clone();
        self.sent = st.sent.clone();
        self.tasks = st.tasks.iter().cloned().collect();
        self.agents = st.agents.clone();
        self.auto_turn = st.auto_turn.clone();
        self.held_usage = st.held_usage.clone();
        self.plugin_dir = st.plugin_dir.as_ref().map(PathBuf::from);
        self.launched = st.launched.clone();
    }

    fn finish(&self) {
        self.done.send_replace(true);
    }

    /// Notes a call whose subagent it runs.
    fn add_agent(&mut self, call: &str) {
        if !self.agents.iter().any(|a| a == call) {
            self.agents.push(call.to_string());
        }
    }
}

/// A `can_use_tool` request being decided.
#[derive(Clone)]
struct CanUse {
    run: String,
    request: String,
    turn: Option<String>,
    tool_use_id: Option<String>,
    input: Value,
    name: String,
    kind: ToolKind,
    title: String,
    reason: Option<String>,
    standing: String,
    existing: Option<String>,
}

pub(crate) struct ClaudeSession {
    o: Arc<ClaudeCodeOptions>,
    /// Every run that hasn't been let go of: the current one, the last one, and ones being stopped.
    runs: HashMap<String, Run>,
    current: Option<String>,
    /// The run before, once it has exited (for its last checkpoint).
    last: Option<String>,
    /// The options changed since the run started: the next turn starts a new one.
    stale: bool,
    steer_timer: Option<Timer>,
    stop_timer: Option<Timer>,
    /// When those go off (ms since the epoch), for a checkpoint.
    steer_at: Option<u64>,
    stop_at: Option<u64>,
    /// A directory for the thread's generated files (skills, attached files), made when needed.
    tmp: Option<PathBuf>,
    closed: bool,
}

impl ClaudeSession {
    fn new(o: Arc<ClaudeCodeOptions>) -> Self {
        ClaudeSession {
            o,
            runs: HashMap::new(),
            current: None,
            last: None,
            stale: false,
            steer_timer: None,
            stop_timer: None,
            steer_at: None,
            stop_at: None,
            tmp: None,
            closed: false,
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

    /// The thread's directory for generated files.
    fn dir(&mut self) -> std::io::Result<PathBuf> {
        if self.tmp.is_none() {
            self.tmp = Some(private_temp_dir()?);
        }
        Ok(self.tmp.clone().unwrap())
    }

    /// Messages as one message on Claude's stdin: their content, one after the other.
    fn user_message(&mut self, ctx: &ThreadContext, messages: &[Message]) -> Value {
        let mut content = Vec::new();
        let mut errors = Vec::new();
        for m in messages {
            let mut dir = || self.dir();
            for p in message_parts(m, &mut dir, &mut errors) {
                content.push(match p {
                    Part::Text(text) => json!({"type": "text", "text": text}),
                    Part::Image { media_type, data } => {
                        json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
                    }
                    Part::Path {
                        path,
                        name,
                        media_type,
                        written,
                        ..
                    } => {
                        json!({"type": "text", "text": path_text(&path, &name, media_type.as_deref(), written)})
                    }
                });
            }
        }
        for e in errors {
            ctx.error(Error::Other(e));
        }
        json!({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": null, "session_id": ""})
    }

    // ---------- the process ----------

    /// The running process, or a new one. A new turn (`fresh`) restarts it if the options changed.
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

    /// Starts the current run once the runs being stopped have gone.
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

    /// Stops a run: closes its input, then signals it if it doesn't exit; or signals it straight
    /// away (`now`), when it has messages on its stdin that are going to another process instead.
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
            // Not started yet: it never will be.
            if !run.spawned {
                run.spawned = true;
                run.exited = true;
                run.finish();
            }
            return;
        };
        // Written down by a process that outlives the backend, so it's carried on after a restart.
        if proc.stop(grace, now) {
            return;
        }
        proc.close_input();
        if now {
            proc.kill(Signal::Term);
        }
        for (after, signal) in [(grace, Signal::Term), (grace * 2, Signal::Kill)] {
            let id = id.to_string();
            ctx.timer::<ClaudeSession>(after, move |s, _| {
                if let Some(r) = s.runs.get(&id)
                    && !r.exited
                    && let Some(p) = &r.proc
                {
                    p.kill(signal);
                }
            });
        }
    }

    fn steer_after(&mut self, ctx: &mut ThreadContext, id: &str, after: Duration) {
        self.clear_steer();
        self.steer_at = Some(now_ms() + after.as_millis() as u64);
        let id = id.to_string();
        self.steer_timer = Some(ctx.timer::<ClaudeSession>(after, move |s, ctx| {
            s.steer_at = None;
            s.requeue(ctx, &id);
        }));
    }

    fn clear_steer(&mut self) {
        if let Some(t) = self.steer_timer.take() {
            t.cancel();
        }
        self.steer_at = None;
    }

    /// Stops the run if the turn running now hasn't ended in `after`.
    fn stop_after(&mut self, ctx: &mut ThreadContext, id: &str, after: Duration) {
        let turn = ctx.turn_id().map(String::from);
        self.clear_stop();
        self.stop_at = Some(now_ms() + after.as_millis() as u64);
        let id = id.to_string();
        self.stop_timer = Some(ctx.timer::<ClaudeSession>(after, move |s, ctx| {
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

    /// Claude didn't take in steered messages after its turn: they go to a new process.
    fn requeue(&mut self, ctx: &mut ThreadContext, id: &str) {
        if self.current.as_deref() != Some(id) || self.runs.get(id).is_none_or(|r| r.exited) || ctx.queued().is_empty()
        {
            return;
        }
        self.stop(ctx, id, true, true);
        let next = self.ensure(ctx, false);
        let queued: Vec<Message> = ctx
            .queued()
            .into_iter()
            .map(|m| Message {
                id: m.id,
                text: m.text,
                attachments: m.attachments,
            })
            .collect();
        if !queued.is_empty() {
            let msg = self.user_message(ctx, &queued);
            let ids = queued.into_iter().map(|m| m.id).collect();
            if let Some(r) = self.run(&next) {
                r.send(ids, msg);
            }
        }
    }

    fn spawn(&mut self, ctx: &mut ThreadContext, id: &str) {
        if self.closed || self.runs.get(id).is_none_or(|r| r.retired) {
            if let Some(r) = self.run(id) {
                r.exited = true;
                r.finish();
            }
            return;
        }
        let args = self.args(ctx, id);
        let o = &self.o;
        let mut env: HashMap<String, String> = std::env::vars().collect();
        for (k, v) in &o.env {
            match v {
                Some(v) => env.insert(k.clone(), v.clone()),
                None => env.remove(k),
            };
        }
        if let Some(dir) = &o.config_dir {
            env.insert("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into());
        }
        let options = SpawnOptions {
            command: o.bin.clone(),
            args: o.bin_args.iter().cloned().chain(args).collect(),
            cwd: ctx.thread().cwd.as_ref().map(PathBuf::from),
            env,
            thread_id: ctx.thread_id().to_string(),
            run_id: id.to_string(),
        };
        let (proc, rx) = match ctx.spawner().spawn(options) {
            Ok(p) => p,
            Err(e) => {
                self.exited(
                    ctx,
                    id,
                    ExitStatus {
                        error: Some(e.to_string()),
                        ..Default::default()
                    },
                );
                return;
            }
        };
        let t = ctx.thread();
        let launched = Launched {
            model: t.model.clone(),
            effort: t.effort.clone(),
            permission_mode: t.permission_mode.map(|m| m.to_string()),
        };
        let tools = !ctx.config().tools.is_empty();
        let run = self.run(id).unwrap();
        run.proc = Some(proc);
        run.launched = Some(launched);
        forward(ctx, id, rx);
        let spawner = ctx.spawner().name().to_string();
        let run_id = id.to_string();
        ctx.set_thread(|t| {
            t.run = serde_json::from_value(json!({"id": run_id, "spawner": spawner, "started_at": now_iso()})).ok();
        });
        let mut init = json!({"subtype": "initialize"});
        if tools {
            init["sdkMcpServers"] = json!([APP_SERVER]);
        }
        self.run(id).unwrap().control(init);
    }

    fn args(&mut self, ctx: &ThreadContext, id: &str) -> Vec<String> {
        let t = ctx.thread();
        let config = ctx.config();
        let o = self.o.clone();
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--input-format",
            "stream-json",
        ]
        .map(String::from)
        .to_vec();
        args.extend(["--replay-user-messages", "--permission-prompt-tool", "stdio"].map(String::from));
        if !o.user_settings {
            args.extend(["--setting-sources", "", "--strict-mcp-config"].map(String::from));
        }
        args.push("--forward-subagent-text".into());
        if let Some(m) = &t.model {
            args.extend(["--model".into(), m.clone()]);
        }
        if let Some(e) = &t.effort {
            args.extend(["--effort".into(), e.clone()]);
        }
        if let Some(mode) = claude_permission_mode(t.permission_mode) {
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        if let Some(s) = &t.session_id {
            args.extend(["--resume".into(), s.clone()]);
        }
        let mut servers = Map::new();
        if !config.tools.is_empty() {
            servers.insert(APP_SERVER.into(), json!({"type": "sdk", "name": APP_SERVER}));
        }
        for (name, s) in &config.mcp_servers {
            servers.insert(
                name.clone(),
                match s {
                    crate::harness::McpServer::Stdio { command, args, env } => {
                        let mut v = json!({"type": "stdio", "command": command, "args": args});
                        if !env.is_empty() {
                            v["env"] = json!(env);
                        }
                        v
                    }
                    crate::harness::McpServer::Http { url, headers }
                    | crate::harness::McpServer::Sse { url, headers } => {
                        let kind = if matches!(s, crate::harness::McpServer::Sse { .. }) {
                            "sse"
                        } else {
                            "http"
                        };
                        let mut v = json!({"type": kind, "url": url});
                        if !headers.is_empty() {
                            v["headers"] = json!(headers);
                        }
                        v
                    }
                },
            );
        }
        if !servers.is_empty() {
            args.extend(["--mcp-config".into(), json!({"mcpServers": servers}).to_string()]);
        }
        if !config.skills.is_empty() {
            // A plugin of the run's own, made from the skills as they are now: Claude finds a
            // plugin's skills (as app:<name>) even with --setting-sources "", which hides
            // .claude/skills directories.
            let written = self.dir().and_then(|d| {
                let dir = d.join(format!("plugin-{id}"));
                write_plugin(&dir, &config.skills).map(|_| dir)
            });
            match written {
                Ok(dir) => {
                    args.extend(["--plugin-dir".into(), dir.to_string_lossy().into()]);
                    if let Some(r) = self.run(id) {
                        r.plugin_dir = Some(dir);
                    }
                }
                Err(e) => ctx.error(Error::Other(format!(
                    "the app's skills couldn't be written for Claude Code: {e}"
                ))),
            }
        }
        if let Some(p) = &config.system_prompt {
            args.extend(["--append-system-prompt".into(), p.clone()]);
        }
        args.extend(o.args.iter().cloned());
        args
    }

    fn exited(&mut self, ctx: &mut ThreadContext, id: &str, status: ExitStatus) {
        let Some(run) = self.runs.get_mut(id) else { return };
        if run.exited || run.detached {
            return;
        }
        run.exited = true;
        run.spawned = true;
        run.cancel.cancel();
        if let Some(dir) = &run.plugin_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        run.pending.clear();
        let retired = run.retired;
        let agents = run.agents.clone();
        let error = exit_error(&status, &run.stderr);
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
        // Its subagents end with it.
        ctx.stop_subagents(&agents);
        // A run that ends while its turn is running ends the turn (as interrupted, if it was).
        if !retired && ctx.turn_id().is_some() {
            self.clear_stop();
            self.clear_steer();
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
        // Runs that are over and aren't the last are let go of.
        let keep = [self.current.clone(), self.last.clone()];
        self.runs
            .retain(|rid, r| !r.exited || keep.iter().any(|k| k.as_deref() == Some(rid)));
        self.spawn_waiting(ctx);
    }

    /// Claude answered `initialize` (none: it refused).
    fn initialized(&mut self, ctx: &mut ThreadContext, id: &str, response: Option<Value>) {
        let Some(run) = self.run(id) else { return };
        if run.exited || run.detached {
            return;
        }
        if response.is_none() {
            // It refused: messages can't go in, so stop it, which ends the turn.
            run.stderr
                .push_back("Claude Code refused the initialize request.".into());
            self.stop(ctx, id, false, false);
            return;
        }
        run.ready = true;
        for line in std::mem::take(&mut run.waiting) {
            if let Some(p) = &run.proc {
                p.write(&line);
            }
        }
    }

    // ---------- what Claude says ----------

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
                self.line(ctx, id, &line);
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

    fn line(&mut self, ctx: &mut ThreadContext, id: &str, line: &str) {
        // Not a message: Claude Code doesn't write anything else to stdout, but be safe.
        let Ok(m) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if !m.is_object() {
            return;
        }
        let run = self.run(id).unwrap();
        if m["type"] == "control_response" {
            // Claude echoes our own responses back too; those aren't for a request of ours.
            let r = &m["response"];
            let request_id = r["request_id"].as_str().unwrap_or("");
            if let Some(at) = run.pending.iter().position(|(p, _)| p == request_id) {
                let (_, subtype) = run.pending.remove(at);
                let response = if r["subtype"] == "error" {
                    None
                } else {
                    Some(r.get("response").cloned().unwrap_or(json!({})))
                };
                if subtype == "initialize" {
                    self.initialized(ctx, id, response);
                }
            }
            return;
        }
        if run.retired || self.current.as_deref() != Some(id) {
            return;
        }
        self.message(ctx, id, &m);
    }

    fn message(&mut self, ctx: &mut ThreadContext, id: &str, m: &Value) {
        let parent = m["parent_tool_use_id"].as_str().map(String::from);
        let under = |mut item: Value| {
            if let Some(p) = &parent {
                item["parent_id"] = json!(p);
            }
            item
        };
        match m["type"].as_str().unwrap_or("") {
            "system" => {
                // Claude starts a turn by itself to tell the agent that a background subagent has
                // ended.
                if m["subtype"] == "init" && ctx.turn_id().is_none() {
                    ctx.begin_turn();
                    let turn = ctx.turn_id().map(String::from);
                    self.run(id).unwrap().auto_turn = turn;
                }
                if m["subtype"].as_str().is_some_and(|s| s.starts_with("task_")) {
                    self.task(ctx, id, m);
                }
                if m["subtype"] == "init"
                    && let Some(sid) = m["session_id"].as_str().filter(|s| !s.is_empty())
                    && ctx.thread().session_id.as_deref() != Some(sid)
                {
                    let sid = sid.to_string();
                    ctx.set_thread(|t| t.session_id = Some(sid));
                }
                if m["subtype"] == "compact_boundary" {
                    let meta = &m["compact_metadata"];
                    let uuid = m["uuid"].as_str().unwrap_or("").to_string();
                    let mut item = json!({"id": uuid, "type": "compaction"});
                    if let Some(t @ ("auto" | "manual")) = meta["trigger"].as_str() {
                        item["trigger"] = json!(t);
                    }
                    if let Some(n) = meta["pre_tokens"].as_u64() {
                        item["tokens_before"] = json!(n);
                    }
                    ctx.add_item(under(item));
                    self.run(id).unwrap().summary_next = Some(uuid);
                }
            }
            "stream_event" => {
                let ev = &m["event"];
                let run = self.run(id).unwrap();
                if ev["type"] == "message_start"
                    && let Some(mid) = ev["message"]["id"].as_str()
                {
                    run.msg_of_parent.insert(parent.clone(), mid.to_string());
                }
                if ev["type"] != "content_block_delta" {
                    return;
                }
                let (kind, text) = match ev["delta"]["type"].as_str() {
                    Some("text_delta") => (DeltaEventKind::Text, ev["delta"]["text"].as_str()),
                    Some("thinking_delta") => (DeltaEventKind::Reasoning, ev["delta"]["thinking"].as_str()),
                    _ => return,
                };
                let Some(text) = text.filter(|t| !t.is_empty()) else {
                    return;
                };
                let msg_id = match m["api_message_id"].as_str() {
                    Some(a) => a.to_string(),
                    None => run
                        .msg_of_parent
                        .get(&parent)
                        .cloned()
                        .unwrap_or_else(|| "undefined".into()),
                };
                let key = format!("{msg_id}:{}", ev["index"]);
                if run.streamed.insert(key.clone()) {
                    let ty = if kind == DeltaEventKind::Text {
                        "assistant_message"
                    } else {
                        "reasoning"
                    };
                    ctx.add_item(under(json!({"id": key, "type": ty, "text": ""})));
                }
                ctx.delta(&key, kind, text);
            }
            "assistant" => {
                let msg = &m["message"];
                let msg_id = msg["id"].as_str().unwrap_or("undefined").to_string();
                for block in msg["content"].as_array().into_iter().flatten() {
                    let run = self.run(id).unwrap();
                    let index = run.block_count.get(&msg_id).copied().unwrap_or(0);
                    run.block_count.insert(msg_id.clone(), index + 1);
                    let key = format!("{msg_id}:{index}");
                    match block["type"].as_str() {
                        Some(ty @ ("text" | "thinking")) => {
                            // The <synthetic> model's messages are Claude Code's own (an API error,
                            // say), which the result has.
                            if msg["model"] == "<synthetic>" {
                                continue;
                            }
                            let text = block[if ty == "text" { "text" } else { "thinking" }]
                                .as_str()
                                .unwrap_or("");
                            if run.streamed.contains(&key) {
                                ctx.update_item(&key, json!({"text": text}));
                            } else if !text.is_empty() {
                                let ty = if ty == "text" { "assistant_message" } else { "reasoning" };
                                ctx.add_item(under(json!({"id": key, "type": ty, "text": text})));
                            }
                        }
                        Some("tool_use") => {
                            let mut item =
                                Value::Object(claude_tool(block["name"].as_str().unwrap_or(""), &block["input"]));
                            item["id"] = block["id"].clone();
                            item["type"] = json!("tool_call");
                            item["status"] = json!("running");
                            ctx.add_item(under(item));
                        }
                        _ => {}
                    }
                }
            }
            "user" => self.user(ctx, id, m),
            "control_request" => {
                let request_id = m["request_id"].as_str().unwrap_or("").to_string();
                // Read again after a restart, and answered before it (though that wasn't saved):
                // Claude has its answer, and the user isn't asked again.
                if self
                    .run(id)
                    .and_then(|r| r.proc.as_ref())
                    .is_some_and(|p| p.answered(&request_id))
                {
                    return;
                }
                self.control_request(ctx, id, &request_id, m.get("request").cloned().unwrap_or(json!({})));
            }
            "control_cancel_request" => {
                // It no longer wants an answer, including one a policy is still working out.
                let run = self.run(id).unwrap();
                let request_id = m["request_id"].as_str().unwrap_or("");
                run.take_open(request_id);
                if let Some(ours) = run.asked.get(request_id).cloned() {
                    ctx.cancel_request(&ours);
                }
            }
            "result" => {
                let run = self.runs.get_mut(id).unwrap();
                // The turn's requests are moot now; its open questions are cancelled with it. A
                // background subagent's carry on.
                run.open
                    .retain(|(_, o)| tool_use_of(&o.request).is_some_and(|c| ctx.in_background(c)));
                // Its messages are done with: what was kept to translate them needn't be any more,
                // unless a background subagent is still sending its own.
                if !run
                    .agents
                    .iter()
                    .any(|a| ctx.item(a).is_some_and(running_in_background))
                {
                    run.msg_of_parent.clear();
                    run.block_count.clear();
                    run.streamed.clear();
                }
                if ctx.turn_id().is_none() {
                    return;
                }
                // The end of a turn Claude made by itself (to tell the agent a background subagent
                // ended) while a turn of the user's waited for it: the user's goes on to its own
                // result, which gets this one's usage too.
                let usage: Option<Usage> = serde_json::from_value(claude_usage(m)).ok();
                let run = self.run(id).unwrap();
                if m["origin"]["kind"] == "task-notification" && ctx.turn_id() != run.auto_turn.as_deref() {
                    run.held_usage = add_usage(run.held_usage.as_ref(), usage.as_ref());
                    return;
                }
                let usage = add_usage(run.held_usage.take().as_ref(), usage.as_ref());
                self.clear_stop();
                let failed = m["is_error"].as_bool().unwrap_or(false);
                let error = failed.then(|| {
                    let r = m["result"].as_str().unwrap_or("");
                    if !r.is_empty() {
                        return r.to_string();
                    }
                    let errors: Vec<&str> = m["errors"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    if !errors.is_empty() {
                        return errors.join("\n");
                    }
                    m["subtype"].as_str().unwrap_or("").to_string()
                });
                let end = TurnEnd {
                    ok: !failed,
                    error,
                    usage,
                    duration_ms: m["duration_ms"].as_f64().map(|d| d as u64),
                };
                let live = self.live_id().is_some();
                ctx.end_turn(end, live);
            }
            _ => {}
        }
    }

    fn user(&mut self, ctx: &mut ThreadContext, id: &str, m: &Value) {
        let content = &m["message"]["content"];
        let run = self.run(id).unwrap();
        if m["isReplay"].as_bool().unwrap_or(false) {
            // Claude took in a message: if it was a steered one, it's no longer queued. Claude
            // echoes a message as it was sent: match it with the first sent like that.
            let echo = echo_key(content);
            let Some(at) = run.sent.iter().position(|s| s.echo == echo) else {
                return;
            };
            for mid in run.sent.remove(at).ids {
                ctx.took_in(&mid);
            }
            // It's taking its messages in, and its turn for this one may run past the grace: the
            // grace is for a Claude that takes none in.
            if self.current.as_deref() == Some(id) {
                self.clear_steer();
            }
            return;
        }
        if let Some(text) = content.as_str() {
            if m["isSynthetic"].as_bool().unwrap_or(false)
                && let Some(c) = run.summary_next.take()
            {
                ctx.update_item(&c, json!({"summary": text}));
            }
            return;
        }
        for b in content.as_array().into_iter().flatten() {
            if b["type"] != "tool_result" {
                continue;
            }
            let Some(Item::ToolCall(it)) = ctx.item(b["tool_use_id"].as_str().unwrap_or("")) else {
                continue;
            };
            let is_error = b["is_error"].as_bool().unwrap_or(false);
            let result = slim(&result_text(&b["content"]));
            let tur = &m["tool_use_result"];
            let subagent = subagent_result(
                it,
                is_error,
                ctx.interrupted(),
                tur,
                result["content"].as_str().unwrap_or(""),
            );
            let (call, kind, status, path) = (
                it.id.clone(),
                it.kind,
                it.status,
                it.changes.first().map(|c| c.path.clone()),
            );
            let mut patch = Map::new();
            // A denied call stays denied; its result is what the agent was told.
            if status != ToolStatus::Denied {
                let s = if !is_error {
                    "completed"
                } else if ctx.interrupted() {
                    "cancelled"
                } else {
                    "failed"
                };
                patch.insert("status".into(), json!(s));
            }
            patch.insert("result".into(), Value::Object(result));
            if kind == ToolKind::Edit
                && tur.is_object()
                && !is_error
                && let Some(change) = edit_change(tur, path.as_deref())
            {
                patch.insert("changes".into(), json!([change]));
            }
            if let Some(s) = subagent {
                patch.insert("subagent".into(), json!(s));
                if let Some(run) = self.run(id) {
                    run.add_agent(&call);
                }
            }
            ctx.update_item(&call, Value::Object(patch));
        }
    }

    /// Claude's task_* messages about a subagent: an Agent call's, or a skill's forked one (whose
    /// Skill call becomes a subagent call). Other tasks (a command run in the background) aren't.
    fn task(&mut self, ctx: &mut ThreadContext, id: &str, m: &Value) {
        if m["subtype"] == "task_started"
            && m["task_type"] == "local_agent"
            && let Some(call) = m["tool_use_id"].as_str()
        {
            let Some(Item::ToolCall(c)) = ctx.item(call) else {
                return;
            };
            let mut patch = json!({"subagent": subagent_started(c, m)});
            if c.kind != ToolKind::Subagent {
                patch["kind"] = json!("subagent");
                if c.title.is_none()
                    && let Some(d) = m["description"].as_str().filter(|d| !d.is_empty())
                {
                    patch["title"] = json!(d);
                }
            }
            let call = c.id.clone();
            let Some(run) = self.run(id) else { return };
            if let Some(t) = m["task_id"].as_str() {
                run.tasks.insert(t.to_string(), call.clone());
            }
            run.add_agent(&call);
            ctx.update_item(&call, patch);
            return;
        }
        let call = match m["tool_use_id"].as_str() {
            Some(c) => c.to_string(),
            None => match m["task_id"].as_str().and_then(|t| self.run(id)?.tasks.get(t).cloned()) {
                Some(c) => c,
                None => return,
            },
        };
        let Some(Item::ToolCall(c)) = ctx.item(&call) else {
            return;
        };
        let Some(s) = &c.subagent else { return };
        let next = subagent_task(s, m);
        ctx.update_item(&call, json!({"subagent": next}));
    }

    fn control_request(&mut self, ctx: &mut ThreadContext, id: &str, request_id: &str, req: Value) {
        match req["subtype"].as_str() {
            Some("can_use_tool") => self.can_use_tool(ctx, id, request_id, req, None),
            Some("mcp_message") => self.mcp(ctx, id, request_id, req),
            other => {
                let msg = format!("agent-threads doesn't handle {} requests", other.unwrap_or("undefined"));
                self.run(id).unwrap().respond_error(request_id, &msg);
            }
        }
    }

    /// Whether Claude still wants this answered: not cancelled, its turn not over (unless it's a
    /// background subagent's, which carries on after it), its run not gone.
    fn wanted(&self, ctx: &ThreadContext, c: &CanUse) -> bool {
        self.runs
            .get(&c.run)
            .is_some_and(|r| r.is_open(&c.request) && !r.exited && !r.retired && !r.detached)
            && self.current.as_deref() == Some(c.run.as_str())
            && (ctx.turn_id() == c.turn.as_deref() || c.tool_use_id.as_deref().is_some_and(|t| ctx.in_background(t)))
    }

    fn allow(&mut self, ctx: &ThreadContext, c: &CanUse, input: Value) {
        if self.wanted(ctx, c) {
            self.run(&c.run)
                .unwrap()
                .respond(&c.request, json!({"behavior": "allow", "updatedInput": input}));
        }
    }

    fn deny(&mut self, ctx: &ThreadContext, c: &CanUse, message: &str) {
        if self.wanted(ctx, c) {
            self.run(&c.run)
                .unwrap()
                .respond(&c.request, json!({"behavior": "deny", "message": message}));
        }
    }

    /// A tool Claude wants to use: the policy decides, or the user is asked. `existing` is the
    /// request the user was asked with before the backend restarted, which is taken up again.
    fn can_use_tool(
        &mut self,
        ctx: &mut ThreadContext,
        id: &str,
        request_id: &str,
        req: Value,
        existing: Option<String>,
    ) {
        let tool_use_id = req["tool_use_id"].as_str().map(String::from);
        let input = if req["input"].is_null() {
            json!({})
        } else {
            req["input"].clone()
        };
        let run = self.run(id).unwrap();
        let turn = match &existing {
            Some(_) => run
                .open
                .iter()
                .find(|(r, _)| r == request_id)
                .and_then(|(_, o)| o.turn.clone()),
            None => ctx.turn_id().map(String::from),
        };
        run.set_open(
            request_id,
            OpenRequest {
                turn: turn.clone(),
                request: req.clone(),
            },
        );
        let tool_name = req["tool_name"].as_str().unwrap_or("");
        let t = claude_tool(tool_name, &input);
        let kind: ToolKind = serde_json::from_value(t["kind"].clone()).unwrap_or(ToolKind::Other);
        let reason = req["decision_reason"]
            .as_str()
            .filter(|r| !r.is_empty())
            .map(String::from);
        let name = t["name"].as_str().unwrap_or("").to_string();
        let c = CanUse {
            run: id.to_string(),
            request: request_id.to_string(),
            turn,
            tool_use_id: tool_use_id.clone(),
            input: input.clone(),
            standing: permission_key(kind, t.get("server").and_then(Value::as_str), &name),
            name,
            kind,
            title: title(&t),
            reason,
            existing,
        };

        if tool_name == "AskUserQuestion" {
            let qs = questions(&input);
            if qs.is_empty() {
                self.allow(ctx, &c, input);
                return;
            }
            let cu = c.clone();
            let answered = ThreadContext::answered::<ClaudeSession>(move |s, ctx, res: Resolution| {
                if res.outcome == ResolutionOutcome::Answer {
                    let mut answers = Map::new();
                    for (q, a) in &res.answers {
                        answers.insert(q.clone(), json!(a.join(", ")));
                    }
                    let mut input = cu.input.clone();
                    input["answers"] = Value::Object(answers);
                    s.allow(ctx, &cu, input);
                    if let Some(t) = &cu.tool_use_id {
                        ctx.update_item(t, json!({"status": "running"}));
                    }
                } else {
                    s.deny(
                        ctx,
                        &cu,
                        res.message
                            .as_deref()
                            .filter(|m| !m.is_empty())
                            .unwrap_or("The user didn't answer."),
                    );
                    if let Some(t) = &cu.tool_use_id {
                        ctx.update_item(t, json!({"status": "denied"}));
                    }
                }
            });
            let ours = ctx.ask_again(
                c.existing.as_deref(),
                json!({"type": "question", "questions": qs}),
                tool_use_id.as_deref(),
                answered,
                None,
            );
            self.run(id).unwrap().asked.insert(request_id.to_string(), ours);
            return;
        }

        let parent_id = tool_use_id
            .as_deref()
            .and_then(|t| ctx.item(t))
            .and_then(|i| i.parent_id().map(String::from));
        let query = PermissionQuery {
            name: c.name.clone(),
            kind,
            input: input.clone(),
            title: Some(c.title.clone()),
            command: t.get("command").and_then(Value::as_str).map(String::from),
            server: t.get("server").and_then(Value::as_str).map(String::from),
            reason: c.reason.clone(),
            tool_call_id: tool_use_id,
            parent_id,
        };
        // The user was asked before the backend restarted: they still are.
        let decided = if c.existing.is_some() {
            Decided::Now(PermissionDecision::Ask)
        } else {
            ctx.decide(query)
        };
        match decided {
            Decided::Now(d) => self.permit(ctx, c, d),
            Decided::Later(f) => ctx.spawn::<ClaudeSession, _>(f, move |s, ctx, d| s.permit(ctx, c, d)),
        }
    }

    fn permit(&mut self, ctx: &mut ThreadContext, c: CanUse, d: PermissionDecision) {
        // A policy that took a while may answer after Claude stopped asking.
        if !self.wanted(ctx, &c) {
            return;
        }
        let denied = |ctx: &mut ThreadContext, c: &CanUse| {
            if let Some(t) = &c.tool_use_id {
                ctx.update_item(t, json!({"status": "denied"}));
            }
        };
        match d {
            PermissionDecision::Allow => self.allow(ctx, &c, c.input.clone()),
            PermissionDecision::Ask => {
                let mut request =
                    json!({"type": "permission", "name": c.name, "kind": c.kind, "input": c.input, "title": c.title});
                if let Some(r) = &c.reason {
                    request["reason"] = json!(r);
                }
                let cu = c.clone();
                let answered = ThreadContext::answered::<ClaudeSession>(move |s, ctx, res: Resolution| {
                    if res.outcome == ResolutionOutcome::Allow {
                        s.allow(ctx, &cu, cu.input.clone());
                        if let Some(t) = &cu.tool_use_id {
                            ctx.update_item(t, json!({"status": "running"}));
                        }
                    } else {
                        s.deny(
                            ctx,
                            &cu,
                            res.message
                                .as_deref()
                                .filter(|m| !m.is_empty())
                                .unwrap_or("The user didn't allow this."),
                        );
                        denied(ctx, &cu);
                    }
                });
                let ours = ctx.ask_again(
                    c.existing.as_deref(),
                    request,
                    c.tool_use_id.as_deref(),
                    answered,
                    Some(c.standing.clone()),
                );
                self.run(&c.run).unwrap().asked.insert(c.request.clone(), ours);
            }
            PermissionDecision::Deny(why) => {
                let why = why.unwrap_or_else(|| "The app's permission policy doesn't allow this.".into());
                self.deny(ctx, &c, &why);
                denied(ctx, &c);
            }
        }
    }

    /// The app's tools, as an MCP server on the control channel.
    fn mcp(&mut self, ctx: &mut ThreadContext, id: &str, request_id: &str, req: Value) {
        let msg = req.get("message").cloned().unwrap_or(json!({}));
        let msg_id = msg.get("id").cloned().unwrap_or(json!(0));
        let reply = |s: &mut ClaudeSession, body: Value| mcp_reply(s, id, request_id, &msg_id, body);
        if req["server_name"] != APP_SERVER {
            let message = format!(
                "there's no MCP server {} in process",
                req["server_name"].as_str().unwrap_or("undefined")
            );
            return reply(self, json!({"error": {"code": -32601, "message": message}}));
        }
        if msg.get("id").is_none() {
            return reply(self, json!({"result": {}})); // a notification
        }
        let tools = &ctx.config().tools;
        match msg["method"].as_str().unwrap_or("") {
            "initialize" => {
                let version = msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18");
                reply(
                    self,
                    json!({"result": {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": APP_SERVER, "version": "1.0.0"}}}),
                )
            }
            "ping" => reply(self, json!({"result": {}})),
            "tools/list" => {
                let list: Vec<Value> = tools
                    .iter()
                    .map(|t| json!({"name": t.name(), "description": t.description(), "inputSchema": t.input_schema()}))
                    .collect();
                reply(self, json!({"result": {"tools": list}}))
            }
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
                let Some(tool) = ctx.config().tool(&name).cloned() else {
                    let text = format!("There's no tool {name}.");
                    return reply(
                        self,
                        json!({"result": {"content": [{"type": "text", "text": text}], "isError": true}}),
                    );
                };
                let tool_call_id = msg["params"]["_meta"]["claudecode/toolUseId"]
                    .as_str()
                    .map(String::from);
                let args = match &msg["params"]["arguments"] {
                    Value::Null => json!({}),
                    a => a.clone(),
                };
                // Saved before it runs, so a backend that restarts while it does answers it rather
                // than run it again (see reopen).
                let turn = ctx.turn_id().map(String::from);
                self.run(id).unwrap().set_open(
                    request_id,
                    OpenRequest {
                        turn,
                        request: req.clone(),
                    },
                );
                let (id, request_id) = (id.to_string(), request_id.to_string());
                ctx.persist::<ClaudeSession>(move |s, ctx, saved| {
                    let Some(run) = s.run(&id) else { return };
                    if saved.is_err() {
                        if run.detached {
                            return;
                        }
                        run.take_open(&request_id);
                        let text = "The app couldn't save its state, so it didn't run this tool.";
                        return mcp_reply(
                            s,
                            &id,
                            &request_id,
                            &msg_id,
                            json!({"result": {"content": [{"type": "text", "text": text}], "isError": true}}),
                        );
                    }
                    if !run.is_open(&request_id) || run.exited || run.detached {
                        return;
                    }
                    let tctx = ToolContext {
                        thread_id: ctx.thread_id().to_string(),
                        metadata: ctx.thread().metadata.clone(),
                        tool_call_id: tool_call_id.clone(),
                        cancelled: run.cancel.clone(),
                    };
                    ctx.spawn::<ClaudeSession, _>(run_tool(tool, args, tctx), move |s, ctx, out| {
                        // The backend shut down while it ran (and cancelled it): it's left open, as
                        // saved, for the backend that re-attaches to answer.
                        if s.run(&id).is_none_or(|r| r.detached) {
                            return;
                        }
                        if let Some(call) = &tool_call_id {
                            ctx.tool_output(call, out.structured.clone());
                        }
                        let mut result = json!({"content": [{"type": "text", "text": out.text}]});
                        if out.is_error {
                            result["isError"] = json!(true);
                        }
                        if let Some(st) = out.structured {
                            result["structuredContent"] = st;
                        }
                        mcp_reply(s, &id, &request_id, &msg_id, json!({"result": result}));
                        // Saved as answered, though no event says so: a restart doesn't answer it
                        // again.
                        ctx.persist::<ClaudeSession>(|_, _, _| {});
                    });
                });
            }
            other => {
                let message = format!("method {other} isn't supported");
                reply(self, json!({"error": {"code": -32601, "message": message}}))
            }
        }
    }

    /// A request of Claude's that was open when the backend restarted.
    fn reopen_request(&mut self, ctx: &mut ThreadContext, id: &str, request_id: &str, open: OpenRequest) {
        let req = open.request;
        if req["subtype"] == "can_use_tool" {
            let existing = self.run(id).unwrap().asked.get(request_id).cloned();
            return self.can_use_tool(ctx, id, request_id, req, existing);
        }
        let run = self.run(id).unwrap();
        run.take_open(request_id);
        if req["subtype"] == "mcp_message" {
            // An app tool that was running: it went with the backend, and isn't run again, since it
            // may have done what it does.
            let text = "The app restarted while this tool was running, so it may or may not have finished.";
            let msg_id = req["message"].get("id").cloned().unwrap_or(json!(0));
            run.respond(
                request_id,
                json!({"mcp_response": {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": text}], "isError": true}}}),
            );
        }
    }
}

impl HarnessSession for ClaudeSession {
    fn start(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>) {
        let id = self.ensure(ctx, true);
        // One message, however many there are: Claude makes a turn of each message waiting for it,
        // so several would run as turns of their own after this one's result.
        if !messages.is_empty() {
            let msg = self.user_message(ctx, &messages);
            self.run(&id)
                .unwrap()
                .send(messages.into_iter().map(|m| m.id).collect(), msg);
        }
    }

    fn steer(&mut self, ctx: &mut ThreadContext, message: Message) {
        let id = self.ensure(ctx, false);
        let msg = self.user_message(ctx, std::slice::from_ref(&message));
        self.run(&id).unwrap().send(vec![message.id], msg);
    }

    fn carry_over(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>) {
        let live = self.live_id();
        match live {
            Some(id) if !self.stale => {
                // Claude has them on its stdin, and takes them in once it's ready, which starts the
                // next turn. If it doesn't, they go to a new process.
                let grace = self.o.steer_grace;
                self.steer_after(ctx, &id, grace);
            }
            live => {
                // The next turn runs with the options as they are now, so in a new process if they
                // changed. The old one has the messages on its stdin, and mustn't act on them: it's
                // stopped at once.
                if let Some(id) = live {
                    self.stop(ctx, &id, true, true);
                }
                self.start(ctx, messages);
            }
        }
    }

    fn interrupt(&mut self, ctx: &mut ThreadContext) {
        let Some(id) = self.live_id() else { return };
        let grace = self.o.stop_grace;
        self.stop_after(ctx, &id, grace);
        let turn = ctx.turn_id().map(String::from);
        let send = move |s: &mut ClaudeSession, ctx: &mut ThreadContext| {
            if s.live_id().as_deref() == Some(id.as_str())
                && ctx.turn_id().map(String::from) == turn
                && let Some(run) = s.run(&id)
                && !run.detached
            {
                run.control(json!({"subtype": "interrupt"}));
            }
        };
        // A run that outlives the backend is saved first, its turn interrupted and when it's
        // stopped if the turn doesn't end: after a restart, one that Claude ignores the interrupt
        // in is still stopped.
        if ctx.spawner().durable() {
            ctx.persist::<ClaudeSession>(move |s, ctx, _| send(s, ctx));
        } else {
            send(self, ctx);
        }
    }

    fn live(&self) -> bool {
        self.live_id().is_some()
    }

    fn release(&mut self, ctx: &mut ThreadContext) {
        self.clear_steer();
        // It has the messages on its stdin: stopped at once, it can't take them in unseen.
        if let Some(id) = self.live_id() {
            self.stop(ctx, &id, true, true);
        }
    }

    fn options_changed(&mut self, _ctx: &mut ThreadContext) {
        self.stale = true;
    }

    fn close(&mut self, ctx: &mut ThreadContext) -> BoxFuture<()> {
        self.closed = true;
        self.clear_steer();
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
        let mut state = run.state();
        state.stale = self.stale;
        state.steer_at = self.steer_at;
        state.stop_at = self.stop_at;
        let proc = run.proc.as_ref();
        Some(RunCheckpoint {
            id,
            offset,
            dir: proc.and_then(|p| p.dir()),
            input: proc.and_then(|p| p.input_offset(&run.open_ids())),
            state: serde_json::to_value(state).ok(),
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
        let (proc, rx) = match ctx.spawner().attach(record) {
            Ok(p) => p,
            Err(e) => {
                ctx.error(Error::Other(format!(
                    "Claude Code's run {} can't be followed: {e}",
                    record.id
                )));
                return false;
            }
        };
        run.proc = Some(proc);
        let id = record.id.clone();
        self.runs.insert(id.clone(), run);
        self.current = Some(id.clone());
        forward(ctx, &id, rx);
        // A process started with other options than the thread's now is replaced at the next turn.
        let t = ctx.thread();
        let now = Launched {
            model: t.model.clone(),
            effort: t.effort.clone(),
            permission_mode: t.permission_mode.map(|m| m.to_string()),
        };
        self.stale = st.stale || st.launched.as_ref() != Some(&now);
        // Claude's requests that were open: the user's questions are taken up again, and the rest
        // (a policy that hadn't decided, a tool that was running) are dealt with again.
        // One answered before the restart, though that wasn't saved, is closed: Claude has its
        // answer.
        for (request_id, open) in st.open.clone() {
            let run = self.run(&id).unwrap();
            if run.proc.as_ref().is_some_and(|p| p.answered(&request_id)) {
                run.take_open(&request_id);
                continue;
            }
            self.reopen_request(ctx, &id, &request_id, open);
        }
        if let Some(at) = st.steer_at {
            self.steer_after(ctx, &id, Duration::from_millis(at.saturating_sub(now_ms())));
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
        // Only a process that outlives the backend can be left running.
        if !proc.can_detach() {
            return false;
        }
        self.closed = true;
        if let Some(t) = self.steer_timer.take() {
            t.cancel();
        }
        if let Some(t) = self.stop_timer.take() {
            t.cancel();
        }
        run.detached = true;
        proc.detach();
        run.cancel.cancel();
        true
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Passes a run's process events to the session, as jobs.
pub(crate) fn forward_events<S: HarnessSession>(
    ctx: &ThreadContext,
    id: &str,
    mut rx: mpsc::UnboundedReceiver<ProcessEvent>,
    handle: fn(&mut S, &mut ThreadContext, &str, ProcessEvent),
) {
    let (id, tx) = (id.to_string(), ctx.poster::<S>());
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            let id = id.clone();
            if !tx(Box::new(move |s: &mut S, ctx: &mut ThreadContext| {
                handle(s, ctx, &id, e)
            })) {
                return;
            }
        }
    });
}

fn forward(ctx: &ThreadContext, id: &str, rx: mpsc::UnboundedReceiver<ProcessEvent>) {
    forward_events::<ClaudeSession>(ctx, id, rx, |s, ctx, id, e| s.event(ctx, id, e));
}

/// Answers an `mcp_message` request with a JSON-RPC response (its `result` or `error`).
fn mcp_reply(s: &mut ClaudeSession, run: &str, request_id: &str, msg_id: &Value, body: Value) {
    if let Some(run) = s.run(run) {
        let mut response = json!({"jsonrpc": "2.0", "id": msg_id});
        for (k, v) in body.as_object().into_iter().flatten() {
            response[k] = v.clone();
        }
        run.respond(request_id, json!({"mcp_response": response}));
    }
}

/// What identifies a user message in Claude's echo of it: its text blocks and how many images it
/// has (Claude echoes the content as it was sent).
/// The tool call a request of Claude's is about: a can_use_tool's, or an app tool's mcp_message.
fn tool_use_of(req: &Value) -> Option<&str> {
    req["tool_use_id"]
        .as_str()
        .or_else(|| req["message"]["params"]["_meta"]["claudecode/toolUseId"].as_str())
}

fn echo_key(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return json!([s, 0]).to_string();
    }
    let blocks: Vec<&Value> = content.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let text: Vec<&str> = blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .map(|b| b["text"].as_str().unwrap_or(""))
        .collect();
    let images = blocks.iter().filter(|b| b["type"] == "image").count();
    json!([text.join("\n"), images]).to_string()
}

fn exit_error(status: &ExitStatus, stderr: &VecDeque<String>) -> String {
    if let Some(e) = &status.error {
        return format!("Claude Code couldn't be started: {e}");
    }
    let how = match (&status.signal, status.code) {
        (Some(s), _) => format!("was stopped by {s}"),
        (None, Some(c)) => format!("exited with code {c}"),
        (None, None) => "exited with code null".into(),
    };
    let tail = stderr.iter().cloned().collect::<Vec<_>>().join("\n");
    let tail = tail.trim();
    if tail.is_empty() {
        format!("Claude Code {how} during the turn.")
    } else {
        format!("Claude Code {how} during the turn.\n{}", last_chars(tail, 2000))
    }
}

pub(crate) fn last_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let skip = s.char_indices().nth(count - n).map_or(0, |(i, _)| i);
    &s[skip..]
}

/// Writes a plugin (named `app`) holding the skills, for --plugin-dir.
fn write_plugin(dir: &std::path::Path, skills: &[crate::harness::Skill]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join(".claude-plugin"))?;
    std::fs::write(
        dir.join(".claude-plugin").join("plugin.json"),
        json!({"name": APP_SERVER, "version": "1.0.0", "description": "The app's skills"}).to_string(),
    )?;
    write_skills(&dir.join("skills"), skills)?;
    Ok(())
}

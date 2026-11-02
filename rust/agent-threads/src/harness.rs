//! What a harness driver (Claude Code, Codex) and the core give each other. The core owns the
//! thread: its events, turns, steering queue, requests and permission policy. A driver owns the
//! harness process and translates between it and the core.

use std::any::Any;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::protocol::{Attachment, TurnSession, Usage};
use crate::sessions::{RewindError, RewindPoint};
use crate::store::RunRecord;
use crate::thread::ThreadContext;
use crate::tools::Tool;

/// An external MCP server: a command to run (stdio), or a URL (streamable HTTP, or SSE).
#[derive(Clone, Debug, PartialEq)]
pub enum McpServer {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

impl McpServer {
    /// A server to run, with its arguments.
    pub fn stdio(command: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        McpServer::Stdio {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: BTreeMap::new(),
        }
    }

    /// A streamable HTTP server.
    pub fn http(url: impl Into<String>) -> Self {
        McpServer::Http {
            url: url.into(),
            headers: BTreeMap::new(),
        }
    }

    /// One as the Node backend's options (and the fixtures) write it: `{command, args?, env?}` or
    /// `{type?, url, headers?}`.
    pub fn from_json(v: &Value) -> Option<Self> {
        let strings = |v: Option<&Value>| -> BTreeMap<String, String> {
            v.and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                        .collect()
                })
                .unwrap_or_default()
        };
        if let Some(url) = v.get("url").and_then(Value::as_str) {
            let headers = strings(v.get("headers"));
            return Some(if v.get("type").and_then(Value::as_str) == Some("sse") {
                McpServer::Sse {
                    url: url.into(),
                    headers,
                }
            } else {
                McpServer::Http {
                    url: url.into(),
                    headers,
                }
            });
        }
        let command = v.get("command")?.as_str()?.to_string();
        let args = v
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
        Some(McpServer::Stdio {
            command,
            args: args.unwrap_or_default(),
            env: strings(v.get("env")),
        })
    }
}

/// A skill: a directory with a SKILL.md (and anything it refers to), or a SKILL.md's text.
#[derive(Clone, Debug, PartialEq)]
pub enum Skill {
    Dir(PathBuf),
    Inline { name: String, content: String },
}

/// What a thread runs with: the instance's settings with the thread's own on top.
#[derive(Clone, Default)]
pub struct ThreadConfig {
    pub tools: Vec<Arc<dyn Tool>>,
    pub mcp_servers: BTreeMap<String, McpServer>,
    pub skills: Vec<Skill>,
    pub system_prompt: Option<String>,
}

impl ThreadConfig {
    pub fn tool(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.iter().find(|t| t.name() == name)
    }
}

/// A message to give the harness: its user_message item's id, text and attachments.
#[derive(Clone, Debug)]
pub struct Message {
    pub id: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
}

/// How a turn ended, as the harness says.
#[derive(Clone, Debug, Default)]
pub struct TurnEnd {
    pub ok: bool,
    pub error: Option<String>,
    pub usage: Option<Usage>,
    pub duration_ms: Option<u64>,
    /// The harness's own mark for the turn, in its session: Claude Code's last message in it, Codex's
    /// id for the turn (the turn_result's `session.at`).
    pub session_at: Option<String>,
}

/// What a driver needs saved to carry on with its run after the backend restarts.
#[derive(Clone, Debug)]
pub struct RunCheckpoint {
    /// The run's id.
    pub id: String,
    /// How far into its output the driver has read.
    pub offset: u64,
    /// Where its files are (the shim's run directory).
    pub dir: Option<String>,
    /// How much of its input had been written.
    pub input: Option<u64>,
    /// The driver's state for it, which `reattach` gets back.
    pub state: Option<Value>,
    /// It has exited, and the driver is done with it (its last checkpoint).
    pub ended: bool,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A driver's side, for one thread. Its methods are called on the thread's own task, one at a
/// time, with the thread's [`ThreadContext`].
pub trait HarnessSession: Send + Any {
    /// A turn started with these messages (the core has added them).
    fn start(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>);
    /// A message to steer the running turn with (the core has added it, queued).
    fn steer(&mut self, ctx: &mut ThreadContext, message: Message);
    /// The turn ended without taking in these queued messages, and the core has started the next
    /// turn for them.
    fn carry_over(&mut self, ctx: &mut ThreadContext, messages: Vec<Message>);
    /// Stop the running turn.
    fn interrupt(&mut self, ctx: &mut ThreadContext);
    /// Whether it can compact the harness's context ([`compact`](Self::compact)). Without it, the
    /// `compact` command is refused.
    fn can_compact(&self) -> bool {
        false
    }
    /// A turn started (with no messages) to compact the harness's context.
    fn compact(&mut self, _ctx: &mut ThreadContext) {}
    /// Where a rewind to before turn `index` of `sessions` (each turn's session, in order) takes the
    /// session (see [`resume_at_point`](crate::resume_at_point) and
    /// [`revert_point`](crate::revert_point)), or an error if it can't be rewound there; none if it
    /// can't be rewound at all. The core then sets the thread's session_id and resume_at, and calls
    /// options_changed().
    fn rewind_point(
        &self,
        _sessions: &[Option<TurnSession>],
        _index: usize,
    ) -> Option<Result<RewindPoint, RewindError>> {
        None
    }
    /// Whether a harness process is running that has the queued messages (it was sent them).
    fn live(&self) -> bool;
    /// The core gave up carrying the queued messages over: make sure nothing acts on them (stop a
    /// process that has them). They're sent again with the next turn's start.
    fn release(&mut self, ctx: &mut ThreadContext);
    /// The thread's options (model, effort, permission mode) or config changed.
    fn options_changed(&mut self, ctx: &mut ThreadContext);
    /// Stop the harness process, if it's running; the future resolves once it has gone.
    fn close(&mut self, ctx: &mut ThreadContext) -> BoxFuture<()>;

    // With a spawner whose processes outlive the backend (Spawner::durable). A driver that has none
    // of these has its runs stopped when the backend restarts, and their turns end.

    /// Whether it checkpoints its runs and can re-attach to them.
    fn durable(&self) -> bool {
        false
    }
    /// The running process's checkpoint, which the core saves with the events made so far; none if
    /// there's none. It's called whenever events are saved, so it must be quick.
    fn checkpoint(&mut self, _ctx: &ThreadContext) -> Option<RunCheckpoint> {
        None
    }
    /// Re-attaches to a run after a restart: `run.data.state` is a checkpoint of it, and the core
    /// has restored the thread (its running turn, its open requests) as of the same moment.
    /// Whether it could; if not, the core stops the run.
    fn reattach(&mut self, _ctx: &mut ThreadContext, _run: &RunRecord) -> bool {
        false
    }
    /// Stops following the running process and leaves it running, as the backend shuts down, to
    /// re-attach to it after. Whether there was one to leave; nothing else is called after this.
    fn detach(&mut self, _ctx: &mut ThreadContext) -> bool {
        false
    }

    fn as_any_mut(&mut self) -> &mut dyn Any;
}

/// A harness threads can run on.
pub trait Harness: Send + Sync {
    fn name(&self) -> &str;
    fn open(&self, ctx: &ThreadContext) -> Box<dyn HarnessSession>;
}

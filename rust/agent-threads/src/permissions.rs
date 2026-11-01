//! The app's permission policy: whether the agent may call a tool, decided in code or by asking the
//! user (which opens a `permission` request).

use std::fmt;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::protocol::{Thread, ToolKind};

/// A tool call the agent wants to make.
#[derive(Clone, Debug)]
pub struct PermissionQuery {
    /// The tool's name (an MCP or app tool's own name, without Claude's `mcp__server__` prefix).
    pub name: String,
    pub kind: ToolKind,
    pub input: Value,
    pub title: Option<String>,
    /// The MCP server, for an `mcp` tool.
    pub server: Option<String>,
    /// Why the harness is asking, when it says.
    pub reason: Option<String>,
    /// The tool_call item it's for.
    pub tool_call_id: Option<String>,
    /// The subagent call it's from.
    pub parent_id: Option<String>,
}

/// The thread a query is from.
#[derive(Clone, Debug)]
pub struct PermissionContext {
    pub thread_id: String,
    pub thread: Thread,
    pub metadata: Map<String, Value>,
}

/// A policy's answer: `Ask` asks the user; a deny can say why, and the agent is told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Deny(Option<String>),
    Ask,
}

impl PermissionDecision {
    /// A deny that tells the agent why.
    pub fn deny(why: impl Into<String>) -> Self {
        PermissionDecision::Deny(Some(why.into()))
    }
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type SyncPolicy = dyn Fn(&PermissionQuery, &PermissionContext) -> PermissionDecision + Send + Sync;
type AsyncPolicy = dyn Fn(PermissionQuery, PermissionContext) -> BoxFuture<PermissionDecision> + Send + Sync;

/// Whether the agent may call a tool: the same answer for every call, or one worked out in code.
#[derive(Clone)]
pub enum PermissionPolicy {
    Always(PermissionDecision),
    Sync(Arc<SyncPolicy>),
    Async(Arc<AsyncPolicy>),
}

impl fmt::Debug for PermissionPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PermissionPolicy::Always(d) => write!(f, "PermissionPolicy::Always({d:?})"),
            PermissionPolicy::Sync(_) => f.write_str("PermissionPolicy::Sync(..)"),
            PermissionPolicy::Async(_) => f.write_str("PermissionPolicy::Async(..)"),
        }
    }
}

impl Default for PermissionPolicy {
    /// Asks the user about every call.
    fn default() -> Self {
        PermissionPolicy::ask()
    }
}

impl PermissionPolicy {
    pub fn allow() -> Self {
        PermissionPolicy::Always(PermissionDecision::Allow)
    }
    pub fn ask() -> Self {
        PermissionPolicy::Always(PermissionDecision::Ask)
    }
    pub fn deny() -> Self {
        PermissionPolicy::Always(PermissionDecision::Deny(None))
    }

    /// A policy that decides at once: `PermissionPolicy::from_fn(|q, _| if q.kind == ToolKind::Read
    /// { Allow } else { Ask })`.
    pub fn from_fn(f: impl Fn(&PermissionQuery, &PermissionContext) -> PermissionDecision + Send + Sync + 'static) -> Self {
        PermissionPolicy::Sync(Arc::new(f))
    }

    /// A policy that takes a while (it looks something up, say).
    pub fn from_async<F, Fut>(f: F) -> Self
    where
        F: Fn(PermissionQuery, PermissionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = PermissionDecision> + Send + 'static,
    {
        PermissionPolicy::Async(Arc::new(move |q, c| Box::pin(f(q, c))))
    }
}

/// A policy's answer: at once, or later.
pub enum Decided {
    Now(PermissionDecision),
    Later(BoxFuture<PermissionDecision>),
}

/// Runs a policy; synchronously when it answers synchronously, so its effects keep their order. A
/// policy that fails (panics) denies.
pub(crate) fn decide(policy: &PermissionPolicy, query: PermissionQuery, ctx: PermissionContext) -> Decided {
    let failed = |why: String| PermissionDecision::deny(format!("The permission policy failed: {why}"));
    match policy {
        PermissionPolicy::Always(d) => Decided::Now(d.clone()),
        PermissionPolicy::Sync(f) => match catch_unwind(AssertUnwindSafe(|| f(&query, &ctx))) {
            Ok(d) => Decided::Now(d),
            Err(p) => Decided::Now(failed(
                p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
            )),
        },
        PermissionPolicy::Async(f) => {
            let fut = f(query, ctx);
            Decided::Later(Box::pin(async move {
                match tokio::spawn(fut).await {
                    Ok(d) => d,
                    Err(e) => failed(crate::tools::panic_message(e)),
                }
            }))
        }
    }
}

/// Which tool a query is about, for a standing answer: its kind, its MCP server and its name, since
/// two servers (or an app tool and a built-in) can have tools of the same name.
pub(crate) fn permission_key(kind: ToolKind, server: Option<&str>, name: &str) -> String {
    json!([kind, server, name]).to_string()
}

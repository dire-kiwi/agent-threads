//! The app's own tools, which the agent calls like any other and the backend runs in process.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde_json::{Map, Value};
use tokio::sync::Notify;

/// What a tool's run gets besides its arguments.
#[derive(Clone, Debug)]
pub struct ToolContext {
    pub thread_id: String,
    /// The thread's metadata, as the app gave it: e.g. which user the thread is for.
    pub metadata: Map<String, Value>,
    /// The tool_call item this call is, when the harness says.
    pub tool_call_id: Option<String>,
    /// Cancelled when the thread's harness process goes away before the tool returns.
    pub cancelled: Cancellation,
}

/// What a tool returns: text for the agent, with structured output if it has some, or an error.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
    pub structured: Option<Value>,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        ToolOutput { text: text.into(), ..Default::default() }
    }

    /// An error, which the agent is told.
    pub fn error(text: impl Into<String>) -> Self {
        ToolOutput { text: text.into(), is_error: true, structured: None }
    }

    /// With structured output as well as the text.
    pub fn with_structured(mut self, structured: Value) -> Self {
        self.structured = Some(structured);
        self
    }
}

impl From<String> for ToolOutput {
    fn from(text: String) -> Self {
        ToolOutput::text(text)
    }
}

impl From<&str> for ToolOutput {
    fn from(text: &str) -> Self {
        ToolOutput::text(text)
    }
}

impl<T: Into<ToolOutput>, E: fmt::Display> From<Result<T, E>> for ToolOutput {
    fn from(r: Result<T, E>) -> Self {
        match r {
            Ok(out) => out.into(),
            Err(e) => ToolOutput::error(e.to_string()),
        }
    }
}

/// A tool the app defines. [`tool`] makes one from a closure.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// Its arguments' JSON Schema (an object schema).
    fn input_schema(&self) -> &Value;
    /// Runs it. An error is returned to the agent as the tool's error.
    async fn run(&self, args: Value, ctx: ToolContext) -> ToolOutput;
}

struct FnTool<F> {
    name: String,
    description: String,
    input: Value,
    run: F,
}

#[async_trait]
impl<F, Fut, O> Tool for FnTool<F>
where
    F: Fn(Value, ToolContext) -> Fut + Send + Sync,
    Fut: Future<Output = O> + Send,
    O: Into<ToolOutput>,
{
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn input_schema(&self) -> &Value {
        &self.input
    }
    async fn run(&self, args: Value, ctx: ToolContext) -> ToolOutput {
        (self.run)(args, ctx).await.into()
    }
}

/// A tool from a closure: `tool("lookup_order", "Looks up an order", schema, |args, ctx| async move
/// { format!("Order {}", args["order_id"]) })`. The closure returns anything that's
/// `Into<ToolOutput>`: text, a [`ToolOutput`], or a `Result` of either (an error is the tool's
/// error).
pub fn tool<F, Fut, O>(name: impl Into<String>, description: impl Into<String>, input: Value, run: F) -> Arc<dyn Tool>
where
    F: Fn(Value, ToolContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = O> + Send + 'static,
    O: Into<ToolOutput> + 'static,
{
    Arc::new(FnTool { name: name.into(), description: description.into(), input, run })
}

/// Runs a tool; one that panics returns its panic to the agent as an error.
pub(crate) async fn run_tool(tool: Arc<dyn Tool>, args: Value, ctx: ToolContext) -> ToolOutput {
    match tokio::spawn(async move { tool.run(args, ctx).await }).await {
        Ok(out) => out,
        Err(e) => ToolOutput::error(panic_message(e)),
    }
}

pub(crate) fn panic_message(e: tokio::task::JoinError) -> String {
    match e.try_into_panic() {
        Ok(p) => p
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "it panicked".into()),
        Err(e) => e.to_string(),
    }
}

/// Whether something was cancelled, and a way to wait until it is.
#[derive(Clone, Default)]
pub struct Cancellation(Arc<(AtomicBool, Notify)>);

impl fmt::Debug for Cancellation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Cancellation({})", self.is_cancelled())
    }
}

impl Cancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.0.load(Ordering::SeqCst)
    }

    /// Resolves once it's cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.1.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn cancel(&self) {
        self.0.0.store(true, Ordering::SeqCst);
        self.0.1.notify_waiters();
    }
}

//! agent-threads: run threads of agents on Claude Code and Codex.
//!
//! [`AgentThreads`] is the backend an app embeds: it creates threads, takes [`Command`]s (send,
//! interrupt, respond, set_options), runs each thread's harness, and sends every thread's
//! [`ThreadEvent`]s to its subscribers, which the app carries over its own transport. See
//! docs/design.md and spec/PROTOCOL.md in the repository.
//!
//! [`protocol`] has the types of the shared spec (`spec/`): items, requests, events, commands and
//! snapshots, and [`reducer`] folds events into a thread's state.

pub mod protocol;
pub mod reducer;
pub mod store;
pub mod stores;

mod agent_threads;
mod attachments;
mod claude;
mod codex;
mod harness;
mod ids;
mod mcp_http;
mod permissions;
mod shim;
mod skills;
mod spawner;
mod thread;
mod tools;

pub use agent_threads::{
    AgentThreads, Capabilities, CreateOptions, Error, Options, Recovered, Result, SendOptions, ThreadOptions,
};
pub use claude::{ClaudeCodeOptions, claude_code};
pub use codex::{AppTools, CodexOptions, codex};
pub use harness::{
    BoxFuture, Harness, HarnessSession, McpServer, Message, RunCheckpoint, Skill, ThreadConfig, TurnEnd,
};
pub use permissions::{Decided, PermissionContext, PermissionDecision, PermissionPolicy, PermissionQuery};
pub use protocol::{Command, Item, Snapshot, Thread, ThreadEvent};
pub use shim::{RUN_FORMAT, ShimOptions, shim};
pub use spawner::{ExitStatus, HarnessProcess, ProcessEvent, Signal, SpawnOptions, Spawned, Spawner, direct};
pub use store::{RunRecord, Store, StoreError, StoreErrorKind, StoreResult};
pub use stores::file::FileStore;
pub use stores::memory::{MemoryState, MemoryStore};
pub use stores::sqlite::SqliteStore;
pub use thread::{Actor, Answered, SessionJob, ThreadContext, Timer, Turn};
pub use tools::{Cancellation, Tool, ToolContext, ToolOutput, tool};

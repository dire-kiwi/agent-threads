# agent-threads (Rust)

agent-threads' Rust backend: threads of agents on Claude Code (`claude -p`, stream-json) and Codex
(`codex app-server`), on tokio. It has the same model and behaviour as the Node backend
([ts/packages/node](../../ts/packages/node/README.md)), and passes the same conformance suite: every
recorded fixture in [spec/fixtures](../../spec/fixtures/README.md), with the harness as a child
process and under `agent-threads-shim`, and the store cases in
[spec/conformance](../../spec/conformance/store.md). The wire format is
[spec/PROTOCOL.md](../../spec/PROTOCOL.md); the types are generated from `spec/schema`
(`agent_threads::protocol`).

It has no network layer: the app subscribes to events and hands commands in, over whatever
transport it has ([docs/transport.md](../../docs/transport.md), with a Tauri example).
[examples/chat-rust](../../examples/chat-rust/README.md) is an axum server that does it over a
WebSocket.

Nothing is published yet: depend on it with `agent-threads = { git =
"https://github.com/dire-kiwi/agent-threads", branch = "main" }`, or a `path` into a checkout
([how](../../README.md#rust-crate)).

```rust
use std::sync::Arc;

use agent_threads::protocol::ToolKind;
use agent_threads::*;
use tokio::sync::broadcast::error::RecvError;

let sdk = AgentThreads::new(Options {
    store: Some(Arc::new(SqliteStore::open("threads.db")?)),     // or MemoryStore, FileStore, your own
    harnesses: vec![claude_code(Default::default()), codex(Default::default())], // these by default
    capabilities: Capabilities {
        tools: vec![tool("lookup_order", "Looks up an order.", schema, |args, ctx| async move {
            format!("Order {}: 3 blue widgets.", args["order_id"])
        })],
        mcp_servers: [("github".into(), McpServer::stdio("gh-mcp", ["--stdio"]))].into(),
        skills: vec![Skill::Dir("skills/support-agent".into())],
        permissions: Some(PermissionPolicy::from_fn(|q, _| match q.kind {
            ToolKind::Read | ToolKind::Search => PermissionDecision::Allow,
            _ => PermissionDecision::Ask, // asks the user: a `permission` request
        })),
        system_prompt: Some("You're a support agent.".into()),
    },
    spawner: Some(shim("agent-threads-shim", ShimOptions::new("data/runs"))), // optional; direct() by default
    ..Default::default()
});
sdk.recover().await?;                                 // with the shim: re-attach to runs that outlived the last process

let thread = sdk.create(CreateOptions { harness: Some("claude".into()), model: Some("haiku".into()), ..Default::default() }).await?;
let mut events = sdk.subscribe();                     // tokio broadcast: every thread's events, deltas included
tokio::spawn(async move {
    loop {
        match events.recv().await {
            Ok(e) => { /* send it to the clients */ }
            Err(RecvError::Lagged(_)) => continue,    // missed some: clients see the gap in seq, and catch up
            Err(RecvError::Closed) => break,
        }
    }
});
sdk.handle_json(command_from_a_client).await?;        // send / interrupt / respond / set_options / rewind / new_session / compact
let snapshot = sdk.snapshot(&thread.id).await?;       // for a client that just connected
let window = sdk.snapshot_window(&thread.id, 50).await?; // or its last 50 items, and what they need
let page = sdk.items_before(&thread.id, window.start.unwrap_or(0), 50).await?; // as it scrolls back
let missed = sdk.events_since(&thread.id, seq, None).await?; // for one catching up
```

## Threads

`create` makes a thread (idle); its process starts at its first message. With
`CreateOptions::session_id` (Claude Code's session id, or Codex's thread id) it adopts a
conversation the harness already has: its first turn resumes it. `handle(Command)` (or
`handle_json`, which checks the JSON is a command first) carries out the protocol's commands, and
`send`, `interrupt`, `respond`, `set_options`, `rewind`, `new_session` and `compact` are the same
from code. A command it can't carry out (an unknown thread, a malformed command, an AgentThreads
that's closed) is an `Error::Command`, for the app to tell its client; the store failing is an
`Error::Store`. `get`, `list`, `delete`,
`configure` (a thread's own tools, servers, skills and policy, which aren't stored: give them again
after a restart; a `CapabilitiesUpdate` changes only what it gives) and `close` round it off.

`rewind(id, turn_id)` takes the conversation back to before a turn (the harness forgets it and the
turns after, whose items are removed), `new_session(id)` has the next turn start a new
conversation, and `compact(id)` compacts the harness's context in a turn of its own
([spec/PROTOCOL.md](../../spec/PROTOCOL.md#sessions)). They're refused while a turn runs. Each
`turn_result` records the session the turn ended in (`session`), which is what a rewind works from;
a custom `HarnessSession` takes part with `rewind_point` (`resume_at_point` or `revert_point`, or its
own) and `can_compact`/`compact`, and without them refuses both.

`subscribe()` is a `tokio::sync::broadcast` receiver of every thread's events. One that falls more
than `Options::event_capacity` (4096) events behind gets `RecvError::Lagged`: it should catch up with
`events_since`, as a client that sees a gap in `seq` does. `reducer::apply_event` folds events into a
`Snapshot` by the protocol's rules, for a Rust client.

`snapshot` is a thread's state now, including text streamed so far and answered requests with their
`resolution` (`reducer::open_requests` gives the open ones). A thread can run to thousands of items:
`snapshot_window(id, limit)` is a window of its last `limit` items, and what they need from before
them, and `items_before(id, before, limit)` a page of the items before a window's `start`, for a
client loading earlier ones (spec/PROTOCOL.md, "Windows"). The `window` module has the same as
functions of a `Snapshot` (`snapshot_window`, `item_page`), and `with_page` to put a page into a
window, for a Rust client.

Each thread runs on a task of its own, which owns its state and its driver and does one thing at a
time, as Node's event loop does for the Node backend: what the harness says, commands, timers and
the answers of async work (a policy, a tool, the store). Events made together are saved together,
in order, before the next batch; a store that fails is retried with backoff, and nothing is lost or
numbered around a gap.

## Tools and permissions

[docs/tools.md](../../docs/tools.md) has tools, MCP servers, skills and policies in all three
backends.

`tool(name, description, schema, |args, ctx| async move { … })` makes an app tool from a closure
returning text, a `ToolOutput` (with `is_error` or `structured` output, which goes in the call's
`result.structured`), or a `Result` of either; or implement the `Tool` trait. `ctx` has the thread's
id and metadata, the tool call's id, and `cancelled`, a `Cancellation` whose `cancelled().await`
resolves if the harness process goes away first (`is_cancelled()` asks without waiting). A tool that panics returns its panic to the agent as an error.

`PermissionPolicy` is `allow()`, `ask()` (the default), `deny()`, `from_fn` (decided at once) or
`from_async` (one that looks something up). A `PermissionQuery` has the tool's name, kind, input,
title, command (shell calls), MCP server and the call it's for. An answer given `always` stands for
the thread, per tool. Claude's AskUserQuestion and Codex's requestUserInput are always questions to
the user.

## What the protocol leaves out

See [Pass-through](../../spec/PROTOCOL.md#pass-through) in the protocol:

```rust
let sdk = AgentThreads::new(Options {
    raw: true, // events, items and requests carry the harness message they came from
    on_harness_message: Some(Arc::new(|m: &HarnessMessage| {
        // every line a harness writes (m.line, and m.message parsed), e.g. Claude's system
        // messages or Codex's token usage
    })),
    ..Default::default()
});
let usage = sdk.control(&id, json!({"subtype": "get_context_usage"})).await?; // Claude Code
let limits = sdk.control(&id, json!({"method": "account/rateLimits/read"})).await?; // Codex
```

`control` needs the thread's process to be running (it is from the first `send` until the SDK
closes): it's an `Error::Command` when it isn't, and an `Error::Control` when the harness refuses the
request or exits first. Usage limits are in each thread's `rate_limits`, and Claude's API retries
and hooks are `notice` items (codes `retry` and `hook`).

## Stores

`MemoryStore` (`MemoryStore::with_state` shares one between instances), `FileStore` (a directory of
JSONL files, the same format as the Node backend's) and `SqliteStore` (rusqlite with SQLite bundled,
the same schema as Node's) implement `Store`. Threads, events and snapshots go through a store as
`serde_json::Value`, so it keeps fields it doesn't know as they are (spec/conformance/store.md);
`RunRecord` keeps unknown fields too. An app can implement `Store` on its own database; the
conformance runner is `tests/store.rs`.

## Claude Code and Codex

`claude_code(ClaudeCodeOptions)` and `codex(CodexOptions)` drive the CLIs as the Node backend's
drivers do (spec/fixtures/README.md, "What the backend must send"): one process per thread, kept
between turns; steering; interrupts; resume; app tools as Claude's in-process MCP server over the
control channel, or Codex's dynamic tools with a loopback streamable-HTTP MCP server (127.0.0.1, a
random bearer token) where Codex won't take them (`AppTools::Mcp` asks for it); MCP servers; skills
(a generated plugin for Claude, `skills/extraRoots/set` for Codex, which also turns off the user's
and the project's skills); and isolated config: Claude runs with `--setting-sources ""` and
`--strict-mcp-config` unless `user_settings`, and Codex with a CODEX_HOME of the app's own
(`~/.agent-threads/codex` by default) with the user's login (`auth.json`) linked in, unless
`user_config`. Options name the binary (`bin`, `bin_args`), add arguments and environment, and set
the graces: `stop_grace` (10s) for an interrupt to end the turn, `close_grace` (5s) for a process to
exit after its input closes, and Claude's `steer_grace` (30s) to take in steered messages after a
turn.

A thread's own `LaunchOptions` (`CreateOptions::launch`, or `ThreadOptions::launch` with
`set_options`) add arguments, environment changes, directories (`--add-dir`, or Codex's writable
roots) and a config directory (CLAUDE_CONFIG_DIR, or a CODEX_HOME used as it is) to those its
process starts with. They're stored with the thread, but not sent to clients, and apply from its
next process ([docs/tools.md](../../docs/tools.md#per-thread-launch-options)).

Both drivers' Codex and Claude messages are handled as `serde_json::Value`s; Codex's app-server
types aren't generated for Rust (the Node backend generates them for TypeScript).

## Processes, and runs that survive a restart

[docs/shim.md](../../docs/shim.md) says when to use the shim, and how recovering works.

`direct()` (the default) runs each harness as a child process in its own process group. `shim(path,
ShimOptions::new(runs_dir))` runs it under [agent-threads-shim](../../shim/README.md) and follows its
run directory ([spec/RUNDIR.md](../../spec/RUNDIR.md)): the offset into `out.jsonl`, with what the
driver needs to carry on reading, is saved with the events made from the output before it, so a
backend killed at any point re-attaches (`recover()`, or the first command for the thread) and
carries on without losing or repeating events, input or answers. `close(false)` leaves shim runs
going for the next process; `close(true)` stops them. A run the backend can't follow is stopped,
and its turn ends with a `run.lost` notice. `recover()` also prunes finished runs' directories
(kept 14 days), and stops runs no store follows. The run directory and the drivers' checkpoint state
are the same as the Node backend's.

## Tests

```sh
cd rust && cargo test     # needs node (the fake CLI, check-events.mjs, mini-claude/mini-codex) and cargo (it builds the shim)
AGENT_THREADS_LIVE=1 cargo test --test live   # against the real claude and codex: a cent or so
```

`tests/fixtures.rs` runs every fixture with both spawners (`AGENT_THREADS_SPAWNERS=direct` for one),
comparing the events with `spec/tools/check-events.mjs`; `tests/store.rs` the store cases;
`tests/restart.rs` kills a backend (this test binary, run as `backend_process`) mid-turn and
recovers; `tests/driver.rs` and `tests/codex.rs` cover what the recordings don't, against the Node
backend's `mini-claude.mjs` and `mini-codex.mjs`; `tests/spawner.rs` the spawners.

# agent-threads

A library for apps to run threads of agents on **Claude Code** (`claude -p`, stream-json) and
**Codex** (`codex app-server`): start a thread, send messages, steer it while it runs, approve its
tool calls, answer its questions, watch its subagents, and resume it later. It has native backends
in **Go**, **Rust** and **TypeScript (Node)**, with the same model and behaviour, and **React**
components to draw a thread.

There's no network layer. A backend sends JSON **events** and takes JSON **commands**, and the app
carries them between its backend and its frontend over whatever it already has: a WebSocket, SSE,
Electron or Tauri IPC ([docs/transport.md](docs/transport.md)). The app gives the agent its own
**tools** (functions in its own language), **MCP servers** and **skills**, and decides each tool
call in code or by asking the user ([docs/tools.md](docs/tools.md)). With
[agent-threads-shim](docs/shim.md), runs outlive the backend's process and carry on after a restart.

```
 App backend (Go / Rust / Node)                         App frontend (React, or anything)
┌──────────────────────────────────┐                  ┌──────────────────────────────┐
│ agent-threads                    │   events (JSON)  │ @dire-kiwi/agent-threads-    │
│  threads · turns · steering      │ ───────────────▶ │   react                      │
│  store (memory, file, SQLite)    │                  │  applyEvent() reducer        │
│  app tools · MCP · skills        │ ◀─────────────── │  useThread() hooks           │
│  permission policy               │ commands (JSON)  │  <Thread> <Composer>         │
│  subscribe() · handle(command)   │  the app's own   │  <PermissionCard> ...        │
│  snapshot() · eventsSince()      │    transport     │  tool renderer registry      │
└───────┬───────────────┬──────────┘                  └──────────────────────────────┘
        │               │
   claude -p       codex app-server
   stream-json     JSON-RPC over stdio
   (as child processes, or under agent-threads-shim to outlive the backend)
```

Every backend drives the same CLIs the user already has installed and logged in, and translates
them into one normalized model: a thread is a list of **items** (messages, reasoning, tool calls,
subagents, notices, turn results) plus its open **requests** (permissions and questions), changed
by numbered, replayable **events** ([spec/PROTOCOL.md](spec/PROTOCOL.md)). The JSON Schemas in
[spec/schema](spec/schema) are the source of truth, the types in every language are generated from
them, and recorded Claude and Codex sessions ([spec/fixtures](spec/fixtures/README.md)) are the
conformance suite all three backends pass.

## Quick start

You need `claude` and/or `codex` installed and logged in. Threads see only what the app gives them
(not your own Claude Code or Codex config); the login is yours. Nothing is published yet: see
[Using it from this repository](#using-it-from-this-repository) for how to depend on it.

### Node

```ts
import { AgentThreads, SqliteStore, defineTool } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({
  store: new SqliteStore("threads.db"),
  tools: [
    defineTool<{ order_id: string }>({
      name: "lookup_order",
      description: "Looks up an order by its id.",
      input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      run: ({ order_id }) => `Order ${order_id}: 3 blue widgets, shipped.`,
    }),
  ],
  permissions: (q) => (q.kind === "read" || q.name === "lookup_order" ? "allow" : "ask"),
});

sdk.subscribe((event) => broadcast(event)); // events out, to your clients
const thread = await sdk.create({ harness: "claude", model: "haiku" });
await sdk.handle({ type: "send", thread_id: thread.id, text: "What's in order 42?" }); // commands in
```

[ts/packages/node](ts/packages/node/README.md) · [examples/chat-node](examples/chat-node/README.md)

### Go

```go
import (
	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
	"github.com/dire-kiwi/agent-threads/go/sqlitestore"
)

store, err := sqlitestore.Open("threads.db")
sdk := agentthreads.New(agentthreads.Options{
	Store: store,
	Capabilities: agentthreads.Capabilities{
		Tools: []agentthreads.Tool{agentthreads.TypedTool("lookup_order", "Looks up an order by its id.",
			`{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}`,
			func(ctx context.Context, a struct{ OrderID string `json:"order_id"` }, call agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
				return agentthreads.Text("Order " + a.OrderID + ": 3 blue widgets, shipped."), nil
			})},
		Permissions: agentthreads.PolicyFunc(func(ctx context.Context, q agentthreads.PermissionQuery, t agentthreads.PermissionContext) agentthreads.Decision {
			if q.Kind == protocol.ToolKindRead || q.Name == "lookup_order" {
				return agentthreads.Allow
			}
			return agentthreads.Ask
		}),
	},
})

sdk.Subscribe(func(e protocol.ThreadEvent) { broadcast(e) }) // events out
thread, err := sdk.Create(ctx, agentthreads.CreateOptions{Harness: "claude", Model: "haiku"})
err = sdk.HandleJSON(ctx, []byte(`{"type":"send","thread_id":"`+thread.ID+`","text":"What's in order 42?"}`)) // commands in
```

[go/](go/README.md) · [examples/chat-go](examples/chat-go/README.md)

### Rust

```rust
use std::sync::Arc;

use agent_threads::protocol::ToolKind;
use agent_threads::*;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

let sdk = AgentThreads::new(Options {
    store: Some(Arc::new(SqliteStore::open("threads.db")?)),
    capabilities: Capabilities {
        tools: vec![tool(
            "lookup_order",
            "Looks up an order by its id.",
            json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}),
            |args, _ctx| async move { format!("Order {}: 3 blue widgets, shipped.", args["order_id"]) },
        )],
        permissions: Some(PermissionPolicy::from_fn(|q, _| match q.kind {
            ToolKind::Read => PermissionDecision::Allow,
            _ if q.name == "lookup_order" => PermissionDecision::Allow,
            _ => PermissionDecision::Ask,
        })),
        ..Default::default()
    },
    ..Default::default()
});

let mut events = sdk.subscribe(); // events out: a tokio broadcast receiver
tokio::spawn(async move {
    loop {
        match events.recv().await {
            Ok(e) => broadcast(e),
            Err(RecvError::Lagged(_)) => continue, // clients see the gap in seq, and catch up
            Err(RecvError::Closed) => break,
        }
    }
});
let thread = sdk.create(CreateOptions { harness: Some("claude".into()), model: Some("haiku".into()), ..Default::default() }).await?;
sdk.handle_json(json!({"type": "send", "thread_id": thread.id, "text": "What's in order 42?"})).await?; // commands in
```

[rust/agent-threads](rust/agent-threads/README.md) · [examples/chat-rust](examples/chat-rust/README.md)

### React

```tsx
import { Thread, type ThreadSource } from "@dire-kiwi/agent-threads-react";
import "@dire-kiwi/agent-threads-react/styles.css";

// The backend's snapshot(threadId), and the thread's events, from your transport.
const source: ThreadSource = {
  snapshot,
  subscribe: (fn) => onThreadEvent(threadId, fn), // returns how to stop
  resync: (seq) => fetchEventsSince(threadId, seq), // the backend's eventsSince(threadId, seq)
};

<Thread source={source} onCommand={(command) => sendCommand(command)} />;
```

[ts/packages/react](ts/packages/react/README.md) · [docs/transport.md](docs/transport.md) has the
transports, end to end.

## Docs

| | |
| --- | --- |
| [docs/transport.md](docs/transport.md) | Bring your own network: events out, commands in, snapshots and resyncing, and WebSocket, SSE, Electron and Tauri examples |
| [docs/tools.md](docs/tools.md) | App tools, MCP servers, skills, permission policies and config isolation, and how each harness does them |
| [docs/shim.md](docs/shim.md) | Runs that outlive the backend: when to use the shim, and recovering after a restart |
| [spec/PROTOCOL.md](spec/PROTOCOL.md) | The protocol: threads, items, requests, events, commands, and the rules for applying events |
| [docs/design.md](docs/design.md) | The design, and the decisions behind it |

## Packages

| Path | What |
| --- | --- |
| [ts/packages/protocol](ts/packages/protocol/README.md) | `@dire-kiwi/agent-threads-protocol`: the protocol's TS types, generated from the spec, the `applyEvent` reducer and `validate` |
| [ts/packages/node](ts/packages/node/README.md) | `@dire-kiwi/agent-threads-node`: the Node backend |
| [ts/packages/react](ts/packages/react/README.md) | `@dire-kiwi/agent-threads-react`: React hooks and components |
| [go/](go/README.md) | Go module `github.com/dire-kiwi/agent-threads/go`: the Go backend (with `protocol`, `sqlitestore` and `storetest`) |
| [rust/agent-threads](rust/agent-threads/README.md) | The `agent-threads` crate: the Rust backend, on tokio |
| [shim/](shim/README.md) | `agent-threads-shim`, which keeps runs alive across backend restarts |
| [spec/](spec/PROTOCOL.md) | JSON Schemas (the source of truth), the protocol and run-directory docs ([RUNDIR.md](spec/RUNDIR.md)), recorded fixtures ([README](spec/fixtures/README.md)), the fake CLI that replays them ([tools](spec/tools/README.md)) and the store conformance cases ([store.md](spec/conformance/store.md)) |
| [examples/](examples/PROTOCOL.md) | A support-chat app per backend: [chat-node](examples/chat-node/README.md) (with the React frontend they share), [chat-go](examples/chat-go/README.md) and [chat-rust](examples/chat-rust/README.md), all speaking [one wire protocol](examples/PROTOCOL.md) over their own WebSocket |

## Using it from this repository

Nothing is published yet: apps use the packages from this repository until the API settles.

### TypeScript packages

The packages are built to `dist/` (their `exports` point there), which isn't committed, and they
depend on each other with pnpm's `workspace:*`. So use them from a checkout, **built**: clone the
repository (or add it as a git submodule) and run `pnpm install && pnpm build` in its `ts/`
directory, then link the packages into your app with pnpm:

```sh
git clone https://github.com/dire-kiwi/agent-threads ../agent-threads
(cd ../agent-threads/ts && pnpm install && pnpm build)
```

```json
{
  "dependencies": {
    "@dire-kiwi/agent-threads-node": "link:../agent-threads/ts/packages/node",
    "@dire-kiwi/agent-threads-react": "link:../agent-threads/ts/packages/react",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

Run `pnpm build` in `ts/` again after pulling. (`file:` doesn't work: pnpm then installs the
package's own dependencies, and can't resolve `workspace:*` outside the workspace.) An app inside
this repository, like the examples, is in the `ts/` pnpm workspace (`ts/pnpm-workspace.yaml`) and
uses `workspace:*`; it still needs `pnpm build` first.

**One React.** A linked package is resolved where it really is, in the checkout, which has React of
its own (for its tests and stories). So a bundler finds the checkout's React for the React package
and the app's for the app, and with two Reacts the components fail with "Invalid hook call" (or
"Cannot read properties of null (reading 'useContext')"). Tell the bundler to use the app's:

```js
// vite.config.js
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
});
```

```js
// webpack.config.js
const path = require("node:path");
module.exports = {
  resolve: {
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
};
```

(Vitest takes the same `resolve.dedupe`.) The Node package has no such problem.

There's no source export condition: the packages' sources import each other's `.js` files, which
Node runs only once built. The Node backend needs Node 24+ (for `node:sqlite`, which `SqliteStore`
uses), and the React package React 18+.

### Go module

The module is in the repository's `go/` directory, so its path is
`github.com/dire-kiwi/agent-threads/go`. Without tags, `go get` takes a commit as a pseudo-version:

```sh
go get github.com/dire-kiwi/agent-threads/go@main   # or @<commit>
# go.mod: require github.com/dire-kiwi/agent-threads/go v0.0.0-20261101062210-3dca55768cb5
```

Or use a checkout, as [examples/chat-go](examples/chat-go/go.mod) does:

```
require github.com/dire-kiwi/agent-threads/go v0.0.0
replace github.com/dire-kiwi/agent-threads/go => ../agent-threads/go
```

It needs Go 1.26+, and no cgo (SQLite is modernc.org/sqlite).

### Rust crate

Cargo finds the `agent-threads` crate in the repository's `rust/` workspace by its name:

```toml
[dependencies]
agent-threads = { git = "https://github.com/dire-kiwi/agent-threads", branch = "main" } # or rev = "<commit>"
# or, from a checkout, as examples/chat-rust does:
# agent-threads = { path = "../agent-threads/rust/agent-threads" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
serde_json = "1"
async-trait = "0.1" # only to implement the Tool trait yourself
```

The crate is async on tokio, so the app needs tokio's runtime, and `serde_json` for the JSON it takes
and gives (tool schemas and arguments, commands). It bundles SQLite (rusqlite's `bundled`).

### Shim binary

```sh
cargo install --git https://github.com/dire-kiwi/agent-threads agent-threads-shim
```

or `make shim` in a checkout (`shim/target/debug/agent-threads-shim`). See [docs/shim.md](docs/shim.md).

## Building and testing

You need Node 24+ with pnpm 10, Go 1.26+ and stable Rust (the Node and Go tests build the shim with
cargo).

```sh
(cd ts && pnpm install)
make test        # build and test TS, Go and Rust (and the Rust example), and the fixtures' tools
make gen         # regenerate the types after changing spec/schema/
make check-gen   # fail if the generated code is out of date (CI runs it)
```

The backends' tests replay the recorded sessions with a fake CLI, so they need no login. Each
backend also has live smoke tests against the real CLIs (`AGENT_THREADS_LIVE=1`; a cent or so).

## Licence

MIT: see [LICENSE](LICENSE).

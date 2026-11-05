# agent-threads

A library for apps to run threads of agents on **Claude Code** (`claude -p`, stream-json) and
**Codex** (`codex app-server`): start a thread, send messages, steer it while it runs, approve its
tool calls, answer its questions, watch its subagents, resume it later, and rewind or compact its
conversation. It has a backend for **Node** (TypeScript) and **React** components to draw a
thread.

There's no network layer. The backend sends JSON **events** and takes JSON **commands**, and the
app carries them between its backend and its frontend over whatever it already has: a WebSocket,
SSE or Electron IPC ([docs/transport.md](docs/transport.md)). The app gives the agent its own
**tools** (functions in its own language), **MCP servers** and **skills**, and decides each tool
call in code or by asking the user ([docs/tools.md](docs/tools.md)). With
[agent-threads-shim](docs/shim.md), runs outlive the backend's process and carry on after a restart.

```
 App backend (Node)                                     App frontend (React, or anything)
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

The backend drives the CLIs the user already has installed and logged in, and translates them into
one normalized model: a thread is a list of **items** (messages, reasoning, tool calls,
subagents, notices, turn results) plus its open **requests** (permissions and questions), changed
by numbered, replayable **events** ([spec/PROTOCOL.md](spec/PROTOCOL.md)). The JSON Schemas in
[spec/schema](spec/schema) are the source of truth, the TypeScript types are generated from them,
and recorded Claude and Codex sessions ([spec/fixtures](spec/fixtures/README.md)) are the
conformance suite the backend passes.

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
| [docs/transport.md](docs/transport.md) | Bring your own network: events out, commands in, snapshots and resyncing, and WebSocket, SSE and Electron examples |
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
| [shim/](shim/README.md) | `agent-threads-shim`, which keeps runs alive across backend restarts |
| [spec/](spec/PROTOCOL.md) | JSON Schemas (the source of truth), the protocol and run-directory docs ([RUNDIR.md](spec/RUNDIR.md)), recorded fixtures ([README](spec/fixtures/README.md)), the fake CLI that replays them ([tools](spec/tools/README.md)) and the store conformance cases ([store.md](spec/conformance/store.md)) |
| [examples/](examples/PROTOCOL.md) | A support-chat app, [chat-node](examples/chat-node/README.md), with a React frontend, speaking [its own wire protocol](examples/PROTOCOL.md) over a WebSocket |

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

### Shim binary

```sh
cargo install --git https://github.com/dire-kiwi/agent-threads agent-threads-shim
```

or `make shim` in a checkout (`shim/target/debug/agent-threads-shim`). See [docs/shim.md](docs/shim.md).

## Building and testing

You need Node 24+ with pnpm 10, and stable Rust (the tests build the shim with cargo).

```sh
(cd ts && pnpm install)
make test        # build and test the TS packages, the shim and the fixtures' tools
make gen         # regenerate the types after changing spec/schema/
make check-gen   # fail if the generated code is out of date (CI runs it)
```

The backend's tests replay the recorded sessions with a fake CLI, so they need no login. It also
has live smoke tests against the real CLIs (`AGENT_THREADS_LIVE=1`; a cent or so).

## Licence

MIT: see [LICENSE](LICENSE).

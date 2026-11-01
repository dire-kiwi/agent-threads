# agent-threads: design

agent-threads is a library that apps embed to run threads of agents the way Huntaway does: start a
thread, send messages, steer it while it runs, approve tool calls, answer the agent's questions,
watch subagents and resume later. It's meant for Huntaway itself, a Grokbot clone and later apps.

This is a summary of the approved plan (AT-2), kept in the repository so later work has it to
hand. The wire format is specified in [spec/PROTOCOL.md](../spec/PROTOCOL.md) and
[spec/schema/](../spec/schema/).

## Goals

- **Backends** in Go, Rust and TypeScript (Node): native libraries in each language, with the same
  model and behaviour.
- **Harnesses**: Claude Code (`claude -p`, stream-json) and Codex (`codex app-server`) behind one
  interface. An ACP driver or Grok could come later as further drivers.
- **App extensibility**: apps define their own tools in their own language, attach MCP servers and
  skills, and decide permissions in code or by asking the user.
- **Frontend**: React components and headless hooks that render a thread from the SDK's events and
  send the user's actions back as commands.
- **No network layer**: a backend produces JSON events and accepts JSON commands. The app carries
  them over WebSocket, SSE, Electron IPC, Tauri or whatever it already uses.

## Out of scope

- Worktrees, git, diffs/changes views, commits, PRs, the kanban board, tasks and statuses.
- Transport, auth and multi-host relaying (Huntaway's hub, broker and tunnel).
- Rewind/checkpoints, usage/rate-limit dashboards and terminals. They could come later.
- Moving Huntaway onto the SDK. That's a follow-up once the TS or Rust backend is stable.

## Decisions

- **Native per language**, kept in step by a shared spec (JSON Schemas, with generated types) and
  conformance fixtures that every backend runs. We weighed a Rust core with FFI bindings (painful
  builds, awkward callbacks across FFI), a sidecar daemon with thin clients (another binary to ship,
  and app tools need a round trip anyway) and ACP only (Node adapters, and it loses steering,
  subagents and partial messages).
- **Claude Code and Codex** for v1.
- **Isolated config by default**: a thread sees only the app's tools, MCP servers and skills. Claude
  runs with `--setting-sources` limited, `--strict-mcp-config` and its own skills plugin; Codex
  gets an app-specific `CODEX_HOME` with the login linked in. The login is still the user's, and apps
  can opt in to user settings.
- **Stores**: in-memory, JSONL file and SQLite, built into every backend. They all pass one store
  conformance test, and apps can implement `Store` on their own database.
- **React styling**: one stylesheet themed with CSS variables (no Tailwind needed), plus headless
  hooks for full control.
- **The TS backend leads**: spec → Node → React → example app as a vertical slice, then Go and Rust
  against the settled spec and fixtures.
- **Naming**: npm `@dire-kiwi/agent-threads-protocol`, `@dire-kiwi/agent-threads-node` and
  `@dire-kiwi/agent-threads-react`; Go module `github.com/dire-kiwi/agent-threads/go`; Rust crate
  `agent-threads`; the shim binary `agent-threads-shim`.
- **No publishing yet**: apps use the packages from the repository (git dependencies or workspace
  links) until the API settles.

## Architecture

```
 App backend (Go / Rust / Node)                         App frontend (React)
┌──────────────────────────────────┐                  ┌──────────────────────────────┐
│ agent-threads                    │   events (JSON)  │ @dire-kiwi/agent-threads-    │
│  Thread · Turn · Store           │ ───────────────▶ │   react                      │
│  harness drivers                 │                  │  applyEvent() reducer        │
│  app tools · MCP · skills        │ ◀─────────────── │  useThread() hooks           │
│  permission policy               │ commands (JSON)  │  <Thread> <Composer>         │
│  subscribe() · handle(command)   │  the app's own   │  <PermissionCard> ...        │
│  snapshot(threadId)              │    transport     │  tool renderer registry      │
└───────┬───────────────┬──────────┘                  └──────────────────────────────┘
        │               │
   claude -p       codex app-server
   stream-json     JSON-RPC over stdio
   (directly or under agent-threads-shim)
```

## Repository layout

| Path | What |
| --- | --- |
| `spec/` | The source of truth: JSON Schemas in `spec/schema/`, the protocol doc `spec/PROTOCOL.md`, and example events in `spec/examples/`. |
| `spec/fixtures/` | Recorded Claude and Codex sessions, each with the normalized events they must produce: the conformance suite every backend runs ([spec/fixtures/README.md](../spec/fixtures/README.md)). `spec/tools/` has the fake CLI that replays them, and `spec/conformance/` the store conformance cases. |
| `ts/packages/protocol` | Generated TS types and the pure `applyEvent` reducer, shared by the Node backend and React. |
| `ts/packages/node` | The Node backend (Memory, JSONL file and SQLite stores). |
| `ts/packages/react` | React hooks and components. |
| `go/` | Go module `github.com/dire-kiwi/agent-threads/go`, the Go backend ([go/README.md](../go/README.md)); generated types in `go/protocol`, SQLite in `go/sqlitestore`. |
| `rust/` | Cargo workspace with the `agent-threads` crate (generated types in `agent_threads::protocol`) and its `codegen`. |
| `shim/` | `agent-threads-shim` (see below). |
| `examples/` | A minimal chat app per backend, each with its own WebSocket transport, to show the "bring your own network" seam: `chat-node`, and `chat-go`, a Go server for chat-node's React frontend, which every example's server shares ([examples/PROTOCOL.md](../examples/PROTOCOL.md)). |

`make gen` regenerates the types from `spec/schema/`, and CI fails if they're out of date.

## How Huntaway does it, and what changes

Huntaway (`~/personal/huntaway`) is the reference implementation, with its thread layer mixed in
with board, worktree and git code:

- **Claude runs** (`server/src/runner.rs`): `claude -p --output-format stream-json --verbose
  --include-partial-messages --input-format stream-json --replay-user-messages`, plus
  `--permission-mode`, `--resume <sid>`, `--model` and `--add-dir`. Messages and steering go in
  over stdin. A steered message only joins the thread once Claude echoes it back; after a turn's
  result the agent gets 30s to take in waiting messages, and anything it didn't is requeued as the
  next run's prompt. Stop sends a `control_request` interrupt, then closes stdin and sends SIGTERM
  after 10s. Output is slimmed before it's stored (tool results cut to 30k characters, images
  become `[image]`).
- **Permissions** (`permissions.rs`, `mcp.rs`): `--permission-prompt-tool` on the board's own MCP
  server, which parks the call until the user answers.
- **Codex runs** (`server/src/codex.rs`): an adapter speaks JSON-RPC to `codex app-server`
  (`thread/start|resume`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/compact/start`) and
  answers approval requests, then converts Codex items into Claude-shaped messages.
- **Skills** (`agent_tools.rs`): enabled skills are written to `<dir>/.claude/skills/<name>/SKILL.md`
  and passed with `--add-dir`; others are turned off with `--disallowedTools Skill(name)`. Codex gets
  `skills/extraRoots/set`.
- **Supervision** (`server/shim`, `runs.rs`): `ia-shim` runs the CLI detached and records its stdout
  to `out.jsonl`, which the server follows from a saved offset, so runs survive restarts.
- **Storage** (`db.rs`): one SQLite row per message, holding the raw Claude stream-json.
- **Live updates**: saved messages go out as events; text deltas go out as unsaved `delta` events.
- **Thread model** (`app/src/threadModel.ts`, `subagents.ts`): folds raw messages into items, joins
  tool results to calls, groups subagent messages by `parent_tool_use_id`, and reuses unchanged
  items so rows don't redraw.
- **Rendering** (`components/Thread.tsx`, `Approvals.tsx`, `Questions.tsx`): bound to Huntaway's
  store, API and Tailwind theme.

**Kept**: the item model, call/result joining, subagent grouping, deltas kept apart from saved
messages, steering over stdin, and run supervision and resume.

**Changed**: Huntaway stores Claude's raw JSON and converts Codex into it, so Claude's format is its
data model. The SDK has its own normalized model instead: each harness driver translates into it,
and the raw payload can be kept alongside for debugging. That's what lets three backends and one
set of React components agree.

## The data model

A thread is a list of items plus its open requests. The backend sends events, which are numbered
(`seq`) and replayable, and accepts commands. See [spec/PROTOCOL.md](../spec/PROTOCOL.md) for the
details.

- **Items** (saved): `user_message`, `assistant_message`, `reasoning`, `tool_call` (kind `shell`,
  `read`, `edit`, `search`, `web`, `mcp`, `app`, `subagent`, `todo` or `other`; a subagent is a
  `tool_call` of kind `subagent` whose items have its id as `parent_id`), `compaction`, `notice`
  and `turn_result`.
- **Requests**: `permission` and `question`.
- **Events**: `thread.updated`, `turn.started`, `turn.completed`, `item.added`, `item.updated`,
  `delta` (not saved), `request.opened` and `request.resolved`. Each has `thread_id` and `seq`.
- **Commands**: `send` (which steers if a turn is running), `interrupt`, `respond` and `set_options`.
- **Snapshot**: `{thread, items, requests, seq}`. A client that reconnects asks for the events after
  its `seq`, or takes a fresh snapshot.

Items and events can carry the harness's `raw` payload, which backends can switch off.

## Backend API

The same shape in every language (TypeScript shown; Go and Rust mirror it idiomatically, with
`context.Context`, channels and a `Tool` interface in Go, and tokio, async-trait tools and a
broadcast channel in Rust):

```ts
const sdk = new AgentThreads({
  store: new FileStore("./threads"),          // or MemoryStore, SqliteStore, or your own Store
  harnesses: { claude: claudeCode({ bin, configDir }), codex: codex({ bin, home }) },
  tools: [defineTool({ name: "lookup_order", description, input: schema, run: async (args, ctx) => … })],
  mcpServers: { github: { command: "gh-mcp" }, docs: { url: "https://…/mcp" } },
  skills: ["./skills/support-agent"],
  permissions: async (req, ctx) => (req.kind === "read" ? "allow" : "ask"), // allow | deny | ask (asks the user)
  spawner: shim("/usr/local/bin/agent-threads-shim", { runsDir }), // optional; direct by default
});

const thread = await sdk.create({ harness: "claude", model: "opus", cwd, systemPrompt, metadata });
const off = sdk.subscribe((event) => ws.broadcast(event)); // the app's transport
ws.on("message", (cmd) => sdk.handle(cmd));                 // send / interrupt / respond / set_options
await sdk.snapshot(thread.id);                              // for a client that just connected
await sdk.recover();                                        // on startup, with the shim spawner
```

Tools, MCP servers, skills and the permission policy can be set per SDK instance or per thread.
Tool handlers get a `ctx` with the thread id and metadata, so an app can scope tools per user.

## How each feature maps onto the harnesses

| Feature | Claude Code | Codex |
| --- | --- | --- |
| Messages and steering | stream-json on stdin with `--replay-user-messages`. A steered message counts as delivered once it's echoed back; anything not taken in by the end of the turn starts the next one. | `turn/start`, `turn/steer` |
| Interrupt | stream-json `control_request` interrupt | `turn/interrupt` |
| Resume | `--resume <session_id>` | `thread/resume` |
| App tools (in process) | An in-process ("sdk") MCP server answered over the stream-json control channel, as the official Agent SDK does. | `dynamicTools` on `thread/start`, answered via `item/tool/call` (experimental). Fallback: a loopback streamable-HTTP MCP server with a random token. |
| External MCP servers | `--mcp-config` + `--strict-mcp-config` | `mcp_servers` in `thread/start` config overrides |
| Permissions | `--permission-prompt-tool stdio` → `can_use_tool` control requests | Approval server requests (`commandExecution`, `fileChange`, MCP elicitation) |
| Questions to the user | `AskUserQuestion`, answered through the permission callback | `item/tool/requestUserInput` |
| Skills | The app's skills copied into a generated plugin passed with `--plugin-dir` (Claude doesn't look in `.claude/skills` directories with `--setting-sources ""`) | `skills/extraRoots/set` |
| Subagents | `parent_tool_use_id`, plus `--agents` for app-defined agents | Child threads |

## The shim: runs that outlive the backend

`agent-threads-shim` is a port of Huntaway's `ia-shim` (`server/shim/src/main.rs`, libc only),
shipped in this repository under `shim/`:

- `agent-threads-shim <rundir> -- claude …` forks and calls `setsid`, then runs the CLI in its own
  process group. It appends stdout to `out.jsonl` and stderr to `err.log`, and relays `input.jsonl`
  to stdin until `input.closed` appears. It writes `pid`, and on exit an atomic `exit` file with
  `{code, signal}`.
- The run-directory protocol becomes part of `spec/` so every backend speaks it: the files above
  plus `run.json` with a format version.
- Each backend has a **Spawner**: `direct` (a child process; the run dies with the backend) or `shim`
  (the backend follows `out.jsonl` from the offset saved in the Store). On startup `sdk.recover()`
  re-attaches to runs that are still going and finishes the ones that exited while it was down, as
  Huntaway's `load_active` does.
- It's Unix-only, like `ia-shim`. On Windows, backends fall back to `direct`.

The run directory is specified in [spec/RUNDIR.md](../spec/RUNDIR.md). `Thread.run` says which
process runs a thread and with which spawner, and its `reattached_at` is set when a restarted
backend re-attaches; a `notice` item with code `run.reattached` (or `run.lost`, for a run it
couldn't pick up, whose turn it ended) tells the user. A backend saves a run's offset, with what its
driver needs to carry on reading, in the same store write as the events it made from the output
before it, so a restart neither loses events nor makes them twice. The Node and Go backends have the
shim spawner and `recover()`, and all their drivers re-attach.

## React package

- **Headless**: `applyEvent(state, event)` (in the protocol package, so the Node backend uses the
  same reducer for snapshots), and `useThread(source)`, where `source` is anything with
  `subscribe(fn)` plus an initial snapshot that the app wires to its transport. `useSend()`,
  `useRespond()` and `useInterrupt()` call an app-supplied `onCommand`.
- **Components**, ported from Huntaway minus the board: `<Thread>`, `<MessageList>`, `<ToolCall>`
  with built-in renderers for shell, edit diff, read and search, `<Subagent>`, `<PermissionCard>`,
  `<QuestionCard>`, `<Composer>` and `<StreamingText>`.
- **Extension points**: a tool-renderer registry (so an app can draw `lookup_order` as an order
  card), slots for message and markdown rendering, and a `className` per component.
- The reducer keeps Huntaway's item reuse: unchanged items keep their identity, so rows don't
  redraw.

## Steps

One board task each, in order; Go and Rust can run in parallel once the spec, the fixtures and the
Node backend land.

1. **Spec and codegen** (AT-3): the schemas, this doc and the protocol doc, codegen to TS
   (json-schema-to-typescript), Go (`go/internal/gen`) and Rust (typify) checked by `make
   check-gen` in CI, the monorepo scaffolding, and the `applyEvent` reducer.
2. **Fixtures and conformance harness**: recorded `claude` and `codex app-server` sessions for a plain
   reply, tool calls, permission allow/deny, AskUserQuestion, an app tool, an MCP tool, a subagent,
   steer, interrupt, resume, compaction and an error, with hand-checked normalized events. Fake-CLI
   scripts replay them, so backends test without a login.
3. **Node backend, core and Claude driver**: `AgentThreads`, `Thread`, the `Store` interface and its
   three stores with a shared store test, the event bus and snapshots, and the Claude driver.
4. **Node backend, Codex driver**.
5. **Shim and runs that survive a restart (Node)**: port `ia-shim`, specify the run-directory
   protocol, add the shim spawner and `recover()`.
6. **React package**: the hooks, components, tool-renderer registry and CSS theme, with a story page
   per component fed by fixture events.
7. **Example app (Node + React)**: a tiny chat app with a WebSocket transport, one custom tool, one
   MCP server and one skill, against real Claude and Codex.
8. **Go backend** (SQLite via modernc.org/sqlite, no cgo) with a Go example server.
9. **Rust backend** (tokio; SQLite via rusqlite bundled) with an axum example.
10. **Docs**: a README per package and the "bring your own transport" guide.

Follow-ups: plan moving Huntaway's thread layer onto the Rust backend and React components; start the
Grokbot clone on the SDK.

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude's stream-json control protocol (sdk MCP servers, `can_use_tool`) isn't formally documented and may change between CLI versions. | Pin a minimum CLI version, use the fixtures as regression tests, and fall back to a permission-prompt MCP tool (Huntaway's approach) if needed. |
| Codex `dynamicTools` is experimental. | Generate types from `codex app-server generate-json-schema --experimental`, and keep the loopback-MCP fallback behind the same Tool API. |
| Three implementations drift. | All three run the same fixtures in CI, and the types are generated from the spec, not hand-copied. |
| The normalized model loses harness detail an app wants. | The optional `raw` payload on items and events, and the `other` tool kind. |
| The scope is large. | Build the vertical slice first; Go and Rust start once the spec has settled against a working Node and React app. |

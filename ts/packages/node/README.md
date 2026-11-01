# @dire-kiwi/agent-threads-node

agent-threads' Node backend: it runs threads on Claude Code (`claude -p`) and Codex (`codex
app-server`), sends their events to your app and takes commands from it. It has no network layer:
wire `subscribe()` and `handle()` to your own transport (a WebSocket, SSE, IPC...).

```ts
import { AgentThreads, FileStore, claudeCode, codex, defineTool } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({
  store: new FileStore("./threads"), // or MemoryStore (the default), SqliteStore, or your own Store
  harnesses: { claude: claudeCode(), codex: codex({ home: "./codex-home" }) }, // both, by default
  tools: [
    defineTool<{ order_id: string }>({
      name: "lookup_order",
      description: "Looks up an order by its id.",
      input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      run: async ({ order_id }, ctx) => `Order ${order_id} for ${ctx.metadata.user}: 3 blue widgets.`,
    }),
  ],
  mcpServers: { docs: { url: "https://example.com/mcp" }, gh: { command: "gh-mcp" } },
  skills: ["./skills/support-agent"], // directories with a SKILL.md, or { name, content }
  permissions: (req) => (req.kind === "read" ? "allow" : "ask"), // allow | deny | ask | { deny: "why" }
});

const thread = await sdk.create({ model: "sonnet", cwd: "/srv/work", metadata: { user: "u1" } });
const off = sdk.subscribe((event) => ws.broadcast(event)); // every thread's events, deltas included
ws.on("message", (cmd) => sdk.handle(JSON.parse(cmd))); // send / interrupt / respond / set_options
await sdk.snapshot(thread.id); // for a client that just connected
await sdk.eventsSince(thread.id, seq); // for one catching up
await sdk.close(); // on shutdown: stops the harness processes (or with the shim, leaves them going) and saves everything
```

## Threads

- `create(options)` makes a thread (`harness`, `model`, `effort`, `permission_mode`, `cwd`,
  `title`, `metadata`) and sends its first `thread.updated`. It runs on the first harness unless
  it names one (`harness: "codex"`). It can have its own `tools`,
  `mcpServers`, `skills`, `permissions` and `systemPrompt`, on top of the instance's.
- `handle(command)` carries out a command from a client ([spec/PROTOCOL.md](../../../spec/PROTOCOL.md#commands)),
  and throws a `CommandError` for one it can't (an unknown thread, or a command that isn't valid by
  the protocol's schema, which is checked before anything changes). `send`, `interrupt`, `respond`
  and `setOptions` do the same from code. After `close()`, they're all refused.
- `get`, `list` and `delete` look threads up and remove them.
- A thread's own tools, policy and so on live in memory. After a restart, give them again with
  `configure(threadId, { tools, ... })`; its stored state (items, session) comes back by itself, and
  the next message resumes the harness's session.

Events go to subscribers as they happen and to the store in order, those of the same tick in one
`appendEvents` (deltas aren't saved). `eventsSince()` waits for what's been sent to be saved, and
`snapshot()` is the thread's events folded with the protocol's `applyEvent`, including text
streamed so far.

## Stores

`MemoryStore`, `FileStore(dir)` (one JSONL file per thread, synced on each write) and
`SqliteStore(path)` (Node's built-in `node:sqlite`, so no native dependency) all pass
[spec/conformance/store.json](../../../spec/conformance/store.md). To keep threads in your own
database, implement `Store` and run the same cases (see `src/test/store.test.ts`). The store is
yours: `close()` doesn't close it. If the store fails, events are kept and written again in
order once it works; meanwhile `eventsSince()` rejects, and so does `close()`, which can be called
again to finish saving. The file store undoes a write that fails partway, so a retry can't repeat it.

## Claude Code

- **One process per thread**, started at its first message and kept between turns, with
  `--input-format stream-json` and `--replay-user-messages`. After a restart (or a change of
  model, effort or permission mode) the next message starts a new one with `--resume`.
- **Steering**: a message sent during a turn goes in on stdin and is `queued` until Claude echoes
  it back, which is all that unqueues it. One it hasn't taken in when the turn ends starts the next
  turn (in the same process, or a new one if the options changed or Claude doesn't take it in
  within `steerGraceMs`, 30s). That stops when a retry is interrupted, fails with no process left
  holding the message, or three have run: then a process that has it is stopped (so it can't act on
  it unseen), a `notice` says it wasn't delivered, and it's sent again with the next message, in
  one stream-json message with it (Claude makes a turn of each message waiting for it, so they
  can't go separately). A turn lost when the backend stopped is ended without retrying, and starts nothing.
- **Unfinished text**: when a turn ends before Claude finishes a message (its process exits, or the
  backend shuts down), the text streamed so far is saved.
- **Interrupt** sends a `control_request` interrupt; if the turn hasn't ended after `stopGraceMs`
  (10s), the process's input is closed and it's sent SIGTERM.
- **Permissions**: `--permission-prompt-tool stdio`, so Claude asks over `can_use_tool` and the
  policy answers. `ask` opens a `permission` request for the user; answering it with `always` keeps
  that answer for that tool (the same name on the same MCP server, of the same kind) for the rest
  of the thread. AskUserQuestion is always a `question`.
- **App tools** are an in-process MCP server, `app`, answered over the control channel. Tool
  handlers get `ctx` with the thread's id and metadata, and the tool call's id.
- **Isolated config**: threads run with `--setting-sources ""` and `--strict-mcp-config`, so they
  see only the app's MCP servers and skills. The skills go in a plugin (`app`) generated for each
  process and passed with `--plugin-dir`, which Claude loads even with no setting sources (a
  `.claude/skills` directory it wouldn't), so they're `app:<name>`. `claudeCode({ userSettings:
  true })` lets threads see the user's own settings instead; `configDir` points Claude at another
  config (and login).
- **Attachments**: images with data go to Claude as images, and files with textual data (`text/*`,
  JSON, YAML...) as their text. Other files with data are written to a temporary directory, removed
  with the thread's harness, and Claude is told the path, as it is for attachments with a `path`.
- Tool results are cut to 30,000 characters (with `truncated`), and images become `[image]`.

## Codex

- **One `codex app-server` process per thread**, started at its first message and kept between
  turns. It's sent `initialize` (with `experimentalApi`) and `initialized`, then `thread/start`, or
  `thread/resume` once the thread has a session (after a restart, or a change of model, effort,
  permission mode or config, the next message starts a new process that resumes it). A session
  Codex no longer has is started afresh, with a `notice` that it doesn't remember the thread.
- **Messages** are `turn/start`, with the thread's `effort`; `/compact` is `thread/compact/start`.
  One sent during a turn is `turn/steer` (with `expectedTurnId`), `queued` until Codex's
  `userMessage` item shows it took it in. One Codex refuses (its turn had ended), or doesn't take
  in, starts the next turn, as with Claude.
- **Interrupt** is `turn/interrupt`; if the turn hasn't ended after `stopGraceMs` (10s), the
  process is stopped.
- **Permission modes** are approval policies and sandboxes: `default` is `untrusted` in
  `workspace-write`, `accept_edits` `on-request` in `workspace-write`, `plan` `untrusted` in
  `read-only`, and `bypass` `never` in `danger-full-access`.
- **Permissions**: Codex's approval requests (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`, and the MCP elicitations it
  approves MCP tool calls with) go to the policy, as do the app's tools. An elicitation that wants a
  form filled in is declined. `item/tool/requestUserInput` is always a `question`, shown as a
  `request_user_input` call. An elicitation is asked about as the tool and arguments it names, and
  is tied to a running call only if exactly one matches it (server, thread, tool and arguments).
- **Secret answers** (to a question Codex marks `isSecret`) go only to Codex: the
  `request.resolved` that's sent and saved, and the call's result, show `[secret]` instead. (The
  core does this for any harness.)
- **Items**: `commandExecution` is `shell` (with Codex's `bash -lc` wrapper taken off the shown
  command), `fileChange` `edit`, `mcpToolCall` `mcp`, `webSearch` `web`, `imageView` `read`,
  `dynamicToolCall` `app`, `spawnAgent` `subagent` (its child thread's items have it as their
  `parent_id`, and its result is the child's last message), plan updates one `todo` call per turn,
  `agentMessage` and `plan` `assistant_message`, `reasoning` `reasoning`, and `contextCompaction`
  `compaction`. Warnings and retried errors are `notice`s.
- **Usage**: Codex reports the session's running totals, so a turn's usage is how far they grew
  since the last turn's end. That's kept per session, so a new session starts again from nothing.
- **App tools** are `dynamicTools` on `thread/start`, answered over `item/tool/call`. Codex marks
  those experimental: with `codex({ appTools: "mcp" })`, or when Codex refuses them, they're served
  instead by a loopback MCP server (streamable HTTP on 127.0.0.1, a random port, a random bearer
  token), one per process, named `app`. Codex keeps the dynamic tools a session started with, and
  resuming can't change them: after `configure()` changes the app's tools, those the session hasn't
  as they are now are served on the MCP server, and a call to a dynamic tool that has gone or
  changed gets an error saying where the app's tools are. The driver keeps what each session started
  with (and its totals) in `<home>/agent-threads/sessions/`.
- **MCP servers** go in `thread/start`'s config as `mcp_servers` (stdio, or streamable HTTP with
  `http_headers`; Codex has no SSE). **Skills** are written to a directory for the process and
  given with `skills/extraRoots/set`. Without `userConfig`, the other skills Codex finds (the
  user's `~/.agents/skills`, the project's, the machine's: a CODEX_HOME of its own doesn't keep
  those out) are listed with `skills/list` and turned off in the thread's config, so it has only the
  app's and Codex's own built-in ones. (Skills added while a process runs are left out by the next.)
  The system prompt is `developerInstructions`.
- **Isolated config**: threads run with a `CODEX_HOME` of the app's own (`home`,
  `~/.agent-threads/codex` by default), which keeps the app's sessions (so it must outlast its
  threads) and none of the user's config, MCP servers or skills. The user's login (`auth.json` from
  `$CODEX_HOME` or `~/.codex`, or `login`) is linked in, or copied where links can't be made, unless
  the home has one of its own. `codex({ userConfig: true })` runs with the user's own CODEX_HOME.
- **Attachments**: images with data are sent as data URLs, images with a path as local images, and
  files as for Claude.

`src/codex/protocol.ts` has the app server's types, generated from the schema the installed
`codex` prints (`codex app-server generate-json-schema --experimental`) by `pnpm gen:codex`
(`scripts/gen-codex.mjs`). Run it when Codex changes, and check the driver against the diff.

## Processes, and runs that survive a restart

Processes are started by a `Spawner`. `direct()` (the default) runs them as child processes, each
in its own process group, so they end with the backend. `shim(path)` runs them under
[agent-threads-shim](../../../shim/README.md) (`path` is the binary), so they outlive it:

```ts
const sdk = new AgentThreads({
  store: new FileStore("./threads"),
  spawner: shim("/usr/local/bin/agent-threads-shim", { runsDir: "./threads-runs" }),
});
await sdk.recover(); // at startup, before taking commands
```

- Each run gets a directory under `runsDir`, which the backend and the shim share as
  [spec/RUNDIR.md](../../../spec/RUNDIR.md) says: input is appended to `input.jsonl`, and the
  backend follows `out.jsonl`, whole lines only. `runsDir` must be the store's alone (pruning stops
  and removes the runs in it the store doesn't follow), so there's no default. It and a shim path
  with a `/` in it are taken relative to the backend's working directory.
- Whenever a thread's events are saved, its run's offset (how far into `out.jsonl` they go), the
  driver's state for it, the running turn and the text streamed so far are saved with them, in the
  same `appendEvents`. So however the backend
  stops, after a restart it reads the output again from exactly where the saved events end: none
  are lost, and none are made twice.
- `recover()` re-attaches to the runs that were going when the backend stopped. A run that's still
  going carries on, with its turn, its streamed text and its open requests as they were (a
  permission or question the user hadn't answered can still be answered). One that ended while the
  backend was down is read to its end, so its turn finishes as it would have. A `notice` (code
  `run.reattached`) tells the user, and the thread's `run` gets `reattached_at`. A thread a command
  loads before `recover()` gets to it is re-attached then.
- `close()` leaves shim runs going, for the next start to re-attach to; `close({ stop: true })`
  stops them.
- Both drivers re-attach. The Claude driver saves which of Claude's control requests are open and
  what it needs to translate the rest of the stream; the Codex driver saves its JSON-RPC client's
  pending requests, Codex's open requests, the Codex thread and turn, and serves the app's tools
  on the loopback MCP server again on the port and with the token Codex was told about.
- A run that can't be re-attached to is stopped, and its turn ends with a `run.lost` notice: one
  in a newer run-directory format, or one still starting when the backend went (Codex's handshake
  hadn't finished). (A backend that has gone back to the direct spawner can't stop shim runs: it
  only ends their turns.)
- An app tool is saved as running before it runs (and isn't run if that can't be saved), so one
  that was running when the backend stopped isn't run again (it may have done what it does): the
  agent is told it may or may not have finished.
- A change of options or config before the restart still starts a new process at the next turn.
- `recover()` also prunes, now and every hour: finished runs' directories go after `keepDays`
  (14), and a run nothing follows any more (its backend died before saving it, or while stopping
  it) is stopped.
- Stopping a run is the harness's interrupt, then closing its input, then SIGTERM and SIGKILL to
  its process group (the SIGKILL to whatever is left of it, even once the harness has exited). A
  shim that dies without saying how its run ended (SIGKILL, a reboot) is noticed: the run ends with
  an error, and its harness is stopped. A process group is only ever signalled while it's still the
  run's, never one whose id has gone to another process (after a reboot, say).
- On Windows, which the shim doesn't run on, `shim()` is `direct()`.

## Tests

```sh
pnpm test                          # stores, every fixture through the fake CLI, driver tests
AGENT_THREADS_LIVE=1 pnpm test     # also smoke tests against the real claude and codex (a cent or so),
                                   # and the real codex against a local stand-in model (free)
```

The fixture test runs each recorded session in `spec/fixtures/claude` and `spec/fixtures/codex` through
`spec/tools/fake-cli.mjs`, which checks what the driver writes to it, and compares the events with
`expected.jsonl`. `src/test/mini-claude.mjs` and `src/test/mini-codex.mjs` are small scriptable fakes for what the
recordings don't cover (steering past a turn's end, every kind of approval, crashes, restarts).
The fixtures run under the shim too, and `src/test/restart.test.ts` kills a backend
(`src/test/backend.mjs`, the built package in a process of its own) partway through a fixture's
turn, starts another, and checks the thread finishes with exactly the fixture's events. Those
tests build `agent-threads-shim` with cargo if it isn't built (or use `$AGENT_THREADS_SHIM`).

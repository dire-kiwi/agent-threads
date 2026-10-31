# @dire-kiwi/agent-threads-node

agent-threads' Node backend: it runs threads on Claude Code (`claude -p`), sends their events to
your app and takes commands from it. It has no network layer: wire `subscribe()` and `handle()` to
your own transport (a WebSocket, SSE, IPC...). Codex comes next.

```ts
import { AgentThreads, FileStore, claudeCode, defineTool } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({
  store: new FileStore("./threads"), // or MemoryStore (the default), SqliteStore, or your own Store
  harnesses: { claude: claudeCode() }, // claudeCode({ bin, configDir, userSettings, ... })
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
await sdk.close(); // on shutdown: stops the harness processes
```

## Threads

- `create(options)` makes a thread (`harness`, `model`, `effort`, `permission_mode`, `cwd`,
  `title`, `metadata`) and sends its first `thread.updated`. It can have its own `tools`,
  `mcpServers`, `skills`, `permissions` and `systemPrompt`, on top of the instance's.
- `handle(command)` carries out a command from a client ([spec/PROTOCOL.md](../../../spec/PROTOCOL.md#commands)),
  and throws a `CommandError` for one it can't (an unknown thread, a malformed command). `send`,
  `interrupt`, `respond` and `setOptions` do the same from code.
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
yours: `close()` doesn't close it.

## Claude Code

- **One process per thread**, started at its first message and kept between turns, with
  `--input-format stream-json` and `--replay-user-messages`. After a restart (or a change of
  model, effort or permission mode) the next message starts a new one with `--resume`.
- **Steering**: a message sent during a turn goes in on stdin and is `queued` until Claude echoes
  it back. One it hasn't taken in when the turn ends starts the next turn; if Claude doesn't take it
  in within `steerGraceMs` (30s), it goes to a new process instead.
- **Interrupt** sends a `control_request` interrupt; if the turn hasn't ended after `stopGraceMs`
  (10s), the process's input is closed and it's sent SIGTERM.
- **Permissions**: `--permission-prompt-tool stdio`, so Claude asks over `can_use_tool` and the
  policy answers. `ask` opens a `permission` request for the user; answering it with `always` keeps
  that answer for the tool for the rest of the thread. AskUserQuestion is always a `question`.
- **App tools** are an in-process MCP server, `app`, answered over the control channel. Tool
  handlers get `ctx` with the thread's id and metadata, and the tool call's id.
- **Isolated config**: threads run with `--setting-sources ""` and `--strict-mcp-config`, so they
  see only the app's MCP servers and skills. Skills are copied into a generated `.claude/skills`
  directory passed with `--add-dir`. `claudeCode({ userSettings: true })` lets threads see the
  user's own settings instead; `configDir` points Claude at another config (and login).
- Tool results are cut to 30,000 characters (with `truncated`), and images become `[image]`.

Processes are started by a `Spawner`: `direct()` (the default) runs them as child processes, each
in its own process group, so they end with the backend. A shim spawner, whose runs survive a
restart, is coming.

## Tests

```sh
pnpm test                          # stores, every Claude fixture through the fake CLI, driver tests
AGENT_THREADS_LIVE=1 pnpm test     # also a smoke test against the real claude (a cent or so)
```

The fixture test runs each recorded session in `spec/fixtures/claude` through
`spec/tools/fake-cli.mjs`, which checks what the driver writes to it, and compares the events with
`expected.jsonl`. `src/test/mini-claude.mjs` is a small scriptable fake for what the recordings
don't cover (steering past a turn's end, crashes, restarts).

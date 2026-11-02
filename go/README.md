# agent-threads for Go

`github.com/dire-kiwi/agent-threads/go`, agent-threads' Go backend. It runs threads on Claude Code
(`claude -p`) and Codex (`codex app-server`), sends their events to your app and takes commands from
it. It has the Node backend's model and behaviour ([ts/packages/node](../ts/packages/node/README.md)),
and passes the same fixtures. It has no network layer: wire `Subscribe` (or `Events`) and `Handle`
to your own transport (a WebSocket, SSE, IPC...), as [docs/transport.md](../docs/transport.md)
says. [examples/chat-go](../examples/chat-go) is a WebSocket server that chat-node's React frontend
talks to.

It needs Go 1.26+, and no cgo. Nothing is published yet: `go get
github.com/dire-kiwi/agent-threads/go@main` takes a commit as a pseudo-version (with `GOPRIVATE`
set, the repository being private), or use a checkout with a `replace` directive
([how](../README.md#go-module)).

```go
import (
	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
	"github.com/dire-kiwi/agent-threads/go/sqlitestore"
)

store, _ := sqlitestore.Open("threads.db") // or agentthreads.NewMemoryStore(), NewFileStore(dir), or your own Store
sdk := agentthreads.New(agentthreads.Options{
	Store: store,
	Harnesses: map[string]agentthreads.Harness{ // both, by default
		"claude": agentthreads.ClaudeCode(agentthreads.ClaudeOptions{}),
		"codex":  agentthreads.Codex(agentthreads.CodexOptions{Home: "./codex-home"}),
	},
	Capabilities: agentthreads.Capabilities{
		Tools: []agentthreads.Tool{
			agentthreads.TypedTool("lookup_order", "Looks up an order by its id.",
				`{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}`,
				func(ctx context.Context, a struct{ OrderID string `json:"order_id"` }, call agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
					return agentthreads.Text("Order " + a.OrderID + ": 3 blue widgets."), nil
				}),
		},
		MCPServers: map[string]agentthreads.MCPServer{"docs": {URL: "https://example.com/mcp"}, "gh": {Command: "gh-mcp"}},
		Skills:     []agentthreads.Skill{agentthreads.SkillDir("./skills/support-agent")},
		Permissions: agentthreads.PolicyFunc(func(ctx context.Context, q agentthreads.PermissionQuery, t agentthreads.PermissionContext) agentthreads.Decision {
			if q.Kind == protocol.ToolKindRead {
				return agentthreads.Allow
			}
			return agentthreads.Ask // or Deny, DenyWith("why")
		}),
	},
})

thread, _ := sdk.Create(ctx, agentthreads.CreateOptions{Model: "sonnet", Cwd: "/srv/work", Metadata: map[string]any{"user": "u1"}})
stop := sdk.Subscribe(func(e protocol.ThreadEvent) { broadcast(e) }) // every thread's events, deltas included
err := sdk.HandleJSON(ctx, frame)         // send / interrupt / respond / set_options, from a client
snap, _ := sdk.Snapshot(ctx, thread.ID)   // for a client that just connected
events, _ := sdk.EventsSince(ctx, thread.ID, seq, 0) // for one catching up
sdk.Close(ctx) // on shutdown: stops the harness processes (or with the shim, leaves them going) and saves everything
```

## The API

- `context.Context` throughout. Every method may be called from any goroutine.
- `Create` makes a thread (harness, model, effort, permission mode, cwd, title, metadata) and sends
  its first `thread.updated`. It can have its own `Capabilities` (tools, MCP servers, skills,
  policy, system prompt), on top of the instance's; `Configure` sets them again after a restart.
- `Handle(ctx, protocol.Command)` and `HandleJSON(ctx, []byte)` carry out a command, after checking
  it against the protocol's schema (`protocol.Validate`), and return a `*CommandError` for one they
  can't (an unknown thread, a malformed command, a closed instance). `Send`, `Interrupt`, `Respond`
  and `SetOptions` do the same from code. They return once the thread has taken the command.
- `Subscribe(func(protocol.ThreadEvent))` calls the function with every thread's events, in order,
  one at a time, on a goroutine of the SDK's own (so it may call the SDK); `Events(ctx)` is the same
  as a channel. `Snapshot` is the thread's state now, text streamed so far included, and
  `EventsSince` its saved events after a `seq`, once what's been sent is saved.
- `Get`, `List` and `Delete` look threads up and remove them. `Close` stops the harness processes
  (or with the shim leaves them going) and saves everything; `Stop` stops shim runs too.
- `Recover(ctx)`, with the shim spawner, re-attaches to runs that outlived the last process
  ([docs/shim.md](../docs/shim.md)).
- **Tools** ([docs/tools.md](../docs/tools.md) has tools, MCP servers, skills and policies in
  full) implement `Tool` (`Name`, `Description`, `InputSchema`, `Run(ctx, args, call)`), or are
  made with `ToolFunc` or `TypedTool`. `Run`'s `ctx` is cancelled when the thread's harness process
  goes away; `call` has the thread's id and metadata and the tool call's id. A tool's `Structured`
  output goes in the call's `result.structured`.
- **Permission policies** implement `PermissionPolicy`: a `Decision` (`Allow`, `Deny`, `Ask`) is
  one that always gives itself, and `PolicyFunc` is a function. A policy runs on the thread's
  goroutine, before the harness hears more about the thread, so it should be quick: to leave it to
  the user, return `Ask`. An answer given `always` stands for that tool for the rest of the thread.

The types of the spec are in [protocol](protocol), generated from `spec/schema` (`make gen`), with
`ApplyEvent` (the reducer the snapshots are made with) and `Validate`. Their `Extra` keeps the
fields the spec doesn't name, so a value written again (by a store, say) is the value given.

## How it runs

Each thread has a goroutine of its own, which runs everything that touches the thread and its
driver, one thing at a time: its commands, its harness's output, timers, and what comes back from
tools and the store. So a thread behaves as the Node backend's does, step for step, and its state
needs no locks. What a step saves is handed to a writer, in order: events made together are saved
in one `AppendEvents` (with the run's offset, for the shim), and a store that fails is tried again,
in order, with nothing lost or numbered around a gap. Subscribers get events from one dispatcher
goroutine, in the order they were made.

The drivers are the Node backend's, in Go: everything in its README about Claude Code (steering,
interrupt, `can_use_tool`, the in-process `app` MCP server, AskUserQuestion, skills as a plugin,
isolated config) and Codex (approvals, `requestUserInput`, dynamic tools with the loopback MCP
fallback, child-thread subagents, `skills/list` and `skills/extraRoots/set`, an app-specific
`CODEX_HOME`) holds here too, with the options named the Go way (`ClaudeOptions.StopGrace`,
`CodexOptions.AppToolsOverMCP`...).

## Stores

`NewMemoryStore()`, `NewFileStore(dir)` (one JSONL file per thread, synced on each write) and
`sqlitestore.Open(path)` (modernc.org/sqlite, so no cgo) all pass
[spec/conformance/store.json](../spec/conformance/store.md). The file and SQLite stores' files are
the Node backend's, so either backend can open them. To keep threads in your own database,
implement `Store` and run the same cases with `storetest.Run(t, "spec/conformance/store.json",
open)`. The store is yours: `Close` doesn't close it.

## Runs that survive a restart

`agentthreads.Shim(path, agentthreads.ShimOptions{RunsDir: dir})` runs harness processes under
[agent-threads-shim](../shim/README.md), as [spec/RUNDIR.md](../spec/RUNDIR.md) says, so they
outlive the backend; call `Recover(ctx)` at startup to re-attach to them. Both drivers re-attach,
and everything in the Node README's "runs that survive a restart" holds here. On Windows, `Shim` is
`Direct`.

## Tests

```sh
go test ./...                       # needs node (the fake CLI) and cargo (to build the shim) for the fixtures
AGENT_THREADS_LIVE=1 go test -run Live .   # against the real claude and codex (a cent or so)
```

Every fixture in `spec/fixtures` runs with the direct spawner and under the shim, its events
compared with `expected.jsonl` by `spec/tools/check-events.mjs`; the restart tests kill a backend (a
process of its own) partway through a turn, and check the next one finishes it with exactly the
fixture's events. What the recordings don't cover (option changes in a running process, plans sent
back or talked over) runs against the Node backend's scriptable `mini-claude.mjs` and `mini-codex.mjs`.

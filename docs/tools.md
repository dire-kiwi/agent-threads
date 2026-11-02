# Tools, MCP servers, skills and permissions

What an agent can do is set by the app on the backend: its own **tools** (functions in the app's
language, run in process), external **MCP servers**, **skills**, a **permission policy** that
decides each tool call, and an optional system prompt. By default a thread sees only these: not the
user's own Claude Code or Codex config. This guide shows each in Node, Go and Rust, with notes on
how each harness does it.

## Capabilities: for every thread, or for one

The five are `Capabilities`, given to the backend for every thread, and to `create` for one thread
on top of them:

| | Node | Go | Rust |
| --- | --- | --- | --- |
| For every thread | `new AgentThreads({ tools, mcpServers, skills, permissions, systemPrompt })` | `Options{Capabilities: Capabilities{...}}` | `Options { capabilities: Capabilities {...}, .. }` |
| For one thread | `sdk.create({ ..., tools, mcpServers, skills, permissions, systemPrompt })` | `CreateOptions{Capabilities: Capabilities{...}}` | `CreateOptions { capabilities: Capabilities {...}, .. }` |
| Again, later | `sdk.configure(id, { tools, ... })` | `sdk.Configure(ctx, id, Capabilities{...})` | `sdk.configure(&id, CapabilitiesUpdate {...})` |

A thread runs with both: tools by name (the thread's own replacing the instance's of the same
name), MCP servers by name likewise, the skills of both, both system prompts (the instance's first),
and its own permission policy if it has one, or else the instance's (which asks, by default).

A thread's own capabilities are code, so they **aren't stored**: after the app restarts, give them
again with `configure` before the thread's next turn (its items, session and options come back by
themselves). The policy and the tools' code change at once, even for a running turn: its next
permission decision is the new policy's, and a call to an app tool runs the tool as it is now (or
fails, for one that's gone). What the harness is told when its process starts (which tools there
are, the MCP servers, the skills, the system prompt) changes from the thread's next turn, which
starts a new process. `configure` changes only what it's given: in Node, the fields it has; in Go,
those that aren't nil, and the system prompt only when it isn't empty (so it can't be cleared); in
Rust, those that are `Some` (`Some("")` clears the system prompt).

## App tools

A tool is a name, a description, a JSON Schema for its arguments, and a function. The function
gets the arguments and a context with the thread's id, the thread's `metadata` (which the app gave
`create`), and the tool call's id. It returns text for the agent, optionally with `structured`
output, which goes in the call's `result.structured` for the app's frontend to draw (the harness
only passes the text to the agent), or an error, which the agent is told. A tool that throws or
panics returns that as its error.

```ts
// Node
import { defineTool } from "@dire-kiwi/agent-threads-node";

const lookupOrder = defineTool<{ order_id: string }>({
  name: "lookup_order",
  description: "Looks up an order by its id.",
  input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  run: async ({ order_id }, ctx) => {
    const order = await db.order(order_id, { user: ctx.metadata.user }); // scoped to the thread's user
    if (!order) return { text: `There's no order ${order_id}.`, isError: true };
    return { text: `Order ${order_id}: ${order.summary}.`, structured: order };
  },
});
```

```go
// Go
lookupOrder := agentthreads.TypedTool("lookup_order", "Looks up an order by its id.",
	`{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}`,
	func(ctx context.Context, a struct {
		OrderID string `json:"order_id"`
	}, call agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
		var user string
		_ = json.Unmarshal(call.Metadata["user"], &user)
		order, ok := findOrder(user, a.OrderID)
		if !ok {
			return agentthreads.ToolOutput{Text: "There's no order " + a.OrderID + ".", IsError: true}, nil
		}
		return agentthreads.ToolOutput{Text: "Order " + a.OrderID + ": " + order.Summary + ".", Structured: order}, nil
	})
```

`ToolFunc` takes the arguments as `json.RawMessage` instead, and any type implementing `Tool`
(`Name`, `Description`, `InputSchema`, `Run`) is a tool too. A returned `error` is the tool's error.
`ctx` is cancelled if the thread's harness process goes away before the tool returns.

```rust
// Rust
use agent_threads::{ToolOutput, tool};
use serde_json::json;

let lookup_order = tool(
    "lookup_order",
    "Looks up an order by its id.",
    json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}),
    |args, ctx| async move {
        let user = ctx.metadata.get("user").and_then(|u| u.as_str()).unwrap_or_default().to_string();
        match find_order(&user, args["order_id"].as_str().unwrap_or_default()) {
            Some(order) => ToolOutput::text(format!("Order {}: {}.", order.id, order.summary)).with_structured(json!(order)),
            None => ToolOutput::error("There's no such order."),
        }
    },
);
```

The closure returns anything that's `Into<ToolOutput>`: a `String` or `&str`, a `ToolOutput`, or a
`Result` of either. Or implement the `Tool` trait (`async_trait`). `ctx.cancelled` is a `Cancellation`:
`ctx.cancelled.cancelled().await` resolves if the harness process goes away first (to
`tokio::select!` on), and `ctx.cancelled.is_cancelled()` says whether it has.

**Per-user tools.** Tools get the thread's `metadata`, so one set of tools can serve every user,
each thread seeing only its own user's data (`create({ metadata: { user } })`). Or give a thread
tools of its own in `create`.

**Rendering.** An app tool's call is a `tool_call` item of kind `app`, named as the tool is. The
React package draws it with the built-in renderer, or the app's own for that name:
`tools={{ lookup_order: { Row: OrderCard, alone: true } }}` (see
[the React README](../ts/packages/react/README.md#extending) and the chat example's
[OrderCard](../examples/chat-node/web/src/OrderCard.tsx)).

**Permissions.** The agent calling an app tool goes through the permission policy like any other
tool call, so allow the tools that only read in the policy, or the user is asked about each call.

| | Claude Code | Codex |
| --- | --- | --- |
| How the tools reach the agent | An in-process MCP server named `app`, declared in `--mcp-config` as an SDK server and answered over stream-json's control channel, as the official Agent SDK does: no HTTP server, no extra binary. Claude sees `mcp__app__lookup_order`; the tool_call is `lookup_order`, kind `app`. | `dynamicTools` on `thread/start`, answered over `item/tool/call`. Codex marks these experimental, so `appTools: "mcp"` (Go `AppToolsOverMCP`, Rust `AppTools::Mcp`) serves them on a loopback MCP server instead (streamable HTTP on 127.0.0.1, a random port and bearer token), as happens when Codex refuses dynamic tools. A resumed session keeps the dynamic tools it started with; tools changed since are served on the MCP server. |

## MCP servers

External MCP servers, by name: a command to run (stdio), or a URL (streamable HTTP, or SSE), with
arguments, environment or headers. The harness starts and talks to them; the backend only tells it
about them.

```ts
// Node
mcpServers: {
  shipping: { command: "node", args: ["shipping-mcp.js"], env: { API_KEY: key } },
  docs: { url: "https://example.com/mcp", headers: { authorization: `Bearer ${token}` } },
},
```

```go
// Go
MCPServers: map[string]agentthreads.MCPServer{
	"shipping": {Command: "node", Args: []string{"shipping-mcp.js"}, Env: map[string]string{"API_KEY": key}},
	"docs":     {URL: "https://example.com/mcp", Headers: map[string]string{"authorization": "Bearer " + token}},
},
```

```rust
// Rust
mcp_servers: [
    ("shipping".to_string(), McpServer::stdio("node", ["shipping-mcp.js"])),
    ("docs".to_string(), McpServer::http("https://example.com/mcp")),
]
.into(),
```

(In Rust, `McpServer::Stdio { command, args, env }`, `Http { url, headers }` and `Sse { url,
headers }` are the variants, for environment and headers.)

A call to an MCP tool is a `tool_call` of kind `mcp`, with `server` set and `name` the tool's own
name (without Claude's `mcp__<server>__` prefix), and the permission policy is asked about it with
the same `name` and `server`.

| | Claude Code | Codex |
| --- | --- | --- |
| Servers | `--mcp-config` with `--strict-mcp-config`, so only the app's servers load | `mcp_servers` in `thread/start`'s config (`http_headers` for headers) |
| SSE servers | Yes | No: Codex has no SSE transport, so the server is left out and a `notice` says so |

## Skills

A skill is a directory with a `SKILL.md` (and whatever it refers to), or a `SKILL.md`'s text with a
name. The backend copies them somewhere of the thread's own, so the harness loads them like any
other skill and the agent decides when to use one.

```ts
skills: ["./skills/order-support", { name: "tone", content: "---\nname: tone\ndescription: ...\n---\n..." }],
```

```go
Skills: []agentthreads.Skill{agentthreads.SkillDir("./skills/order-support"), {Name: "tone", Content: toneMd}},
```

```rust
skills: vec![Skill::Dir("skills/order-support".into()), Skill::Inline { name: "tone".into(), content: tone_md }],
```

| | Claude Code | Codex |
| --- | --- | --- |
| How | Written into a plugin (`app`) generated for each process and passed with `--plugin-dir`, which Claude loads even with no setting sources (a `.claude/skills` directory, it wouldn't). So the agent sees them as `app:<name>`, and loading one is a call to the `Skill` tool, which the policy is asked about. | Written to a directory for the process and given with `skills/extraRoots/set`. Unless `userConfig`, the other skills Codex finds (the user's `~/.agents/skills`, the project's) are listed and turned off in the thread's config, leaving the app's and Codex's built-in ones. Codex reads a skill's files with shell commands, so the policy is asked about those (`cat`, `sed -n`...). |

## The permission policy

Each tool call the agent wants to make (Claude's `can_use_tool`, Codex's approval requests, MCP
elicitations and the app's own tools) goes to the policy with a query: the tool's `name`, `kind`
(`shell`, `read`, `edit`, `search`, `web`, `mcp`, `app`, `subagent`, `todo`, `other`), its `input`,
a `title`, and where they apply the shell `command` (as the tool_call shows it, without Codex's
`bash -lc` wrapper), the MCP `server`, the harness's `reason` and the subagent call it's from. The
context has the thread and its metadata. The policy answers:

- **allow**: the call goes ahead.
- **deny**, optionally with a message, which the agent is told.
- **ask**: the thread opens a `permission` request, the user answers it with a `respond` command
  (the React package's `PermissionCard`), and the thread waits meanwhile (`status: waiting`). An
  answer given with `always` stands for that tool (the same name, kind and MCP server) for the rest
  of the thread.

The default policy asks about everything. A policy can be a constant, or a function (or, in Node
and Rust, an async one, to look something up):

```ts
// Node
permissions: (q, ctx) => {
  if (q.kind === "read" || q.kind === "search" || q.name === "lookup_order") return "allow";
  if (q.kind === "edit" && !ctx.metadata.canEdit) return { deny: "This thread can't edit files." };
  return "ask";
},
```

```go
// Go
Permissions: agentthreads.PolicyFunc(func(ctx context.Context, q agentthreads.PermissionQuery, t agentthreads.PermissionContext) agentthreads.Decision {
	switch {
	case q.Kind == protocol.ToolKindRead, q.Kind == protocol.ToolKindSearch, q.Name == "lookup_order":
		return agentthreads.Allow
	case q.Kind == protocol.ToolKindEdit && string(t.Metadata["canEdit"]) != "true":
		return agentthreads.DenyWith("This thread can't edit files.")
	}
	return agentthreads.Ask
}),
```

Go's policy runs on the thread's goroutine and must be quick: to leave a decision for later, return
`Ask`. `Allow`, `Deny` and `Ask` are policies themselves.

```rust
// Rust
permissions: Some(PermissionPolicy::from_fn(|q, ctx| match q.kind {
    ToolKind::Read | ToolKind::Search => PermissionDecision::Allow,
    _ if q.name == "lookup_order" => PermissionDecision::Allow,
    ToolKind::Edit if ctx.metadata.get("canEdit") != Some(&json!(true)) => PermissionDecision::deny("This thread can't edit files."),
    _ => PermissionDecision::Ask,
})),
```

`PermissionPolicy::from_async` takes an async closure, and `allow()`, `ask()` and `deny()` are
constants. A policy that throws or panics denies the call, saying why.

Allowing shell commands safely takes care: the chat examples' policies allow only a few commands
that read, with no shell syntax that could make them do more
([chat-node/server/policy.ts](../examples/chat-node/server/policy.ts)).

**Questions** aren't permissions: Claude's `AskUserQuestion` and Codex's `requestUserInput` always
open a `question` request for the user (`QuestionCard`), whatever the policy says. A `secret`
answer goes only to the harness: what's saved and sent shows `[secret]`.

**Permission modes** (`permission_mode` on `create`, or a `set_options` command) change what the
harness asks about at all:

| Mode | Claude Code | Codex |
| --- | --- | --- |
| `default` | asks the policy | approval policy `untrusted`, sandbox `workspace-write` |
| `accept_edits` | edits in the thread's `cwd` go ahead without asking | `on-request` in `workspace-write` |
| `plan` | plans, and changes nothing | `untrusted` in `read-only`, collaboration mode `plan` |
| `bypass` | nothing is asked | `never` in `danger-full-access` |

A new mode or model applies straight away where it can: Claude Code's running process is switched
(`set_permission_mode`, `set_model`), even mid-turn, and Codex takes them with its next turn, in
the same process. (A new effort starts a new Claude Code process at the next turn, as does clearing
Codex's model or effort. Claude Code
can't be switched to bypass mode unless it was started in it: until the next turn's new process,
the driver allows what it asks about.)

**Plans** aren't permissions either: in plan mode, Claude's `ExitPlanMode` and the plan Codex
proposes at the end of a turn open a `plan` request (`PlanCard`), whatever the policy says.
Approving it (`allow`, with the `permission_mode` to carry on in) switches the harness out of plan
mode and the agent starts on the plan in the same turn; denying it, with feedback as the
`message`, has it plan again.

## Config isolation

A thread sees only the app's tools, MCP servers and skills, not the user's own config, so an app
behaves the same on every machine and a user's MCP servers can't leak into it. The login is still
the user's (or one the app points at).

| | Claude Code | Codex |
| --- | --- | --- |
| By default | `--setting-sources ""` (none of the user's or the project's settings, hooks, MCP servers or skills) and `--strict-mcp-config` | A `CODEX_HOME` of the app's own (`home`, `~/.agent-threads/codex` by default), with none of the user's config, MCP servers or skills, and their login (`auth.json` from `$CODEX_HOME` or `~/.codex`) linked in, or copied where it can't be linked |
| The user's own config instead | `claudeCode({ userSettings: true })` (Go `UserSettings`, Rust `user_settings`) | `codex({ userConfig: true })` (Go `UserConfig`, Rust `user_config`) |
| Another login | `configDir` (`CLAUDE_CONFIG_DIR`) | `login`: another CODEX_HOME to link the login from, or none (Node `false`, Go `NoLogin`, Rust `None`) |
| Note | | `home` keeps the app's Codex sessions, which resuming a thread needs: keep it as long as the threads |

Both drivers take `bin` (and `binArgs`, for a script run by `node`), extra `args` and `env`; Codex
takes extra `config` for `thread/start` (its `config.toml` keys, dotted).

### Per-thread launch options

A thread can have launch options of its own, on top of the harness's: given when it's created, and
changed with `setOptions` (Go `SetOptions`, Rust `set_options`). They're stored with the thread
(in the store's thread record, as `launch`, not in the protocol's `Thread`, so clients never see
them), so a thread picked up after a restart starts its processes with them. A change applies from
the next process the thread starts, as a model change does; the `set_options` command from a client
can't change them.

```ts
const thread = await sdk.create({
  harness: "claude",
  launch: {
    args: ["--allowedTools", "Read Grep", "--settings", settingsJson],
    env: { TMPDIR: "/tmp/thread-1", NO_COLOR: null }, // null removes a variable
    addDirs: ["/srv/shared", "/srv/attachments"],
    configDir: "/srv/profiles/team-a/claude",
  },
});
await sdk.setOptions(thread.id, { launch: { ...launch, args: ["--disallowedTools", "Bash"] } }); // replaces them in full
```

| | Claude Code | Codex |
| --- | --- | --- |
| `args` | After the driver's and the options' `args`: `--allowedTools`, `--disallowedTools`, `--settings` and so on | After `app-server` and the options' `args`: `-c key=value`, say |
| `env` | On top of the options' `env`; `null` (Go `nil`, Rust `None`) removes a variable | The same |
| `addDirs` (Go `AddDirs`, Rust `add_dirs`) | `--add-dir`, once for each | Writable roots (`sandbox_workspace_write.writable_roots`, after any the options' `config` gives), relative ones in the thread's `cwd` |
| `configDir` (Go `ConfigDir`, Rust `config_dir`) | `CLAUDE_CONFIG_DIR`, in place of the options' `configDir` | `CODEX_HOME`, in place of the app's `home`, used as it is: its own login and `config.toml`, nothing linked in |

The harness keeps its sessions in its config directory, so a thread whose `configDir` changes can't
resume the session it had.

## Subagents

Subagents are the harness's own (Claude's Agent tool, Codex's child threads): a `tool_call` of kind
`subagent`, whose items have its id as their `parent_id`. They run with the thread's tools, MCP
servers, skills and policy, and their requests come to the same thread, with the subagent's
`parent_id`.

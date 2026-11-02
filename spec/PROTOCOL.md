# The agent-threads protocol

This is what every agent-threads backend (Go, Rust, Node) sends and accepts, and what the React
package renders. A backend sends **events** and accepts **commands**, both as JSON objects; the
app carries them over whatever transport it likes. The JSON Schemas in [schema/](schema/) are the
source of truth for the shapes, and this document says what they mean. See
[docs/design.md](../docs/design.md) for the design around it.

| Schema | Defines |
| --- | --- |
| [thread.schema.json](schema/thread.schema.json) | `Thread`, `ThreadStatus`, `PermissionMode`, `Run`, `Usage` |
| [item.schema.json](schema/item.schema.json) | `Item` and its variants, `ToolKind`, `ToolStatus`, `ToolResult`, `FileChange`, `Todo`, `Attachment` |
| [request.schema.json](schema/request.schema.json) | `ThreadRequest` (`PermissionRequest`, `QuestionRequest`, `PlanRequest`), `Question`, `Resolution` |
| [event.schema.json](schema/event.schema.json) | `ThreadEvent` and its variants |
| [command.schema.json](schema/command.schema.json) | `Command` and its variants |
| [snapshot.schema.json](schema/snapshot.schema.json) | `Snapshot` |

`protocol.schema.json` bundles them into one schema, and the TS, Go and Rust types are generated
from it: run `make gen` after changing a schema. [examples/](examples/) has a whole thread's events,
the snapshot they fold into, and one of each command; every language's tests read them.
[fixtures/](fixtures/README.md) has recorded Claude and Codex sessions with the events a backend
must make of them, which is where the translation from each harness is pinned down.

## Conventions

- Field names are `snake_case`. Unions (`Item`, `ThreadRequest`, `ThreadEvent`, `Command`) are told
  apart by their `type` field.
- An optional field may be left out. An optional boolean that's left out is `false`, and an
  optional string is never empty, so backends may leave out `false` and `""` and receivers must
  treat them as absent. Required arrays are always present, even when empty.
- Ids are opaque strings. A backend picks thread, turn and request ids; item ids are the
  harness's where it has them (Claude's `tool_use` ids, Codex's item ids), so they're stable across
  replays of the same session.
- Timestamps are RFC 3339 strings, in UTC.
- Receivers ignore fields they don't know, so a field can be added without breaking anyone. A new
  item, event or command type is a breaking change, until 1.0 at least.
- `raw`, on items, requests and events, is the harness payload something came from, for debugging.
  A backend can leave it out (and can be told to), and clients mustn't depend on it.

## Threads

A `Thread` is one conversation with one harness (`claude` or `codex`). Its `status` is:

- `idle`: no turn is running.
- `running`: a turn is running.
- `waiting`: a turn is waiting on an open request.
- `error`: the last turn failed or the harness couldn't start (`error` says why). The next `send`
  tries again.

`session_id` is the harness's own session id, which the backend uses to resume the conversation
in a new process. `run` is the process running the thread, when one is: a `direct` run is a child
of the backend and ends with it; a `shim` run is supervised by `agent-threads-shim` and survives a
backend restart, and its `reattached_at` is set when a restarted backend picks it up again
([RUNDIR.md](RUNDIR.md) has how backends and the shim share a run).
`usage` sums the thread's turns. `metadata` is the app's own, given when it created the thread.

Threads are created, listed and deleted through each backend's API, not through commands.

## Items

A thread's content is a list of items, in the order they happened. Every item has `id` and `type`,
and may have `parent_id`, `turn_id`, `created_at` and `raw`.

| Type | What |
| --- | --- |
| `user_message` | A message to the agent: `text` and optional `attachments`. `steered` if it was sent while a turn was running and joined it. `queued` while the harness hasn't taken it in yet; an `item.updated` clears it. `client_id` copies the `send` command's. |
| `assistant_message` | Text from the agent, as Markdown. |
| `reasoning` | The agent's thinking, or a summary of it. |
| `tool_call` | A tool call and, once it has one, its `result`. See below. |
| `compaction` | The harness compacted its context: `trigger` (`auto` or `manual`), `summary`, `tokens_before`. |
| `notice` | Something to tell the user that isn't the agent talking: `level` (`info`, `warning`, `error`), `text`, `detail`, and a `code` such as `run.reattached`, `run.lost`, `retry`, `hook` or `stderr`. |
| `turn_result` | How a turn ended; the last item of each turn. `ok`, `interrupted`, `error`, `usage`, `duration_ms`. |

### Tool calls

A `tool_call` has the harness's `name` for the tool and its `input` as the harness gave it. Its
`kind` says what the tool does, for permission policies and for picking a renderer:

| Kind | For | Normalized fields |
| --- | --- | --- |
| `shell` | Running a command (Bash, Codex's commandExecution) | `command`; the result's `exit_code` |
| `read` | Reading a file | `path` |
| `edit` | Writing or patching files (Edit, Write, apply_patch, fileChange) | `changes`: `{path, op, diff?, move_to?}` |
| `search` | Finding files or text (Glob, Grep) | `query` (the pattern), `path` |
| `web` | Fetching or searching the web | `url`, `query` |
| `mcp` | A tool on an external MCP server | `server`; `name` is the tool's own name |
| `app` | A tool the app defined | |
| `subagent` | Starting a subagent (Claude's Agent/Task, Codex's child threads) | `title` (its description) |
| `todo` | Updating the agent's plan or todo list (TodoWrite, Codex's plan updates) | `todos`: the whole list |
| `other` | Anything else | |

The normalized fields mean a UI can show a call the same way for either harness; `title` is a short
summary for any kind. `status` goes from `pending` (called, e.g. waiting for permission) to
`running`, then to `completed`, `failed` (its `result.content` is the error), `denied` (permission
was refused) or `cancelled` (the turn ended first). `result.content` is text: images become
`[image]`, and backends may cut it short, setting `truncated`. `result.structured` has structured
output, when the tool gave some.

### Subagents

A subagent is a `tool_call` of kind `subagent`. Everything the subagent does (its messages,
reasoning and tool calls) is an item whose `parent_id` is that call's id, in the same thread and
the same item list. Requests from a subagent have its `parent_id` too. The call's `result` is what
the subagent returned.

## Requests

A request is something the agent is waiting on the user for. It's open from `request.opened` until
`request.resolved`, and the user answers it with a `respond` command. A thread can have several
open at once (e.g. from parallel subagents).

- `permission`: the agent wants to call a tool and the app's permission policy said "ask". It has
  the tool's `name`, `kind` and `input`, the `tool_call_id` of the call when there is one, a `title`
  and the harness's `reason`. Policies that answer `allow` or `deny` themselves don't open one.
- `question`: the agent asks one or more `questions` (Claude's AskUserQuestion, Codex's
  requestUserInput). Each has an `id`, the `question`, an optional `header`, and `options` to choose
  from (`multi_select` for more than one). With no options, or with `allow_other`, the answer is
  free text. A `secret` answer mustn't be shown or logged.
- `plan`: the agent has made a `plan` (Markdown) and asks to start on it: Claude's ExitPlanMode
  (with the `tool_call_id` of its call), or the plan Codex proposes at the end of a turn in plan
  mode. It's always the user's to answer, whatever the permission policy.

A `Resolution` answers a request. `outcome` is `allow` or `deny` for a permission, with `always` to
give the same answer to matching calls for the rest of the thread, and an optional `message` (for a
deny, the agent is told it). For a plan, `allow` starts on it: the thread's `permission_mode`
becomes the resolution's `permission_mode` (the thread's own if that's left out, or `default` if the
thread's is `plan`), and the harness leaves plan mode straight away, in the same turn. `deny` keeps
it planning, and its `message` is the user's feedback on the plan. For a question it's `answer`, with `answers` mapping each question's
id to the chosen option labels or the free text. `cancel` dismisses either; the backend also
resolves its open requests with `cancel` when their turn ends first.

## Events

Every event has `type`, `thread_id` and `seq`, and may have `raw`.

| Type | Fields | Meaning |
| --- | --- | --- |
| `thread.updated` | `thread` | The thread's own state changed. It carries all of it. |
| `turn.started` | `turn_id` | A turn started. |
| `turn.completed` | `turn_id` | A turn ended. Its `turn_result` item comes just before. |
| `item.added` | `item` | An item was added at the end of the list. If the thread already has an item with its id, it replaces that one in place. |
| `item.updated` | `item_id`, `patch` | Fields of an item changed: each of the patch's fields replaces the item's, and one set to `null` is removed. `id` and `type` never change. |
| `delta` | `item_id`, `kind`, `offset`, `text` | Streamed text to append to an `assistant_message` (`kind: text`) or `reasoning` (`kind: reasoning`) item's `text`, which was `offset` long before it. |
| `request.opened` | `request` | A request was opened. |
| `request.resolved` | `request_id`, `resolution` | A request was answered or cancelled. |

The backend changes the thread's `status` with `thread.updated` alongside these (to `running` when
a turn starts, `waiting` while a request is open, and back), and doesn't leave a client to infer it.

### Sequence numbers and saving

Every event but `delta` is **saved**: it's stored, and a thread's saved events have `seq` 1, 2, 3...
with no gaps. `delta` events aren't saved and don't advance `seq`: a delta's `seq` is that of the
last saved event before it. Its `offset` is the length of the item's text before it (after the
item's `item.added` or last `item.updated` with `text`, and the deltas since), in UTF-16 code units,
as JavaScript counts a string's length.

A streamed message goes: `item.added` with the item and the text so far (often `""`), any number of
`delta`s, then an `item.updated` with the final `text`. A client that misses the deltas still ends
up with the whole text, and a backend without partial output just sends the `item.added` with all of
it.

### Applying events

A thread's state is a `Snapshot`, `{thread, items, requests, seq}`, and applying its saved events in
order to the empty state (`items` and `requests` empty, `seq` 0) gives it. `applyEvent` in
`@dire-kiwi/agent-threads-protocol` is the reference implementation, and backends' snapshots follow
the same rules:

1. An event for another thread changes nothing.
2. A saved event whose `seq` is at or below the state's is already in it, and changes nothing. So
   events can be delivered more than once.
3. Otherwise the event is applied as described above, and the state's `seq` becomes the event's.
   (`turn.*` events change nothing else.) An `item.updated` or `request.resolved` for an id the
   state doesn't have only advances `seq`.
4. A `delta` is applied when the state has its item, the item is the delta's `kind`'s type, and
   the delta's `seq` isn't below the state's (one from before the last saved event the state has
   is already in it). Its `text` goes at `offset` in the item's text: what's already there (the
   item's text is longer than `offset`) is skipped, and the rest appended. A delta whose `offset`
   is past the end of the item's text (deltas were missed) or with nothing new changes nothing,
   and the item's final text puts it right. A delta doesn't change `seq`.

A backend's live snapshot includes the deltas it has applied, so a client that connects in the
middle of a message gets the text so far. Deltas it gets after the snapshot that the snapshot
already has (it subscribed first, so as to miss nothing) carry offsets the snapshot's text is
already past, and are skipped rather than added twice.

### Reconnecting

A client keeps the `seq` of its state. If a saved event arrives whose `seq` is more than one past
it, the client missed events: it asks the backend for the events after its `seq`, or for a fresh
snapshot (backends offer both), instead of applying it. A client that reconnects does the same.

## Commands

Every command has `type` and `thread_id`.

| Type | Fields | Meaning |
| --- | --- | --- |
| `send` | `text`, `attachments?`, `client_id?` | Send the agent a message. With no turn running it starts one; with one running it steers it (the message joins the running turn, as a `user_message` with `steered`). A steered message the harness doesn't take in before the turn ends starts the next turn. |
| `interrupt` | | Stop the running turn. Its `turn_result` has `interrupted`. Does nothing if no turn is running. |
| `respond` | `request_id`, `resolution` | Answer an open request. Answering one that isn't open does nothing. |
| `set_options` | `model?`, `effort?`, `permission_mode?` | Change the thread's options; ones left out stay as they are. They apply straight away where the harness allows, and otherwise from the next turn, and a `thread.updated` follows. |

`permission_mode` is `default` (ask via the permission policy), `accept_edits` (file edits in the
thread's `cwd` are allowed without asking), `plan` (the agent plans and changes nothing, and asks to
start on its plan with a `plan` request) or `bypass` (nothing is asked). `effort` is the harness's own
name for a reasoning effort.

Claude Code takes a new model and permission mode in its running process (`set_model` and
`set_permission_mode`), so they apply straight away, even to the running turn; a new effort applies
from the next turn, in a new process. Codex takes all three with its next turn (`turn/start`'s
overrides, and its plan collaboration mode), in the same process; a model or effort that's cleared,
which it can't be told, starts a new process at the next turn, with Codex's own.

A backend's `handle(command)` reports a command it can't carry out (an unknown thread, a malformed
command) to its caller, rather than as an event.

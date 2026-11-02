# The agent-threads protocol

This is what every agent-threads backend (Go, Rust, Node) sends and accepts, and what the React
package renders. A backend sends **events** and accepts **commands**, both as JSON objects; the
app carries them over whatever transport it likes. The JSON Schemas in [schema/](schema/) are the
source of truth for the shapes, and this document says what they mean. See
[docs/design.md](../docs/design.md) for the design around it.

| Schema | Defines |
| --- | --- |
| [thread.schema.json](schema/thread.schema.json) | `Thread`, `ThreadStatus`, `PermissionMode`, `Run`, `RateLimit`, `Usage` |
| [item.schema.json](schema/item.schema.json) | `Item` and its variants, `ToolKind`, `ToolStatus`, `ToolResult`, `FileChange`, `Todo`, `TurnSession`, `Attachment` |
| [request.schema.json](schema/request.schema.json) | `ThreadRequest` (`PermissionRequest`, `QuestionRequest`), `Question`, `Resolution` |
| [event.schema.json](schema/event.schema.json) | `ThreadEvent` and its variants |
| [command.schema.json](schema/command.schema.json) | `Command` and its variants |
| [snapshot.schema.json](schema/snapshot.schema.json) | `Snapshot`, `ItemPage` |

`protocol.schema.json` bundles them into one schema, and the TS, Go and Rust types are generated
from it: run `make gen` after changing a schema. [examples/](examples/) has a whole thread's events,
the snapshot they fold into, a window of it and a page before that window, and one of each command;
every language's tests read them.
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
- `raw`, on items, requests and events, is the harness message something came from. Backends
  leave it out unless the app turns it on ([Pass-through](#pass-through) has the rules), and
  clients mustn't depend on it.

## Threads

A `Thread` is one conversation with one harness (`claude` or `codex`). Its `status` is:

- `idle`: no turn is running.
- `running`: a turn is running.
- `waiting`: a turn is waiting on an open request.
- `error`: the last turn failed or the harness couldn't start (`error` says why). The next `send`
  tries again.

`session_id` is the harness's own session id (Claude Code's `session_id`, Codex's thread id), which
the backend uses to resume the conversation in a new process; `resume_at` is set after a rewind,
until the harness has gone back there (see [Sessions](#sessions)). `run` is the process running the thread, when one is: a `direct` run is a child
of the backend and ends with it; a `shim` run is supervised by `agent-threads-shim` and survives a
backend restart, and its `reattached_at` is set when a restarted backend picks it up again
([RUNDIR.md](RUNDIR.md) has how backends and the shim share a run).
`usage` sums the thread's turns. `metadata` is the app's own, given when it created the thread.

`rate_limits` are the usage limits of the account the harness runs on (a subscription's session and
weekly limits), as the harness last reported them in this thread: each has the harness's `id` for
it, a `status` (`allowed`; `warning` when it's nearly used up, or used up with extra usage carrying
on; `rejected` when the harness refuses turns until it resets), and `used_percent`, `resets_at` and
`window_minutes` when the harness says. A report replaces the limits it names and leaves the others,
and they're kept sorted by `id`. They're the account's, so a thread's can be out of date when
another thread (or app) used the account since; an app that queues work until a limit resets, or
switches logins, reads them from whichever thread reported last. How each harness's reports map onto
them is in [fixtures/README.md](fixtures/README.md#the-expected-events).

Threads are created, listed and deleted through each backend's API, not through commands. A thread
can be created with a `session_id`, to adopt a conversation the harness already has: its first turn
resumes it. The conversation so far isn't made into items; the thread starts empty.

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
| `turn_result` | How a turn ended; the last item of each turn. `ok`, `interrupted`, `error`, `usage`, `duration_ms`, and `session`: where the turn left the harness's session (see [Sessions](#sessions)). |

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
| `subagent` | Starting a subagent (Claude's Agent/Task, Codex's child threads) | `title` (its description), `subagent` |
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

Where the harness says how the subagent itself is getting on, the call has a `subagent` with its
`status` (`running`, `completed`, `failed` or `stopped`), `agent_type`, `model`, `tool_uses`, its
latest `activity`, and whether it runs in the `background`. A call that starts a subagent some
other way (a skill Claude runs in a forked subagent) becomes a `subagent` call once the subagent
starts.

A **background** subagent's call completes as soon as it has started the subagent, which carries
on: its `subagent.status` stays `running`, and its items keep coming, after its turn has ended
too. Its calls and requests aren't cancelled when its turn ends, so the thread can be `waiting`
(on one of its requests) with no turn running; answering it leaves the thread `idle`. When it ends,
its `subagent.summary` is its report (its call's `result` only says it started). A subagent still
running when its harness process ends is `stopped`, and its calls still running are `cancelled`.

The harness can start a **turn by itself**, with no `user_message`: Claude Code does when a
background subagent ends, to tell the agent. It goes as any turn does (`turn.started`, the thread
`running`, a `turn_result`, `turn.completed`). If the user sent a message just before (so a turn of
theirs is running), what the harness does by itself goes in the user's turn, which ends when the
harness is done with the user's message. A backend that restarts and can't pick up a thread's run
stops its subagents that were running.

## Sessions

A thread's conversation with its harness is a **session**, whose id is the thread's `session_id`.
The backend starts one at the thread's first turn (or adopts the one the thread was created with),
resumes it in each new process, and can take it back, replace it, or compact it:

- **Rewind** (the `rewind` command): back to before one of the thread's turns. The harness forgets
  that turn and every turn after it: Claude Code resumes the session at the last message of the turn
  before (`--resume <session_id> --resume-session-at <uuid>`), and Codex reverts its thread to before
  the turn (`thread/revert`). The thread's items from that turn on are removed with an
  `items.removed` event, and a `notice` with code `rewind` is added where they were.
- **New session** (the `new_session` command): the next turn starts a new conversation, in the same
  thread, with its items kept. A `notice` with code `session.new` marks where.
- **Compaction** (the `compact` command): the harness compacts its context now, in a turn of its
  own, which adds a `compaction` item (Claude Code's `/compact`, Codex's `thread/compact/start`).

Each `turn_result` has the turn's `session` (when the thread had one at its end): its `id`, the
harness's own mark for the turn as `at` (Claude Code's last message in it, Codex's id for the turn),
and `started` if the turn started that session. That's what a rewind works from, so it can go back
to a turn in an earlier session (before a `new_session`) too. To rewind to before turn T:

- If T started its session, or there was none at its end, the next turn starts a new session.
- Otherwise T continued session S (its `session.id`). **Claude Code** resumes S at the `at` of the
  latest turn before T in S that has one. If there's none (T was the first turn in the thread of a
  session it was created with, whose earlier messages it doesn't know), it can't rewind there.
  **Codex** reverts S to before the `at` of the first turn from T on, in S, that has one; if none
  has, S is as it was before T, and nothing is reverted, except what an earlier rewind in S not
  yet made (the thread's `resume_at`) still has to: it stays.

The thread's `session_id` becomes S (or is cleared), and its `resume_at` the message to resume at
or the turn to revert to before. The harness goes back there at the start of the next turn, in a
new process, and `resume_at` is cleared once it has.

A rewind or `new_session` is the end of what was still going on in the old session: the thread's
running subagents (a background one goes on after its turn) are `stopped`, its open requests are
resolved with `cancel`, and its harness process is stopped at once, and nothing it says after
reaches the thread (Claude Code would otherwise start a turn of its own, in the old session, when
a background subagent ended).

## Requests

A request is something the agent is waiting on the user for. It's open from `request.opened` until
`request.resolved`, and the user answers it with a `respond` command. A thread can have several
open at once (e.g. from parallel subagents). Once it's resolved, the thread's state keeps it with
its `resolution` set, so a UI can go on showing what was asked and how it was answered; a request
without a `resolution` is open.

- `permission`: the agent wants to call a tool and the app's permission policy said "ask". It has
  the tool's `name`, `kind` and `input`, the `tool_call_id` of the call when there is one, a `title`
  and the harness's `reason`. Policies that answer `allow` or `deny` themselves don't open one.
- `question`: the agent asks one or more `questions` (Claude's AskUserQuestion, Codex's
  requestUserInput). Each has an `id`, the `question`, an optional `header`, and `options` to choose
  from (`multi_select` for more than one). With no options, or with `allow_other`, the answer is
  free text. A `secret` answer mustn't be shown or logged.

A `Resolution` answers a request. `outcome` is `allow` or `deny` for a permission, with `always` to
give the same answer to matching calls for the rest of the thread, and an optional `message` (for a
deny, the agent is told it). For a question it's `answer`, with `answers` mapping each question's
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
| `items.removed` | `item_ids` | Items were removed from the list (a rewind took the conversation back to before them). |
| `delta` | `item_id`, `kind`, `offset`, `text` | Streamed text to append to an `assistant_message` (`kind: text`) or `reasoning` (`kind: reasoning`) item's `text`, which was `offset` long before it. |
| `request.opened` | `request` | A request was opened. |
| `request.resolved` | `request_id`, `resolution` | A request was answered or cancelled. It stays in the state, with this `resolution`. |

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
   (`turn.*` events change nothing else.) A `request.opened` adds its request at the end of
   `requests`, or replaces the one with its id in place. A `request.resolved` sets its request's
   `resolution` (replacing one it had), leaving it where it is in `requests`. An `item.updated` or
   `request.resolved` for an id the state doesn't have only advances `seq`, and `items.removed`
   skips ids it doesn't have.
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

### Windows

A thread can run to thousands of items, so a client needn't load them all: a backend's snapshot can
be a **window** of the thread, taken with a limit, that has only its last items, and the client loads
earlier ones a page at a time as the user scrolls back. Items are added at the end of a thread's list
(an `item.added` for an id it has replaces that item in place), and only `items.removed` (a rewind)
takes any out, saying where they were: so windows and pages are told where they are by index, and an
item's index only changes, by the number of removed items before it, with an `items.removed`.

A window of a state with `n` items and a limit `limit` (less than `n`; with a limit of `n` or more it
is the whole state) has:

- `start`: `n - limit`, the index of the first item of the window. The window has the items from
  `start` to the end.
- `context`: the indices of the items from before `start` the window needs, ascending: the
  `parent_id` of each of its items, and of each open request, and the request's `tool_call_id`, and
  each subagent call (a `tool_call` of kind `subagent`) that's still `pending` or `running` (it may
  add items to the window later, which would have no call to belong to), and then each of those
  items' own `parent_id`, and so on (the subagent calls they belong to, however nested), where
  they're before `start`. `items` starts with these, in that order, followed by the
  window's items. Left out when there are none.
- `requests`: the open requests, and the resolved requests whose **anchor** is at `start` or after,
  or that have none, in the state's order. A request's anchor is the index of its `tool_call_id`'s
  item if the state has one, or else that of the last item with its `turn_id`.
- `thread` and `seq` as the state's.

A **page** (`ItemPage`) is the thread's items before an index `before` (a window's `start`), at most
`limit` of them: it has `start`, `max(0, before - limit)`; `items`, the items from before `start`
that its items need (`context`, worked out as for a window from its own items' `parent_id`s), then
the items from `start` up to `before`; `requests`, the requests whose anchor is in that range; and
`seq`, that of the state it was taken from. `start` 0 means there's nothing before it.

Events apply to a window as to any state (an event about an item or request it doesn't have only
advances `seq`), and leave `start` and `context` as they are, but for `items.removed`: its items
the window has go (context ones too), `start` goes down by the number of its `indices` below it,
and each index left in `context` by the number below that one. A page asked for before an
`items.removed` the client has applied since (by the time the page is put in: see below) is left out
(it's placed by indices that may have changed, either side of the removal) and the page before the
window's new `start` asked for instead. A client puts a page into its window
by putting the page's items in front of its own (`withPage` in `@dire-kiwi/agent-threads-protocol`):
the context items of both, ordered by index (the page's version of one they share), those of them
the page's own items include dropped, then the page's items from its `start`, then its own from its
old `start`. Its `start` becomes the page's, and `context` the indices of the context items it kept
(left out once `start` is 0). The page's requests go in front of its own, a page's version of one
it has replacing it in place. (So a window with pages put in it may not have its requests in the
state's order: a resolved request from a page can come before an open one the window had. A UI
places resolved requests by their anchor.)

A page may be taken from a later state than the client's (its `seq` is higher): the client keeps it
until it has applied the events up to the page's `seq` (they're on their way, as the page was taken
after them), and then puts it in, with what events it applied since setting what they set again;
unless one of those was an `items.removed`, which leaves it out as below, since the page's indices
already have the removal its window doesn't have yet. The page shows the client is behind, so it
also catches up as under Reconnecting (the events may have been missed, with no later one to show the
gap); if that doesn't bring the client to the page's `seq`, the load fails. A client that disconnects
while it waits gives the page up, and stops loading. One taken from an earlier state can't
be: the backend takes it after the client asked for it, so it has every event the client had then.
A client applies the saved events it applies while it waits for the page (those with a `seq` above
the page's) to the page's items and requests too, before putting it in, leaving out events that
would add one the page doesn't have.

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
| `set_options` | `model?`, `effort?`, `permission_mode?` | Change the thread's options; ones left out stay as they are. They apply from the next turn, or straight away where the harness allows, and a `thread.updated` follows. |
| `rewind` | `turn_id` | Take the conversation back to before that turn: the harness forgets it and every turn after, and their items are removed. See [Sessions](#sessions). |
| `new_session` | | The next turn starts a new conversation with the harness; the items stay. Does nothing if the thread has no session. |
| `compact` | | Compact the harness's context now, in a turn of its own (with no `user_message`) that adds a `compaction` item. |

`rewind`, `new_session` and `compact` are refused while a turn is running, and `compact` when the
thread has no session yet: interrupt the turn, or wait for it, first.

`permission_mode` is `default` (ask via the permission policy), `accept_edits` (file edits in the
thread's `cwd` are allowed without asking), `plan` (the agent plans and changes nothing) or
`bypass` (nothing is asked). `effort` is the harness's own name for a reasoning effort.

A backend's `handle(command)` reports a command it can't carry out (an unknown thread, a malformed
command) to its caller, rather than as an event.

## Pass-through

The protocol is what every app needs from a harness, the same for each. For what it leaves out,
every backend has three ways through to the harness itself, in its API rather than in the protocol
(an app's server uses them; it can forward what it likes to its clients). They're the same in each
backend, with each language's names; the fixtures' `pass-through` scenarios check them.

### Raw payloads

With the backend's `raw` option on (it's off by default), `raw` is filled in:

- An event made while the backend handles a message from the harness has that message as its
  `raw`, as the harness sent it: one of Claude Code's stdout lines, or one of Codex's JSON-RPC
  messages, parsed. That includes `delta`s, and every event a message leads to (a `result` ends the
  turn: its `turn_result` item, `turn.completed` and the `thread.updated` all have the `result`).
- An item or request made that way has the message as its `raw` too, and an `item.added` or
  `request.opened` has it only there, not on the event as well. `item.updated` events don't change
  an item's `raw`.
- Events, items and requests the backend makes itself have none: creating a thread, a `send`'s
  `user_message` and `turn.started`, answering a request, a turn ended because its process exited,
  `run.reattached` and `run.lost` notices. Nor do ones a backend makes later, after waiting on
  something (a permission policy that answers asynchronously, say).

`raw` is saved with the events, so a thread's events and snapshots get bigger with it on.

### Harness messages

A backend calls the app's harness message handler (`onHarnessMessage` in Node, `OnHarnessMessage`
in Go, `on_harness_message` in Rust) with each line a thread's harness process writes to stdout, in
order, once its driver has dealt with it, whether or not the driver made anything of it. So an app
can read what the protocol leaves out: Claude Code's `system` messages (`status`, `task_*`...),
`rate_limit_event`s in full, a result's `modelUsage`, Codex's `thread/tokenUsage/updated` and
`account/rateLimits/updated` notifications, and messages a newer CLI sends that the driver doesn't
know. It gets:

| Field | |
| --- | --- |
| thread id | The thread. |
| run id | The process (the thread's `run.id` while it runs). |
| harness | `claude` or `codex`. |
| line | The line as it was written, without its newline. |
| message | The line parsed as JSON; absent for a line that isn't JSON. |

It's called on the backend's reading of the process's output, so it should return quickly (and not
call back into the backend and wait). It's called for every line, including Claude Code's echoes of
the backend's own control responses and Codex's responses to the driver's requests. After a
restart, the backend reads a shim run's output again from where it last saved it, so lines after
that point can be passed twice.

### Control requests

`control(thread_id, request)` sends the thread's running harness process a request and returns its
answer:

- **Claude Code**: `request` is a `control_request`'s `request`, e.g. `{"subtype":
  "get_context_usage"}`. The backend sends it with a `request_id` of its own and returns the
  `control_response`'s `response` when its `subtype` is `success`; when it's `error`, the call fails
  with its `error`.
- **Codex**: `request` is `{"method": ..., "params": ...}` (`params` may be left out), e.g.
  `{"method": "account/rateLimits/read"}`. The backend sends it as a JSON-RPC request with an `id` of
  its own and returns its `result`, or fails with its `error`'s `message`.

It fails at once if the thread doesn't exist, has no running process (a thread's process starts at
its first `send` and is kept between turns, but not across a restart without the shim) or runs on a
harness that doesn't take requests; and if the process exits, or the backend closes, before it
answers. It doesn't wait for a turn to end, and it doesn't time out. The backend doesn't look at the
request or the answer, so the app mustn't use it to do what the driver does itself (start or steer a
turn, interrupt, answer the harness's requests), which would leave the driver out of step with the
process. Neither the request nor its answer is an event.

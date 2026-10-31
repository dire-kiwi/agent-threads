# Fixtures: the conformance suite

Recorded real sessions of `claude -p` and `codex app-server`, each with the events a backend must
make of it. Every backend (Node, Go, Rust) runs all of them in its tests: it drives the session
through the fake CLI in [../tools/](../tools/README.md), which replays the recording and checks
what the backend writes to it, and then compares the events it produced with the expected ones.
No CLI or login is needed.

They were recorded on 2026-10-31 with claude 2.1.312 (model `haiku`, which is claude-haiku-5-5) and
codex-cli 0.165.0 (model `gpt-5.6-luna`, effort `low`), by `spec/tools/record.mjs`.

## Layout

Each fixture is a directory `spec/fixtures/<harness>/<scenario>/`:

| File | What |
| --- | --- |
| `session.jsonl` | The raw stdio of the CLI, both ways, with timing. Its format is in [../tools/README.md](../tools/README.md#sessionjsonl). |
| `fixture.json` | What the test does: the thread's options, the permission policy, the app's tools and MCP servers, and the steps (commands to send and events to wait for). |
| `expected.jsonl` | The events the backend must produce, checked by hand, compared by the rules under [Comparing events](#comparing-events). |

## Scenarios

| Scenario | What it covers | Claude | Codex |
| --- | --- | --- | --- |
| `plain-reply` | One turn, streamed text, no tools | | |
| `tool-calls` | Built-in tools, allowed by the policy without asking | Read, Bash, Edit (Read and `wc` don't ask) | commandExecution ×2, fileChange (each asks, and the policy allows) |
| `permission-allow` | A permission request the user allows | `can_use_tool` for Bash | `item/commandExecution/requestApproval` |
| `permission-deny` | One the user denies | with a message the agent is told | `decline` |
| `ask-user-question` | A question the user answers | AskUserQuestion via `can_use_tool` | `item/tool/requestUserInput` |
| `app-tool` | A tool the app defines (`lookup_order`) | the in-process `app` MCP server, over `mcp_message` | `dynamicTools` and `item/tool/call` |
| `mcp-tool` | A tool on an external stdio MCP server (`echo`, [../tools/mcp-echo.mjs](../tools/mcp-echo.mjs)) | `--mcp-config` | `mcp_servers` in `thread/start`'s config, approved through an elicitation |
| `subagent` | A subagent and what it does | the Agent tool, with `parent_tool_use_id` | `spawnAgent` and a child thread |
| `steer` | A message sent while a turn runs | stdin, echoed back when it's taken in | `turn/steer` |
| `interrupt` | Stopping a turn while a command runs | `control_request` interrupt | `turn/interrupt` |
| `resume` | A turn, a backend restart, then a turn in a new process | `--resume <session_id>` | `thread/resume` |
| `compaction` | A turn, then `/compact` | sent as a message | sent as `thread/compact/start` |
| `error` | A turn that fails (the model doesn't exist) | an error result | a failed turn, after a warning |

Some things the recordings show that a backend has to deal with: Claude Code echoes the backend's
own `control_response`s back on stdout; it loads app and MCP tools lazily, so the agent calls
ToolSearch first; its thinking blocks arrive with empty text; it calls the Agent tool `Agent` (not
`Task`) though the init message lists `Task`. Codex asks for approval even for `cat` under the
`untrusted` policy; never completes an interrupted command's item; reports a thread's token totals
(again after a resume) rather than a turn's; and doesn't send `thread/started` for child threads.

## Running a fixture

What a backend's conformance test does with each fixture:

1. **Set up.** Make a temporary working directory and a temporary state directory. Configure the SDK
   with a Memory store, the direct spawner, and the harness binary pointed at the fake CLI
   (`node spec/tools/fake-cli.mjs`, or the script itself, which has a shebang), with
   `AGENT_THREADS_FIXTURE=<fixture dir>` and `AGENT_THREADS_FIXTURE_STATE=<state dir>` in its
   environment. Give it the fixture's `tools` (each tool returns its `result` text), its
   `mcp_servers` (the fake CLI never starts them), and a permission policy from `permissions`:
   `allow` allows every tool without asking, `ask` asks the user (opens a request) for every one.
2. **Create the thread** with `thread`'s options (`harness`, `model`, `effort`...) and the working
   directory, and collect every event the SDK sends for it, deltas included.
3. **Run the steps** in order:
   - `{"command": {...}}`: send the command, with the thread's id as `thread_id`. A `respond`
     leaves out `request_id`: fill in the id of the thread's open request (the fixtures only ever
     have one open).
   - `{"wait": {...}}`: wait for an event that matches the pattern: it has every field the pattern
     has, with the same value (objects are matched field by field, so `{"thread": {"status":
     "idle"}}` matches any thread.updated whose thread is idle). Only events after the previous
     step count: after the command was sent, or after the event the previous wait matched. Time
     out after 10 seconds or so.
   - `{"restart": true}`: close the SDK as an app shutting down would (closing its harness
     processes) and make a new one on the same store. Don't create the thread again; the next
     `send` resumes it.
4. **Finish.** After the last step, close the SDK and wait for the fake CLI processes to exit.
5. **Check.** The state directory has a report `run-<n>.json` for each of the session's runs, and
   each says `"ok": true` (see [../tools/README.md](../tools/README.md#reports)); and the events
   match `expected.jsonl` by the rules below (`node spec/tools/check-events.mjs <fixture dir>
   <events.jsonl>` does it, or a backend implements them natively). It's also worth checking that
   `snapshot(thread_id)` equals folding the events with `applyEvent`.

A wait is always on the last event the backend makes before the command, so once it's seen the
fake CLI is waiting for that command and nothing else can happen in between: the event order is the
same on every run.

### What the backend must send

The fake CLI checks the backend's arguments and input against the recording (exactly what's
compared is in [../tools/README.md](../tools/README.md#whats-checked)). So the fixtures fix how a
backend drives each CLI:

- **Process lifetime.** The CLI is started at the thread's first `send`, not when it's created: one
  process per thread, kept between turns until the SDK is closed, which closes its stdin (or kills
  it, once it has sent everything). After a restart, the next `send` starts a new process that
  resumes the session.
- **Claude Code.** Arguments `-p --output-format stream-json --verbose --include-partial-messages
  --input-format stream-json --replay-user-messages --permission-prompt-tool stdio
  --strict-mcp-config --forward-subagent-text --model <model>`, plus `--resume <session_id>`, and
  `--mcp-config` with the thread's MCP servers (stdio ones as `type: stdio`) and, when it has app
  tools, an in-process server named `app` (`{"type": "sdk", "name": "app"}`). It sends a
  `control_request` `initialize` first (with `sdkMcpServers: ["app"]` when there are app tools),
  and waits for its response before the first user message. User messages are
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]},"parent_tool_use_id":null}`.
  It answers `can_use_tool` with `behavior: allow` (and `updatedInput`; for AskUserQuestion, the
  input plus `answers`, keyed by question text, with the labels joined by `", "`) or `deny` with a
  `message`, and the `app` server's `mcp_message`s as an MCP server would. It interrupts with a
  `control_request` `interrupt`.
- **Codex.** Arguments `app-server`. It sends `initialize` (with `capabilities.experimentalApi`) and
  `initialized`, then `thread/start` (or `thread/resume` with the thread's `session_id`) with the
  model, `approvalPolicy: untrusted` and `sandbox: workspace-write` (permission mode `default`),
  and a config with `features.default_mode_request_user_input = true` (so the agent can ask
  questions outside plan mode), the MCP servers in `mcp_servers`, and app tools as `dynamicTools`.
  A message is `turn/start` with the text and the thread's `effort`; one sent during a turn is
  `turn/steer`; `/compact` is `thread/compact/start`; an interrupt is `turn/interrupt`. It answers
  approvals with `accept` or `decline`, MCP elicitations with `accept`, `requestUserInput` with
  `{answers: {<question id>: {answers: [labels]}}}`, and `item/tool/call` with the tool's text as
  `inputText` and `success: true`.

## The expected events

`expected.jsonl` follows these rules. They're what the fixtures hold backends to, so a new fixture
(or a re-recorded one) should be drafted by them; `spec/tools/draft-expected.mjs` does that.

### For both harnesses

- **Creating a thread** sends a `thread.updated` with it `idle`: its `id`, `harness`, `model`,
  `effort` (if given), `permission_mode` (`default` unless given) and `cwd`.
- **Sending a message with no turn running** adds a `user_message` (with the command's `client_id`
  and the new turn's `turn_id`), then sends `turn.started` and a `thread.updated` that's `running`.
- **Sending one during a turn** adds a `user_message` with `steered` and `queued`; when the harness
  takes it in, an `item.updated` sets `queued` to `null`.
- **The harness's session id**, once it's known, is set on the thread with a `thread.updated`.
- **Streamed text and reasoning**: the item is added (with `text: ""`) at its first non-empty
  delta, each delta is a `delta` event, and when the block is complete an `item.updated` sets the
  final `text`. Text that isn't streamed is added whole; an empty block adds nothing.
- **A tool call** is added with `status: running` when the harness announces it, and an
  `item.updated` sets its `status` and `result` when it ends.
- **A permission request** (when the policy asks): an `item.updated` sets the call `pending`, then
  `request.opened` and a `thread.updated` that's `waiting`. The answer sends `request.resolved`, a
  `thread.updated` that's `running`, and an `item.updated` that sets the call `running` (or
  `denied`). A denied call's later result only sets its `result`. With the `allow` policy, nothing
  of this is sent.
- **A question**: the same, with a `question` request.
- **The end of a turn**: calls still `running` or `pending` become `cancelled`, open requests are
  resolved with `cancel`, then a `turn_result` item is added, `turn.completed` is sent, and a
  `thread.updated` sets the thread `idle` (or `error`, with the turn's `error`) and adds the
  turn's usage to the thread's.
- **An interrupt** sends nothing itself. Its turn's `turn_result` has `ok: false` and
  `interrupted: true`, and the calls it cut short are `cancelled`.
- An `item.updated` is only sent when it changes something, and a `thread.updated` only when the
  thread changed.
- **Ids.** Items take the harness's ids where it has them (below). The backend picks the thread,
  turn, request, `user_message`, `turn_result` and `notice` ids, which `expected.jsonl` has as
  placeholders: `{{thread}}`, `{{t1}}`, `{{p1}}` (a permission request), `{{q1}}` (a question),
  `{{u1}}`, `{{tr1}}`, `{{n1}}`, and `{{cwd}}` for the working directory.

### Claude Code

- **Items**: a `tool_use` is a `tool_call` with its id. A text or thinking block is an
  `assistant_message` or `reasoning` with the id `<message id>:<block index>` (Claude Code sends
  each block of a message as its own `assistant` message, in order). A `compact_boundary` is a
  `compaction` with its `uuid` as id, `trigger`, and `pre_tokens` as `tokens_before`; the next
  synthetic user message is its `summary`.
- **Tools**: Bash is `shell` (`command`); Read `read` (`path`); Edit, MultiEdit, Write and
  NotebookEdit `edit` (`changes: [{path, op: update}]`, and when it ends the `diff`, made from the
  result's `structuredPatch` as `@@ -a,b +c,d @@` hunks); Glob and Grep `search`; WebFetch and
  WebSearch `web`; Agent and Task `subagent` (`title` is its `description`); TodoWrite `todo`;
  `mcp__app__<tool>` is `app` named `<tool>`; `mcp__<server>__<tool>` is `mcp` named `<tool>` with
  `server`; anything else (AskUserQuestion, ToolSearch...) is `other`.
- **Results**: a `tool_result`'s content is its text blocks joined by newlines (images are
  `[image]`, tool references their tool's name). `is_error` makes it `failed`, or `cancelled`
  after an interrupt.
- **Subagents**: messages with `parent_tool_use_id` are the subagent's, with that as `parent_id`.
  The subagent's own prompt (its first user message) isn't an item.
- **Questions**: AskUserQuestion's `can_use_tool` is always a question (whatever the policy). Each
  question's `id` is its text, and `allow_other` is set (Claude Code always offers "Other").
- **Left out**: `assistant` messages from the `<synthetic>` model (the error is in the turn's
  result), user messages that aren't a replay or a tool result, system messages other than `init`
  and `compact_boundary`, `rate_limit_event`, stream events other than text and thinking deltas,
  and the echoes of the backend's own control responses. A replayed (`isReplay`) user message
  takes in the queued message with the same text, if there is one.
- **The result**: `ok` is `!is_error`; `error` is the result's text; `usage` is `input_tokens`,
  `output_tokens`, `cache_read_input_tokens` as `cache_read_tokens`,
  `cache_creation_input_tokens` as `cache_write_tokens`, and `total_cost_usd` as `cost_usd`;
  `duration_ms` is the result's.

### Codex

- **Items**: `agentMessage` is an `assistant_message`; `reasoning` a `reasoning` (its summary);
  `commandExecution` a `shell` call named `commandExecution`, whose `command` is the command with
  Codex's `bash -lc '...'` wrapper taken off (its `input` keeps it as Codex gave it); `fileChange`
  an `edit` call; `mcpToolCall` an `mcp` call named by its tool, with `server`; `dynamicToolCall`
  an `app` call; `collabAgentToolCall` with `spawnAgent` a `subagent` call (its `title` is the
  prompt), and other collab calls (`wait`...) aren't items; `contextCompaction` a `compaction`
  (`trigger: manual`). A `userMessage` item takes in a queued steered message.
- **Statuses**: `completed`, `failed`, `declined` (which is `denied`). A command's `result` is its
  `aggregatedOutput` (`""` when it's `null`) with `exit_code`.
- **Subagents**: a `spawnAgent` call's `receiverThreadIds` are its child threads. Their items have
  the call's id as `parent_id`, and when the child's turn completes, so does the call, with the
  child's last message as its result. The child's prompt isn't an item.
- **Requests**: an approval is a `permission` for the item it names (an MCP elicitation, for the
  running call on that server). `item/tool/requestUserInput` adds a `tool_call` named
  `request_user_input` (`other`, `pending`) for it before the question; the answer completes it
  with one `<id>: <labels>` line per question.
- **Notices**: a `warning` notification is a `notice` with `level: warning`; an `error` that will
  be retried is a `notice` with `code: retry`. One that won't is the turn's `error`.
- **Usage**: Codex reports the thread's running totals, so a turn's usage is how far the last
  totals in the turn are past the thread's usage before it. `input_tokens` leaves out the cached
  ones (`cache_read_tokens`), as Claude's do. `duration_ms` is the turn's `durationMs`.

## Comparing events

A backend's events match `expected.jsonl` when, after both are normalized, they're equal in order,
with placeholders bound. `spec/tools/check-events.mjs` implements this.

1. **Seq.** The backend's saved events have `seq` 1, 2, 3... with no gaps, and each `delta` has the
   `seq` of the saved event before it.
2. **Normalize** both streams: leave out `raw`, `created_at`, `updated_at`, `seq` and the thread's
   `run`, and fields that are `false` or `""` (as the protocol allows), except inside `input` and
   `result.structured`, which are the harness's own; then drop a `thread.updated` whose thread is
   the same as the one before; then join consecutive deltas to the same item and kind into one.
   (So a backend may cut deltas differently, and send a `thread.updated` when only its run
   changes.)
3. **Compare** event by event. Every field must be equal, and the backend's events may not have
   fields the expected ones don't. Numbers may differ by one part in a billion (for summed costs).
   A string `"{{name}}"` in the expected events matches any value the first time and binds it;
   later, the same name must be the same value, and different names must be different values.

## Re-recording

When a CLI changes, or to add a scenario (in `spec/tools/scenarios/`):

```sh
node spec/tools/record.mjs claude all       # or a comma-separated list of scenarios
node spec/tools/record.mjs codex all
node spec/tools/draft-expected.mjs spec/fixtures/*/*
git diff spec/fixtures                        # check every change to expected.jsonl by hand
node --test 'spec/tools/test/*.test.mjs'
```

Recording needs both CLIs logged in; it costs a few cents. The models' replies vary between
recordings, so the expected events change too: review them as if they were new.

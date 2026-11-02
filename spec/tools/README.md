# spec/tools: recording and replaying sessions

The tools behind the conformance suite in [../fixtures/](../fixtures/README.md). They're Node
scripts with no dependencies (Node 20 or later).

| Tool | What |
| --- | --- |
| [fake-cli.mjs](fake-cli.mjs) | The fake `claude` / `codex` that backends' tests run: it replays a fixture's session and checks the backend's input. |
| [check-events.mjs](check-events.mjs) | Compares a backend's events with a fixture's `expected.jsonl`. |
| [record.mjs](record.mjs) | Records a scenario against the real CLI (needs a login; not run in CI). |
| [draft-expected.mjs](draft-expected.mjs) | Drafts a fixture's `expected.jsonl` and steps from its recording, to be checked by hand. |
| [mcp-echo.mjs](mcp-echo.mjs) | The stdio MCP server the `mcp-tool` scenarios were recorded with. |
| [scenarios/](scenarios/) | What each scenario does, per harness, when it's recorded. |
| [test/](test/) | Their tests: `node --test 'spec/tools/test/*.test.mjs'` (CI runs it). |

## Using the fake CLI in a backend's tests

A backend's conformance test configures its harness with the fake CLI as the binary and two
environment variables (so a harness's options need a binary path and extra environment), and runs
the fixture's steps (see
[Running a fixture](../fixtures/README.md#running-a-fixture)):

```ts
// e.g. in the Node backend's tests
const state = mkdtempSync(join(tmpdir(), "fixture-"));
const sdk = new AgentThreads({
  store: new MemoryStore(),
  harnesses: {
    claude: claudeCode({
      bin: "spec/tools/fake-cli.mjs",
      env: { AGENT_THREADS_FIXTURE: "spec/fixtures/claude/steer", AGENT_THREADS_FIXTURE_STATE: state },
    }),
  },
});
// ... create the thread, run the steps, close the SDK, then check the reports and the events.
```

| Variable | |
| --- | --- |
| `AGENT_THREADS_FIXTURE` | The fixture directory (or its `session.jsonl`) to replay. Required. |
| `AGENT_THREADS_FIXTURE_STATE` | A directory, fresh for each test, where the fake CLI keeps which of the session's runs is next and writes its reports. Required when the session has several runs (`resume`); worth setting always, since the reports are how the test knows the input matched. |
| `AGENT_THREADS_FIXTURE_SPEED` | `0` (the default) replays as fast as the backend keeps up; `1` keeps the recorded timing, e.g. to see how a UI copes. |

The fake CLI needs `node` on the `PATH`, as CI has for every job. A backend that can't run a script
as its binary can run `node` with `spec/tools/fake-cli.mjs` as the first argument.

### How it replays

Each time the backend starts it, the fake CLI takes the session's next run (`run-1.claimed`,
`run-2.claimed`... in the state directory), checks the arguments, and goes through the run's entries
in order:

- an output (`out`, `err`) is written to stdout or stderr straight away;
- at an input (`in`) it waits for the backend's next line and checks it. Recorded inputs that come
  one after another may arrive in any order, and an input the recording has later may arrive
  sooner (a backend that answers a permission straight away while the test sends an interrupt, say);
- at `close` it waits for stdin to close (it's fine if it already has);
- at `exit` it exits with the recorded code.

Ids the backend chooses for its own requests (Claude's `control_request` `request_id`s, Codex's
JSON-RPC request `id`s) are mapped: the recorded responses go out with the backend's ids. Ids the
CLI chose (session and thread ids, tool call ids, the CLI's own request ids) are replayed as
recorded, and the backend must use them as they are.

If something doesn't match, it writes what it expected and what it got to stderr, writes the
report, and exits with code **97**. A backend that sends SIGTERM (or SIGINT or SIGHUP) is fine
once it has sent all the run's input.

### Reports

For each run it writes `run-<n>.json` to the state directory when it ends:

```json
{"run": 1, "ok": true, "matched": 3, "expected": 3}
{"run": 1, "ok": false, "error": "input 2 of 3 doesn't match. ...", "matched": 1, "expected": 3}
```

A test passes only if there's a report for every run in the session (count the distinct `run`
values in `session.jsonl`) and each is `ok`. A missing report means the backend didn't start the CLI
as many times as the recording did.

### What's checked

Backends don't have to send byte-for-byte what the recorder sent. Each input is reduced to the
parts that matter (in [lib/canon.mjs](lib/canon.mjs)), and those must be equal:

| Input | Compared |
| --- | --- |
| Claude arguments | `-p`/`--print`, `--output-format`, `--input-format`, `--verbose`, `--include-partial-messages`, `--replay-user-messages`, `--permission-prompt-tool`, `--forward-subagent-text`, `--strict-mcp-config`, `--model`, `--resume`, `--resume-session-at`, `--permission-mode` (as `--flag value` or `--flag=value`), and `--mcp-config`'s server names and types (given as JSON or a file). Other flags are the backend's business. |
| Claude user message | The text (text blocks joined by newlines), the number of images, `parent_tool_use_id`. |
| Claude `control_request` | `subtype`; for `initialize`, the `sdkMcpServers`. |
| Claude `control_response` | `request_id` and `subtype`; for `can_use_tool`, `behavior`, and an allow's input (its `updatedInput`, or the input it was asked about if it has none; AskUserQuestion's `answers` are in it) or a deny's `message`; for `mcp_message`, the JSON-RPC id, and the tool names (`tools/list`) or the result's text (`tools/call`). |
| Codex arguments | The subcommand (`app-server`). |
| Codex request | `method`, and: `initialize`'s `experimentalApi`; `thread/start` and `thread/resume`'s `model`, `approvalPolicy`, `sandbox`, enabled `features.*` config, `mcp_servers` names, `dynamicTools` names (and `threadId`); `turn/start`'s `threadId`, text and `effort`; `turn/steer`'s `threadId`, `expectedTurnId` and text; `turn/interrupt`'s `threadId` and `turnId`; `thread/compact/start`'s `threadId`; `skills/list`'s `forceReload`; any other method's params in full. |
| Codex notification | `method`. |
| Codex response | The `id` it answers, and: an approval's `decision`; an elicitation's `action`; `requestUserInput`'s `answers`; `item/tool/call`'s `success` and text. |

## session.jsonl

One JSON object per line. The first is the session's `meta`; the rest are entries of its runs (a
run is one process), in order:

```json
{"dir":"meta","harness":"claude","scenario":"plain-reply","description":"...","cli":"2.1.312 (Claude Code)","model":"haiku","recorded":"2026-10-31"}
{"run":1,"t":0,"dir":"spawn","argv":["claude","-p","--output-format","stream-json",...],"cwd":"/work"}
{"run":1,"t":3,"dir":"in","msg":{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}}
{"run":1,"t":522,"dir":"out","msg":{"type":"control_response","response":{...}}}
{"run":1,"t":729,"dir":"err","text":"a line of stderr"}
{"run":1,"t":2455,"dir":"close"}
{"run":1,"t":3306,"dir":"exit","code":0,"signal":null}
```

`t` is milliseconds since the run's process started. `in` is what the backend wrote to stdin, `out`
what the CLI wrote to stdout (`msg` when it's JSON, `line` when it isn't), `close` when the backend
closed stdin, and `exit` how the process ended. `command` notes a command the app sent its backend
there that the CLI isn't sent as it is (`{"dir":"command","command":{"type":"rewind","turn_id":"{{t2}}"}}`),
for draft-expected.mjs; the fake CLI skips it. The meta line can have the `thread` options the
session needs (`adopt`'s `session_id`), which draft-expected.mjs puts in fixture.json.

## Recording

```sh
node spec/tools/record.mjs claude plain-reply     # one scenario, or a comma-separated list
node spec/tools/record.mjs codex all
```

The recorder plays the backend's part itself: the scenarios in [scenarios/](scenarios/) send what a
backend sends and answer what it answers, and note the app's commands that aren't sent as they are
(`p.note(command)`). A scenario can start a `setup` run that isn't recorded (`ctx.spawn(args,
handlers, { setup: true })`), to make a session for the recorded runs to start from. Each session runs in a new temporary directory, seeded
with `notes.txt` ([scenarios/common.mjs](scenarios/common.mjs)), with its own `CLAUDE_CONFIG_DIR`
or `CODEX_HOME` that has only the login linked in (`.credentials.json` or `auth.json`), so the
user's settings, MCP servers, skills, plugins and history stay out.

Before it's written, the recording is sanitized ([lib/sanitize.mjs](lib/sanitize.mjs)): the
temporary directories become `/work`, `/config`, `/codex-home` and `/tmp/recording`, the system's
own (a `TMPDIR` other than `/tmp`, where Claude keeps its tasks' output) `/tmp`, this checkout
`/repo`, the home directory `/home/user`, and the user name, host name (in any case) and git email
and name are replaced (Claude Code tells the model the git user, which can end up in a compaction
summary); Codex's `skills/list` answer keeps only its built-in skills, not the ones the machine has
(and the config that turned those off goes too);
account details (Claude's `account`, Codex's rate limits, emails, organization names, installation
ids) are replaced with placeholders; and it fails if anything still looks like a secret (an API key,
a JWT, a bearer token). Streamed text is cleaned as a whole stream, since a path can be split
across deltas.

Then draft the expected events and check them by hand, as
[../fixtures/README.md](../fixtures/README.md#re-recording) says.

# The chat examples' wire protocol

The SDK has no network layer: each example app brings its own. The chat examples (`chat-node`, `chat-go` and
`chat-rust`) all use the one described here, so the React frontend in
[chat-node/web](chat-node/web) talks to any of their servers unchanged. It's the app's protocol, not
the SDK's: the SDK's part is only what goes inside it, the [protocol](../spec/PROTOCOL.md)'s
`ThreadEvent`s, `Command`s, `Snapshot`s and `Thread`s, carried as they are.

## What a server serves

| | |
| --- | --- |
| `GET /ws` | The WebSocket. Everything below goes over it, one JSON object per text frame. |
| `GET /*` | The built frontend, `chat-node/web/dist` (`index.html` for any path that isn't a file). |
| `PORT` | The port to listen on, `3001` by default, on 127.0.0.1. |

**Who may connect.** Listening on 127.0.0.1 isn't enough: any web page the user has open can open
a WebSocket to it, and that socket could read every thread, send the agent anything and allow its
own permission requests. So the server refuses the WebSocket upgrade (403) unless its `Host` is
`localhost`, `127.0.0.1` or `[::1]` with the server's port (or, in development, Vite's: 5173),
which a rebound DNS name can't be, and its `Origin`, when it has one, is that same host (the app's own page; clients
that aren't browsers send none). That's the examples' only check: a real app authenticates its
users here. It also mustn't let a malformed frame or URL take it down: frames that aren't requests
are ignored, one the socket can't take (text that isn't UTF-8, one too big) closes that socket
only, and a path that doesn't decode is a 400.

In development the frontend runs under Vite (`chat-node/web`, port 5173), which proxies `/ws` to
`http://127.0.0.1:$PORT`, so any server on that port works with it.

## Client to server: requests

Each request has an `id` the client picks (a number), a `method` and its `params`:

```json
{"id": 3, "method": "create", "params": {"harness": "claude", "model": "haiku", "title": "Where's order 42?"}}
```

and gets exactly one reply with that `id`, either a `result` or an `error` (a message for the user):

```json
{"id": 3, "result": {"id": "th_…", "harness": "claude", "status": "idle", …}}
{"id": 3, "error": "there's no harness \"grok\""}
```

| Method | Params | Result |
| --- | --- | --- |
| `hello` | | `{harnesses, restart}`: the harnesses threads can run on, as `[{name, label, model, models}]` (`model` the default, `models` suggestions; the user may type another), and whether `restart` is offered (chat-node offers it only when its runs are under the shim, which a restart doesn't lose). |
| `list` | | `Thread[]`, newest first. |
| `create` | `{harness, model?, title?}` | The new `Thread`, with the server's defaults for what's left out (the harness's model, an effort, the working directory). Its first `thread.updated` is pushed too. |
| `snapshot` | `{thread_id}` | The thread's `Snapshot` (`sdk.snapshot`). |
| `events_since` | `{thread_id, seq}` | `ThreadEvent[]`: its saved events after `seq` (`sdk.eventsSince`). |
| `command` | `{command}` | `null` once the backend has taken the `Command` (`sdk.handle`); an error if it refused it. |
| `restart` | | `null`, then the server shuts down (leaving shim runs going) and is started again by whatever runs it. Only when `hello` said `restart: true`. |

## Server to client: events

Every thread's events, deltas included, go to every connected client as they happen:

```json
{"type": "event", "event": {"type": "delta", "thread_id": "th_…", "seq": 12, "item_id": "…", "kind": "text", "offset": 40, "text": "…"}}
```

Replies have an `id` and pushes a `type`, so a client tells them apart by that.

## What the frontend does with it

- On connecting it calls `hello` and `list`, and keeps the list up to date from the
  `thread.updated` events (one for a thread it hasn't seen adds it).
- Opening a thread is `snapshot`; its `ThreadSource` takes the pushed events for that thread, and
  its `resync(seq)` is `events_since`. After the WebSocket reconnects, it takes a fresh `snapshot`
  (which has any text streamed so far) and a new source, which catches up from there with
  `events_since`.
- The user's actions are `command`s: `send`, `interrupt`, `respond` and `set_options`, made by the
  React components.
- A new thread is `create` with the harness and model picked, titled with the first message, then
  a `send` of that message.

## Running chat-node's smoke tests against another server

chat-node's Playwright tests ([chat-node/e2e](chat-node/e2e/chat.spec.ts)) run against any server
that speaks this protocol: set `CHAT_E2E_SERVER` to its command, and `CHAT_E2E_SUPERVISED` to the
command that runs it under its supervisor (`$CHAT_E2E_SERVER supervise` by default), e.g.
`CHAT_E2E_SERVER=../chat-go/chat-go pnpm test:e2e`. The tests start it with this environment:

| Variable | |
| --- | --- |
| `PORT` | The port to listen on. |
| `CHAT_DATA` | A directory of its own for its threads and runs, which the restart tests keep across a restart. |
| `CHAT_FAKE_CLAUDE`, `CHAT_FAKE_CODEX` | A `spec/fixtures/<harness>/<scenario>` directory: offer only that harness, run `spec/tools/fake-cli.mjs` as its binary (with `AGENT_THREADS_FIXTURE` set to the directory), with the model and effort in its `fixture.json`, no MCP server or skill, and `lookup_order` only if the fixture has it. |
| `CHAT_FAKE_STATE` | Where the fake CLI keeps its state (`AGENT_THREADS_FIXTURE_STATE`, a subdirectory per harness), kept across a restart; a fresh one each start when it isn't set. |
| `CHAT_SHIM` | The `agent-threads-shim` binary to run the harnesses under. |

It must print a line starting `chat-<name> on ` (on stdout or stderr) once it's listening, and
again after each restart, and stop on SIGTERM (handling it already when it prints that line).
Supervised, `restart` must start it again with the same environment, `hello` must say
`restart: true`, and SIGTERM to the supervisor must stop the server too: the supervisor passes it
on, and exits once the server has. Its runs needn't stop (they're under the shim): the tests stop
them, from `CHAT_DATA/runs`. The tests run it in a process group of its own, and fail one that
leaves anything in it running 15s after SIGTERM.

## The app's tool

The frontend draws one app tool of its own, `lookup_order`, as an order card, so a server should
define it the same way (`chat-node/server/orders.ts` has the example orders):

- input `{"order_id": string}`;
- its text for the agent, e.g. `Order 42: 3 blue widgets, shipped on 2026-10-30.`;
- and structured output, which the backend puts in the call's `result.structured`:
  `{"order_id", "status": "processing" | "shipped" | "delivered" | "cancelled", "items": [{"name",
  "qty"}], "shipped_on"?, "total"?}` (`shipped_on` a date, `total` a display string like
  `"$36.00"`). Without it the card shows the text.

Everything else (the MCP server, the skill, the permission policy, the shim) is the server's own
business, and the frontend doesn't depend on it.

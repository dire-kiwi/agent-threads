# The chat examples' wire protocol

The SDK has no network layer: each example app brings its own. The chat examples (`chat-node`, and
the Go and Rust ones to come) all use the one described here, so the React frontend in
[chat-node/web](chat-node/web) talks to any of their servers unchanged. It's the app's protocol, not
the SDK's: the SDK's part is only what goes inside it, the [protocol](../spec/PROTOCOL.md)'s
`ThreadEvent`s, `Command`s, `Snapshot`s and `Thread`s, carried as they are.

## What a server serves

| | |
| --- | --- |
| `GET /ws` | The WebSocket. Everything below goes over it, one JSON object per text frame. |
| `GET /*` | The built frontend, `chat-node/web/dist` (`index.html` for any path that isn't a file). |
| `PORT` | The port to listen on, `3001` by default, on 127.0.0.1. |

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
| `hello` | | `{harnesses, restart}`: the harnesses threads can run on, as `[{name, label, model, models}]` (`model` the default, `models` suggestions; the user may type another), and whether `restart` is offered. |
| `list` | | `Thread[]`, newest first. |
| `create` | `{harness, model?, title?}` | The new `Thread`. Its first `thread.updated` is pushed too. |
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

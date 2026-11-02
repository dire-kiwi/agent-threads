# Bring your own network

agent-threads has no network layer. A backend (Node, Go or Rust) runs the threads, **sends events**
and **takes commands**, all plain JSON objects ([spec/PROTOCOL.md](../spec/PROTOCOL.md)), and the
app carries them between the backend and its frontend over whatever it already has: a WebSocket,
SSE and POST, Electron or Tauri IPC, a message queue. This guide covers what a transport has to
carry, the rules that make reconnecting work, and four transports in full.

## The seam

A transport carries four things. Every backend has all four:

| | Node | Go | Rust |
| --- | --- | --- | --- |
| **Events out**: every thread's events, deltas included | `sdk.subscribe(fn)` | `sdk.Subscribe(fn)`, or `sdk.Events(ctx)` | `sdk.subscribe()` (a tokio `broadcast::Receiver`) |
| **Commands in**: `send`, `interrupt`, `respond`, `set_options`, `rewind`, `new_session`, `compact` | `sdk.handle(command)` | `sdk.HandleJSON(ctx, data)`, or `sdk.Handle(ctx, command)` | `sdk.handle_json(value)`, or `sdk.handle(command)` |
| **A snapshot**, for a client that's just connected | `sdk.snapshot(id)` | `sdk.Snapshot(ctx, id)` | `sdk.snapshot(&id)` |
| **Events after a `seq`**, for a client catching up | `sdk.eventsSince(id, seq)` | `sdk.EventsSince(ctx, id, seq, 0)` | `sdk.events_since(&id, seq, None)` |

Creating, listing and deleting threads (`create`, `list`, `delete`) aren't commands: they're the
app's own API, which it offers its clients however it likes (the chat examples have `create` and
`list` methods next to `command`; see [examples/PROTOCOL.md](../examples/PROTOCOL.md)).

On the frontend, the React package takes the other end of the same four things: a `ThreadSource`
(`snapshot`, `subscribe`, `resync`) and an `onCommand` ([its README](../ts/packages/react/README.md)).

```tsx
const source: ThreadSource = {
  snapshot,                          // from the backend's snapshot(id)
  subscribe: (fn) => onEvent(fn),    // the thread's events from the transport; returns how to stop
  resync: (seq) => eventsSince(seq), // the backend's eventsSince(id, seq), or a fresh snapshot
};
<Thread source={source} onCommand={(command) => sendCommand(command)} />
```

## The rules

**Send events as they are.** An event is already the JSON the client wants: serialize it and send
it. Don't reorder a thread's events: the backend calls its subscribers in order, and the client
applies them in order.

**Saved events are numbered; deltas aren't.** Every event but `delta` is saved, and a thread's saved
events have `seq` 1, 2, 3... with no gaps. A `delta` (streamed text) isn't saved and carries the
`seq` of the last saved event before it. So a transport may drop deltas when it has to (a slow
client, a lossy link): the message's final text comes in a saved `item.updated`, and puts the text
right. It mustn't drop saved events without the client noticing, and it can't: the next saved
event's `seq` skips ahead.

**Subscribe, then snapshot.** A client that connects takes a snapshot of the thread and applies
the events after it. To miss nothing in between, subscribe to the backend's events *before* taking
the snapshot, and send the client the snapshot first, then the events. Events the snapshot already
has are harmless: a saved event at or below the snapshot's `seq` changes nothing, and a delta whose
text the snapshot already has is skipped by its `offset` (the protocol's
[applying rules](../spec/PROTOCOL.md#applying-events)). The live snapshot includes the text
streamed so far, so a client that connects in the middle of a message sees it.

**A gap is a resync.** A client keeps its state's `seq`. When a saved event's `seq` is more than
one past it (`isGap` / `IsGap` / `is_gap`), events were missed: it asks for `eventsSince(seq)` (or a
fresh snapshot) instead of applying the event. The React package's `ThreadStore` does this through
`source.resync`, holding events that come meanwhile, and also calls `resync` each time it connects,
for what was sent while it wasn't listening. A transport that loses events, or a client that was
away, only needs `resync` to be right.

**Reconnecting is connecting again.** After the connection drops, take a fresh snapshot (it has
the text streamed so far) and start a new `ThreadSource` from it, or keep the old state and
`eventsSince` its `seq`. Either works; a fresh snapshot is simpler. Note that a gap is only seen
when the *next* saved event comes, so after a reconnect, catch up straight away rather than waiting
for one: the React store does, since a new source connects.

**Commands come back as errors, not events.** `handle` checks a command against the protocol's
schema and throws (Node: `CommandError`; Go: `*CommandError`; Rust: `Error::Command`) for one it
can't carry out: an unknown thread, a malformed command, a closed backend. Send that back to the
client as the reply to its command; the React components show a rejected `onCommand` as the
failing component's error. `handle` resolves once the thread has taken the command, not when the
turn ends: what the command does comes back as events.

**Authorize at the seam.** A backend serves every thread to whoever holds it. The transport is
where the app decides who's who: authenticate the connection, send a client only the events of
threads it may see (filter by `event.thread_id`), and check a command's `thread_id` before
`handle`. A permission request answered with `respond` allows the agent to do something, so a
client that can send commands to a thread can let its agent act. A local app listening on
127.0.0.1 still has to: any web page the user has open can open a WebSocket to it (see
[examples/PROTOCOL.md](../examples/PROTOCOL.md#what-a-server-serves) for the checks the examples
make, which are the least a real app does).

**Don't block the subscriber.** Node calls subscribers synchronously, as events happen, on the
event loop everything else runs on. Go calls `Subscribe`'s functions on one goroutine of the SDK's
own, one event at a time: a function that blocks holds up every subscriber's events (they queue up
in memory meanwhile), though not the threads. Each `Events(ctx)` channel has a queue of its own, so
a slow reader only grows that one. Rust's `subscribe()` is a broadcast channel holding `Options::event_capacity` (4096)
events: a receiver that falls further behind gets `RecvError::Lagged`, misses some, and should carry
on, since its clients will see the gap and resync. In each case, hand events to a per-client queue
or write and move on.

**Shut down cleanly.** On shutdown, close the transport, then `close()` the backend (`Close` in Go,
`close(false)` in Rust): it stops the harness processes, or with the shim leaves them running for
the next start (see [shim.md](shim.md)), and saves everything. Then close the store, which is the
app's.

## Without React

The reducer the React package uses is in every language: fold a snapshot and its events into the
thread's state with `applyEvent` (`@dire-kiwi/agent-threads-protocol`), `protocol.ApplyEvent` (Go) or
`agent_threads::reducer::apply_event` (Rust), and check for gaps with `isGap`. A CLI client, a bot
or a test in any of the three languages can follow a thread the same way:

```ts
import { applyEvent, isGap, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";

let state: Snapshot = await fetchSnapshot(threadId);
async function onEvent(event: ThreadEvent) {
  if (isGap(state, event)) {
    for (const e of await fetchEventsSince(threadId, state.seq)) state = applyEvent(state, e);
  }
  state = applyEvent(state, event); // events it already has change nothing
  render(state);
}
```

## WebSocket

One socket per client, with the client's requests and the server's pushed events on it. The three
chat examples do exactly this, in each language, and are the fullest reference:
[chat-node/server/main.ts](../examples/chat-node/server/main.ts),
[chat-go/main.go](../examples/chat-go/main.go) and [chat-rust/src/main.rs](../examples/chat-rust/src/main.rs),
all speaking [examples/PROTOCOL.md](../examples/PROTOCOL.md) to one React frontend. Its core, in
Node with `ws`:

```ts
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentThreads, CommandError, SqliteStore } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({ store: new SqliteStore("threads.db") });
const http = createServer();
// Authenticate here: verifyClient sees the upgrade request (its cookies, Origin and Host).
const wss = new WebSocketServer({ server: http, path: "/ws" });

// Events out, to every client (a real app sends each client only its threads' events).
const clients = new Set<WebSocket>();
sdk.subscribe((event) => {
  const frame = JSON.stringify({ type: "event", event });
  for (const ws of clients) ws.send(frame);
});

// Requests in: {id, method, params}, each answered with {id, result} or {id, error}.
type Request = { id: number | string; method: string; params?: { [k: string]: any } };
const methods: { [name: string]: (p: { [k: string]: any }) => unknown } = {
  list: () => sdk.list(),
  create: (p) => sdk.create({ harness: p.harness, model: p.model }),
  snapshot: (p) => sdk.snapshot(p.thread_id),
  events_since: (p) => sdk.eventsSince(p.thread_id, p.seq),
  command: async (p) => void (await sdk.handle(p.command)),
};

/** Whether a frame is a request. Anything else (`null`, an array, a number) is ignored. */
function isRequest(r: unknown): r is Request {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  const { id, method, params } = r as Request;
  return (typeof id === "number" || typeof id === "string") && typeof method === "string" && (params === undefined || (typeof params === "object" && params !== null));
}

wss.on("connection", (ws) => {
  ws.on("error", () => ws.terminate()); // a frame the socket can't take ends this socket only
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (data) => {
    // Nothing a client sends may throw out of here: an unhandled rejection would stop the server,
    // and every thread with it.
    try {
      let req: unknown;
      try {
        req = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isRequest(req)) return;
      const { id, method: name, params = {} } = req;
      const reply = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ...msg }));
      const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
      if (!method) return reply({ error: `there's no method ${JSON.stringify(name)}` });
      try {
        reply({ result: (await method(params)) ?? null });
      } catch (e) {
        if (!(e instanceof CommandError)) console.error(e); // a CommandError is the client's mistake
        reply({ error: e instanceof Error ? e.message : String(e) });
      }
    } catch (e) {
      console.error(e);
    }
  });
});
http.listen(3001, "127.0.0.1");
```

Each client subscribes to the server's pushed events once the socket opens, so here "subscribe,
then snapshot" holds as long as the client asks for the snapshot after connecting. The browser's
half is a small request/response wrapper around `WebSocket` that reconnects
([chat-node/web/src/connection.ts](../examples/chat-node/web/src/connection.ts)), and a
`ThreadSource` per snapshot:

```tsx
const source: ThreadSource = {
  snapshot, // await conn.call("snapshot", { thread_id: id }), taken again after each reconnect
  subscribe: (fn) => conn.onEvent((e) => e.thread_id === id && fn(e)),
  resync: (seq) => conn.call<ThreadEvent[]>("events_since", { thread_id: id, seq }),
};
<Thread source={source} onCommand={(command) => conn.call("command", { command })} />
```

## Server-sent events and POST

Events go down an SSE stream per thread, and commands go up as POSTs. This fits an app that
already serves HTTP, through proxies that don't pass WebSockets. The stream starts with the
thread's snapshot, so each time `EventSource` reconnects by itself the client starts again from a
fresh one.

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { AgentThreads, CommandError, SqliteStore, type ThreadEvent } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({ store: new SqliteStore("threads.db") });

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  // Authenticate the request, and check its user may see the thread, here.
  const url = new URL(req.url ?? "/", "http://localhost");
  const [, threadId, what] = url.pathname.match(/^\/threads\/([\w-]+)\/(stream|events|commands)$/) ?? [];
  if (!threadId) return json(res, 404, { error: "not found" });
  try {
    if (what === "stream") return await stream(threadId, req, res);
    if (what === "events") return json(res, 200, await sdk.eventsSince(threadId, Number(url.searchParams.get("after") ?? 0)));
    if (req.method !== "POST") return json(res, 405, { error: "POST a command" });
    const command = JSON.parse(await text(req));
    if (command?.thread_id !== threadId) return json(res, 400, { error: "the command is for another thread" });
    await sdk.handle(command);
    res.writeHead(204).end();
  } catch (e) {
    if (res.headersSent) return res.end();
    json(res, e instanceof CommandError || e instanceof SyntaxError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(3001, "127.0.0.1");

/** The thread's snapshot, then its events as they happen. */
async function stream(threadId: string, req: IncomingMessage, res: ServerResponse) {
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Subscribe first, holding events until the snapshot is out, so none are missed in between.
  let held: ThreadEvent[] | null = [];
  const off = sdk.subscribe((e) => {
    if (e.thread_id !== threadId) return;
    if (held) held.push(e);
    else send("event", e);
  });
  req.on("close", off);
  let snapshot;
  try {
    snapshot = await sdk.snapshot(threadId);
  } catch (e) {
    off();
    throw e; // a CommandError for an unknown thread: a 400
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  send("snapshot", snapshot);
  for (const e of held) send("event", e);
  held = null;
}
```

In the browser, each `snapshot` on the stream makes a new source:

```tsx
import { Thread, type Command, type ThreadEvent, type ThreadSource } from "@dire-kiwi/agent-threads-react";
import { useEffect, useState } from "react";

function useSseSource(threadId: string): ThreadSource | null {
  const [source, setSource] = useState<ThreadSource | null>(null);
  useEffect(() => {
    const es = new EventSource(`/threads/${threadId}/stream`);
    const listeners = new Set<(e: ThreadEvent) => void>();
    es.addEventListener("event", (m) => {
      const event = JSON.parse(m.data);
      for (const fn of listeners) fn(event);
    });
    es.addEventListener("snapshot", (m) =>
      setSource({
        snapshot: JSON.parse(m.data),
        subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
        resync: (seq) => fetch(`/threads/${threadId}/events?after=${seq}`).then((r) => r.json()),
      }),
    );
    return () => es.close();
  }, [threadId]);
  return source;
}

async function onCommand(command: Command) {
  const r = await fetch(`/threads/${command.thread_id}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error((await r.json()).error);
}

function ThreadPage({ threadId }: { threadId: string }) {
  const source = useSseSource(threadId);
  return source ? <Thread source={source} onCommand={onCommand} /> : <p>Loading…</p>;
}
```

Events that arrive between the `snapshot` and React subscribing have no listener yet, and that's
fine: the store calls `resync(snapshot.seq)` as it connects. With many threads open, one stream of
every thread the user may see (filtered on the server) saves a connection per thread; browsers
allow only six HTTP/1.1 connections per host.

## Electron IPC

The Node backend runs in Electron's main process, and the renderer reaches it through a preload
script. Events go to the windows with `webContents.send`; everything else is `ipcMain.handle`.

```ts
// main.ts
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { AgentThreads, SqliteStore, type CreateOptions } from "@dire-kiwi/agent-threads-node";

let sdk: AgentThreads;

app.whenReady().then(() => {
  sdk = new AgentThreads({ store: new SqliteStore(join(app.getPath("userData"), "threads.db")) });
  sdk.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("at:event", event);
  });
  ipcMain.handle("at:list", () => sdk.list());
  ipcMain.handle("at:create", (_e, o: Pick<CreateOptions, "harness" | "model" | "title">) => sdk.create({ harness: o.harness, model: o.model, title: o.title }));
  ipcMain.handle("at:snapshot", (_e, threadId: string) => sdk.snapshot(threadId));
  ipcMain.handle("at:events-since", (_e, threadId: string, seq: number) => sdk.eventsSince(threadId, seq));
  ipcMain.handle("at:command", (_e, command) => sdk.handle(command));
  new BrowserWindow({ webPreferences: { preload: join(import.meta.dirname, "preload.js") } }).loadFile("index.html");
});

// Save everything (and stop the harnesses) before quitting.
let quitting: Promise<void> | undefined;
let closed = false;
app.on("before-quit", (e) => {
  if (closed) return;
  e.preventDefault();
  quitting ??= closeAndQuit();
});

async function closeAndQuit() {
  // close() rejects while the store is failing; it keeps the events, and calling it again retries.
  for (let attempt = 1; ; attempt++) {
    try {
      await sdk.close();
      break;
    } catch (e) {
      console.error(`couldn't save the threads (attempt ${attempt}):`, e);
      if (attempt === 3) break; // give up: what isn't saved yet is lost
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await sdk.store.close?.().catch((e: unknown) => console.error(e));
  closed = true;
  app.quit();
}
```

```ts
// preload.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("agentThreads", {
  list: () => ipcRenderer.invoke("at:list"),
  create: (options: object) => ipcRenderer.invoke("at:create", options),
  snapshot: (threadId: string) => ipcRenderer.invoke("at:snapshot", threadId),
  eventsSince: (threadId: string, seq: number) => ipcRenderer.invoke("at:events-since", threadId, seq),
  command: (command: object) => ipcRenderer.invoke("at:command", command),
  onEvent: (fn: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, event: unknown) => fn(event);
    ipcRenderer.on("at:event", listener);
    return () => void ipcRenderer.removeListener("at:event", listener);
  },
});
```

```tsx
// renderer
const at = (window as any).agentThreads;
const snapshot = await at.snapshot(threadId);
const source: ThreadSource = {
  snapshot,
  subscribe: (fn) => at.onEvent((e: ThreadEvent) => e.thread_id === threadId && fn(e)),
  resync: (seq) => at.eventsSince(threadId, seq),
};
<Thread source={source} onCommand={(command) => at.command(command)} />
```

IPC doesn't drop messages or disconnect, but a window that reloads starts again from a snapshot,
as any client does. A `CommandError` reaches the renderer as a rejected `invoke`, whose message
Electron prefixes with "Error invoking remote method". Only expose what the renderer needs: it runs
web content, and `at:command` lets it answer permission requests.

## Tauri

The Rust backend runs in the Tauri app, as managed state. Events go to the webview with `emit`, and
the rest are commands.

```rust
use std::sync::Arc;

use agent_threads::{AgentThreads, Options, Snapshot, SqliteStore, ThreadEvent};
use tauri::{Emitter, Manager, RunEvent, State};
use tokio::sync::broadcast::error::RecvError;

#[tauri::command]
async fn at_snapshot(sdk: State<'_, AgentThreads>, thread_id: String) -> Result<Snapshot, String> {
    sdk.snapshot(&thread_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn at_events_since(sdk: State<'_, AgentThreads>, thread_id: String, seq: u64) -> Result<Vec<ThreadEvent>, String> {
    sdk.events_since(&thread_id, seq, None).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn at_command(sdk: State<'_, AgentThreads>, command: serde_json::Value) -> Result<(), String> {
    sdk.handle_json(command).await.map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // app_data_dir() is only a path: on the first launch, it doesn't exist yet.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let sdk = AgentThreads::new(Options {
                store: Some(Arc::new(SqliteStore::open(dir.join("threads.db"))?)),
                ..Default::default()
            });
            // Events out: every thread's, to the webview.
            let mut events = sdk.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("at:event", &event);
                        }
                        Err(RecvError::Lagged(_)) => continue, // the frontend sees the gap in seq and resyncs
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            app.manage(sdk);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![at_snapshot, at_events_since, at_command])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Save everything, and stop the harnesses (or leave shim runs going).
                let sdk = app.state::<AgentThreads>().inner().clone();
                let _ = tauri::async_runtime::block_on(sdk.close(false));
            }
        });
}
```

```tsx
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// One listener for the app, handing events to the open threads' sources.
const listeners = new Set<(e: ThreadEvent) => void>();
void listen<ThreadEvent>("at:event", (m) => {
  for (const fn of listeners) fn(m.payload);
});

const snapshot = await invoke<Snapshot>("at_snapshot", { threadId });
const source: ThreadSource = {
  snapshot,
  subscribe: (fn) => {
    const own = (e: ThreadEvent) => e.thread_id === threadId && fn(e);
    listeners.add(own);
    return () => void listeners.delete(own);
  },
  resync: (seq) => invoke<ThreadEvent[]>("at_events_since", { threadId, seq }),
};
<Thread source={source} onCommand={(command) => invoke("at_command", { command })} />
```

Tauri passes the commands' arguments in camelCase (`threadId`) to the Rust functions' snake_case
parameters. `listen` resolves with its unlisten function asynchronously, which is why the example
listens once and fans out, rather than listening in each `subscribe`. Add the commands to the app's
capabilities, and keep the backend's own commands (create, list) next to them.

## Further

- Go and Rust have the same seam, with their idioms (a `context.Context`, a broadcast channel): see
  [go/README.md](../go/README.md) and [rust/agent-threads/README.md](../rust/agent-threads/README.md),
  and the chat examples.
- An agent's runs can outlive the backend's process with the shim, so the transport restarting
  doesn't have to stop them: [shim.md](shim.md).
- What the agent can do (tools, MCP servers, skills, permissions) is set on the backend, not
  carried by the transport: [tools.md](tools.md).

// The chat app: a list of threads, a form to start one on Claude Code or Codex, and the open
// thread, drawn by @dire-kiwi/agent-threads-react. Everything goes over the Connection.

import {
  Thread,
  ThreadProvider,
  useSetOptions,
  useThreadState,
  type Command,
  type ItemPage,
  type PermissionMode,
  type Snapshot,
  type ThreadEvent,
  type ThreadInfo,
  type ThreadSource,
} from "@dire-kiwi/agent-threads-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Connection } from "./connection.ts";
import { tools } from "./OrderCard.tsx";

const conn = new Connection();

interface HarnessInfo {
  name: string;
  label: string;
  model: string;
  models: string[];
}
interface Hello {
  harnesses: HarnessInfo[];
  restart: boolean;
}

/** The commands the components make, carried to the server. */
const onCommand = (command: Command) => conn.call("command", { command });

const EXAMPLES = [
  "What's in order 42, and has it shipped?",
  "Where's the parcel for order 1001 now?",
  "Can you check order 1002 for me?",
  "Write a file called hello.txt that says hi.",
];

export function App() {
  const status = useSyncExternalStore(conn.subscribe, () => conn.status);
  const generation = useSyncExternalStore(conn.subscribe, () => conn.generation);
  const [hello, setHello] = useState<Hello | null>(null);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [selected, select] = useHash();

  // On each (re)connection: what the server offers, and the threads.
  useEffect(() => {
    if (status !== "open") return;
    conn.call<Hello>("hello").then(setHello, console.error);
    conn.call<ThreadInfo[]>("list").then(setThreads, console.error);
  }, [status, generation]);

  // Every thread.updated carries the whole thread: keep the list up to date with it.
  useEffect(
    () =>
      conn.onEvent((e: ThreadEvent) => {
        if (e.type !== "thread.updated") return;
        setThreads((list) => (list.some((t) => t.id === e.thread.id) ? list.map((t) => (t.id === e.thread.id ? e.thread : t)) : [e.thread, ...list]));
      }),
    [],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">agent-threads chat</div>
        <button className={`new-thread ${!selected ? "active" : ""}`} onClick={() => select(null)}>
          + New thread
        </button>
        <nav className="thread-list" aria-label="Threads">
          {threads.map((t) => (
            <button key={t.id} className={`thread-link ${t.id === selected ? "active" : ""}`} onClick={() => select(t.id)} title={t.title}>
              <span className={`status-dot status-${t.status}`} aria-label={t.status} />
              <span className="thread-link-title">{t.title || "Untitled"}</span>
              <span className={`harness-tag harness-${t.harness}`}>{t.harness}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`conn conn-${status}`} data-testid="connection">
            {status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
          {hello?.restart && (
            <button className="restart" title="Restart the server: its runs are under the shim, so running turns carry on" disabled={status !== "open"} onClick={() => void conn.call("restart").catch(() => {})}>
              Restart server
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        {selected ? (
          <ThreadPane key={selected} id={selected} status={status} generation={generation} />
        ) : hello ? (
          <NewThread hello={hello} onCreated={select} />
        ) : (
          <div className="placeholder">Connecting…</div>
        )}
      </main>
    </div>
  );
}

/**
 * How many items a thread starts with (the latest), and loads at a time as it's scrolled back:
 * ?page=n in the URL to try it with a few.
 */
const PAGE = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 100);

/** The open thread, from a snapshot taken on each connection, and the events after it. */
function ThreadPane({ id, status, generation }: { id: string; status: string; generation: number }) {
  const [snapshot, setSnapshot] = useState<{ snap: Snapshot; generation: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (status !== "open") return;
    let live = true;
    // Asked again on each connection: an error from the last one (it dropped while the snapshot
    // was on its way, say) is gone until this one says otherwise.
    setError(null);
    conn.call<Snapshot>("snapshot", { thread_id: id, limit: PAGE }).then(
      (snap) => {
        if (!live) return;
        setError(null);
        setSnapshot({ snap, generation });
      },
      (e) => live && setError(String(e.message ?? e)),
    );
    return () => void (live = false);
  }, [id, status, generation]);

  // A new source for each snapshot (each connection): it starts from the snapshot (a window of the
  // latest items), takes the thread's pushed events, fetches what it missed (a gap in seq, or what
  // came between the snapshot and subscribing) with events_since, and earlier items with
  // items_before.
  const source = useMemo<ThreadSource | null>(
    () =>
      snapshot && {
        snapshot: snapshot.snap,
        subscribe: (fn) => conn.onEvent((e) => e.thread_id === id && fn(e)),
        resync: (seq) => conn.call<ThreadEvent[]>("events_since", { thread_id: id, seq }),
        loadEarlier: (before) => conn.call<ItemPage>("items_before", { thread_id: id, before, limit: PAGE }),
      },
    [snapshot, id],
  );
  if (error) return <div className="placeholder error">{error}</div>;
  if (!source) return <div className="placeholder">Loading…</div>;
  return (
    <ThreadProvider source={source} onCommand={onCommand} tools={tools}>
      <div className="thread-pane">
        <ThreadHeader />
        {status !== "open" && <div className="banner">The connection to the server dropped. Reconnecting…</div>}
        <Thread className="thread" />
      </div>
    </ThreadProvider>
  );
}

/** The permission modes, as the header's picker names them. */
const MODES: { mode: PermissionMode; label: string }[] = [
  { mode: "default", label: "ask" },
  { mode: "accept_edits", label: "accept edits" },
  { mode: "plan", label: "plan" },
  { mode: "bypass", label: "bypass" },
];

/**
 * The thread's title, harness, model and permission mode. A new model or mode goes to the running
 * agent straight away where the harness allows, and otherwise from the next turn.
 */
function ThreadHeader() {
  const thread = useThreadState((s) => s.snapshot.thread);
  const setOptions = useSetOptions();
  const [model, setModel] = useState(thread.model ?? "");
  useEffect(() => setModel(thread.model ?? ""), [thread.model]);
  return (
    <header className="thread-header">
      <h1 title={thread.title}>{thread.title || "Untitled"}</h1>
      <span className={`harness-tag harness-${thread.harness}`}>{thread.harness}</span>
      <form
        className="model-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (model.trim() && model.trim() !== thread.model) void setOptions({ model: model.trim() });
        }}
      >
        <label>
          model <input value={model} onChange={(e) => setModel(e.target.value)} size={14} aria-label="Model" />
        </label>
      </form>
      <label className="model-form">
        mode{" "}
        <select value={thread.permission_mode ?? "default"} aria-label="Permission mode" onChange={(e) => void setOptions({ permission_mode: e.target.value as PermissionMode })}>
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}

/** Starts a thread: create it on the harness picked, then send it the first message. */
function NewThread({ hello, onCreated }: { hello: Hello; onCreated: (id: string) => void }) {
  const [harness, setHarness] = useState(hello.harnesses[0]?.name ?? "");
  const info = hello.harnesses.find((h) => h.name === harness);
  const [model, setModel] = useState(info?.model ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setModel(info?.model ?? ""), [info]);

  const start = useCallback(async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await conn.call<ThreadInfo>("create", { harness, model, title: message.split("\n")[0] });
      await onCommand({ type: "send", thread_id: thread.id, text: message });
      onCreated(thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [text, busy, harness, model, onCreated]);

  return (
    <form
      className="new-form at-root"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h1>Start a thread</h1>
      <p className="hint">
        Widget Co.'s support agent can look up orders (an app tool, drawn as a card), track parcels (an external MCP server, which asks you
        first) and follows an order-support skill. Anything that isn't a read asks you before it runs.
      </p>
      <div className="harness-picker" role="radiogroup" aria-label="Harness">
        {hello.harnesses.map((h) => (
          <label key={h.name} className={`harness-option ${h.name === harness ? "active" : ""}`}>
            <input type="radio" name="harness" value={h.name} checked={h.name === harness} onChange={() => setHarness(h.name)} />
            {h.label}
          </label>
        ))}
        <label className="model-field">
          model
          <input list="models" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" size={14} />
          <datalist id="models">
            {info?.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
      </div>
      <textarea
        className="new-text"
        rows={4}
        placeholder="Ask about an order…"
        aria-label="First message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void start();
          }
        }}
      />
      <div className="examples">
        {EXAMPLES.map((x) => (
          <button type="button" key={x} className="example" onClick={() => setText(x)}>
            {x}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <button type="submit" className="start" disabled={!text.trim() || busy}>
        {busy ? "Starting…" : "Start"}
      </button>
    </form>
  );
}

/** The open thread's id, kept in the URL's hash so a reload keeps it. */
function useHash(): [string | null, (id: string | null) => void] {
  const read = () => decodeURIComponent(location.hash.slice(1)) || null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return [id, (next) => (location.hash = next ? encodeURIComponent(next) : "")];
}

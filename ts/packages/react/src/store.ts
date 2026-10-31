// A thread's state on the client: the snapshot it started from with the events since applied by
// applyEvent, what's being streamed, and the view the components draw from. It catches up when
// events go missing, by asking the source for a resync.

import { applyEvent, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { buildView, type ThreadView } from "./view.js";

/**
 * Where a thread's events come from: the app wires it to its own transport (a WebSocket, SSE,
 * Electron IPC...). Keep the same object for as long as it's the same connection: a new one starts
 * again from its snapshot.
 */
export interface ThreadSource {
  /** The state to start from: the backend's snapshot of the thread (or `initialState(thread)`). */
  snapshot: Snapshot;
  /** Calls `listener` with each of the thread's events, deltas included. Returns how to stop. */
  subscribe(listener: (event: ThreadEvent) => void): () => void;
  /**
   * Called when events were missed: a saved event came whose seq is more than one past the
   * state's. Resolve with the events after `seq` or a fresh snapshot (backends offer both), or
   * deliver the missing events through `subscribe` and return nothing. Events that come meanwhile
   * are held, and applied once the gap is filled. It's also called when the store connects again
   * (e.g. React hid the thread for a while), for the events sent while it wasn't listening.
   * Without it, a gap is ignored and the event applied anyway.
   */
  resync?(seq: number): Promise<Snapshot | ThreadEvent[] | void> | void;
}

export interface ThreadState {
  /** The thread's state: applying the events so far to the source's snapshot. */
  snapshot: Snapshot;
  /** The assistant messages and reasoning that deltas are streaming into, until their final text comes. */
  streaming: ReadonlySet<string>;
  /** Waiting for missed events: a resync under way, or events held until the ones before them come (see ThreadSource.resync). */
  resyncing: boolean;
  /** The items arranged for drawing (see buildView). */
  view: ThreadView;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * A thread's state, kept up to date from its source once `connect`ed, for React (or anything) to
 * subscribe to. Each change makes a new state, keeping the parts it didn't change.
 */
export class ThreadStore {
  private state: ThreadState;
  private listeners = new Set<() => void>();
  /** Saved events that came after a gap, by seq, until the events before them do. */
  private held = new Map<number, ThreadEvent>();
  /** Counts resyncs, so one that's been overtaken (by a newer one, or the store disconnecting) is ignored. */
  private attempt = 0;
  /**
   * The resync under way: "answer" while its promise is awaited, "events" while the source sends
   * the held events' missing ones itself, "none" when there's none (it's done, or it failed).
   */
  private asked: "none" | "answer" | "events" = "none";
  private connected = false;
  private connections = 0;

  constructor(readonly source: ThreadSource) {
    const snapshot = source.snapshot;
    this.state = { snapshot, streaming: NO_IDS, resyncing: false, view: buildView(snapshot.items, snapshot.requests) };
  }

  getState = (): ThreadState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Starts taking the source's events. Returns how to stop. */
  connect(): () => void {
    this.connected = true;
    const again = this.connections++ > 0;
    const off = this.source.subscribe((event) => this.receive(event));
    // Connected again (e.g. React hid the thread, or ran the effect again): events may have been
    // sent while it wasn't listening, and a resync under way then was dropped. Ask from where the
    // state is now (after any the subscription replayed).
    if (this.connected && this.source.resync && (again || this.held.size)) this.gap();
    return () => {
      this.connected = false;
      this.attempt++;
      this.asked = "none";
      off();
    };
  }

  /** Takes one of the thread's events (as the source's subscription does). */
  receive(event: ThreadEvent): void {
    const s = this.state.snapshot;
    if (event.thread_id !== s.thread.id) return;
    if (event.type === "delta") {
      // One from after a saved event that hasn't come: that's missed too. Deltas aren't saved, so
      // a resync can't give them back, and its snapshot may have them in already: they're dropped
      // until it's done, and the item's final text puts it right.
      // One from before the state's seq is stale (the snapshot has it in), and the reducer ignores it.
      if (this.state.resyncing || event.seq < s.seq) return;
      if (event.seq > s.seq && this.source.resync) return this.gap();
      return this.update(this.apply(this.state, event));
    }
    if (event.seq <= s.seq) return;
    if (event.seq > s.seq + 1) {
      if (!this.source.resync) return this.update(this.apply(this.state, event));
      this.held.set(event.seq, event);
      if (this.asked === "none") this.gap();
      return;
    }
    this.update(this.drain(this.apply(this.state, event)));
    // It filled only part of the gap, and the last resync failed: try again.
    if (this.held.size && this.asked === "none" && this.connected) this.gap();
  }

  /** Events were missed: ask the source for them. */
  private gap() {
    const n = ++this.attempt;
    const from = this.state.snapshot.seq;
    this.asked = "events";
    if (!this.state.resyncing) this.update({ ...this.state, resyncing: true });
    let result;
    try {
      result = this.source.resync?.(from);
    } catch (e) {
      return this.failed(n, e);
    }
    if (n !== this.attempt) return;
    if (!result) {
      // Nothing back: the source sends the missing events itself, and draining the held ones ends
      // it. With none held, there's nothing to wait for.
      if (!this.held.size) this.update(this.drain(this.state));
      return;
    }
    this.asked = "answer";
    result.then(
      (r) => n === this.attempt && this.caughtUp(r ?? undefined),
      (e) => this.failed(n, e),
    );
  }

  private caughtUp(r: Snapshot | ThreadEvent[] | undefined) {
    this.asked = "none";
    const before = this.state.snapshot.seq;
    let next = this.state;
    if (Array.isArray(r)) {
      for (const event of r)
        if (event.type !== "delta" && event.thread_id === next.snapshot.thread.id && event.seq > before) this.held.set(event.seq, event);
    } else if (r && r.thread.id === next.snapshot.thread.id && r.seq >= next.snapshot.seq) {
      next = { ...next, snapshot: r, streaming: NO_IDS, view: buildView(r.items, r.requests, next.view) };
    }
    next = this.drain(next);
    if (next.resyncing && next.snapshot.seq === before) {
      // It didn't bring anything new: rather than wait for ever, go on from the next event held.
      console.warn(`agent-threads: resync from seq ${before} brought nothing new; applying the events after the gap anyway`);
      next = this.drain(next, true);
    }
    this.update(next);
    if (next.resyncing && this.connected) this.gap();
  }

  private failed(n: number, e: unknown) {
    if (n !== this.attempt) return;
    console.error("agent-threads: resync failed", e);
    // The next saved event to come tries again.
    this.asked = "none";
    this.update(this.drain(this.state));
  }

  /** `state` with the held events that follow on from it applied; with `force`, past any gap. */
  private drain(state: ThreadState, force = false): ThreadState {
    for (const seq of [...this.held.keys()]) if (seq <= state.snapshot.seq) this.held.delete(seq);
    while (this.held.size) {
      let next = this.held.get(state.snapshot.seq + 1);
      if (!next && force) next = this.held.get(Math.min(...this.held.keys()));
      if (!next) break;
      this.held.delete(next.seq);
      state = this.apply(state, next);
    }
    if (!this.held.size && this.asked === "events") this.asked = "none";
    const resyncing = this.asked === "answer" || this.held.size > 0;
    return resyncing === state.resyncing ? state : { ...state, resyncing };
  }

  /** `state` with `event` applied: the snapshot, what's streaming, and the view. */
  private apply(state: ThreadState, event: ThreadEvent): ThreadState {
    const snapshot = applyEvent(state.snapshot, event);
    const streaming = streamingAfter(state.streaming, event, snapshot);
    if (snapshot === state.snapshot && streaming === state.streaming) return state;
    const view =
      snapshot.items === state.snapshot.items && snapshot.requests === state.snapshot.requests
        ? state.view
        : buildView(snapshot.items, snapshot.requests, state.view);
    return { ...state, snapshot, streaming, view };
  }

  private update(next: ThreadState) {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}

/** What's streaming after `event`: a delta's item is, until an event gives it its final text. */
function streamingAfter(streaming: ReadonlySet<string>, event: ThreadEvent, snapshot: Snapshot): ReadonlySet<string> {
  switch (event.type) {
    case "delta":
      if (streaming.has(event.item_id) || !snapshot.items.some((i) => i.id === event.item_id)) return streaming;
      return new Set(streaming).add(event.item_id);
    case "item.updated":
      return "text" in event.patch ? without(streaming, event.item_id) : streaming;
    case "item.added":
      return without(streaming, event.item.id);
    case "turn.completed":
      return streaming.size ? NO_IDS : streaming;
    default:
      return streaming;
  }
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

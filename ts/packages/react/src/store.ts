// A thread's state on the client: the snapshot it started from with the events since applied by
// applyEvent, what's being streamed, and the view the components draw from. It catches up when
// events go missing, by asking the source for a resync.

import { applyEvent, withPage, type ItemPage, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
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
   * are held, and applied once the gap is filled. It's also called each time the store connects
   * (each mount, twice in StrictMode), for the events sent while it wasn't listening: since the
   * snapshot was taken, or since it last disconnected.
   * Without it, a gap is ignored and the event applied anyway.
   */
  resync?(seq: number): Promise<Snapshot | ThreadEvent[] | void> | void;
  /**
   * For a snapshot that's a window of the thread (the backend's snapshot taken with a limit):
   * resolves with the page of items before index `before` (the backend's itemsBefore, with as many
   * as the app likes to load at a time). Without it, a window's earlier items aren't loaded.
   */
  loadEarlier?(before: number): Promise<ItemPage>;
}

export interface LoadEarlierOptions {
  /** Load pages until this item (a subagent's call, say) and everything after it is in. */
  to?: string;
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
  /** Earlier items are being loaded (see ThreadStore.loadEarlier). */
  loadingEarlier: boolean;
  /** Why loading earlier items last failed, until it's tried again. */
  earlierError: string | null;
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
  /** The page of earlier items being loaded, if one is. */
  private paging: Promise<void> | null = null;
  /** The saved events applied while a page loads, to apply to its items too (see loadEarlier). */
  private recorded: ThreadEvent[] | null = null;
  /**
   * Counts what makes a page on its way stale: the snapshots a resync has put in place of the
   * state, and the items.removed applied (which move the window's start, by which a page is placed).
   */
  private snapshots = 0;
  /** Pages from a later state than the store's, waiting for it to get there: true once it has, false if it disconnects. */
  private waiting: { seq: number; done: (reached: boolean) => void }[] = [];

  constructor(readonly source: ThreadSource) {
    const snapshot = source.snapshot;
    this.state = {
      snapshot,
      streaming: NO_IDS,
      resyncing: false,
      view: buildView(snapshot.items, snapshot.requests),
      loadingEarlier: false,
      earlierError: null,
    };
  }

  getState = (): ThreadState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Starts taking the source's events. Returns how to stop. */
  connect(): () => void {
    this.connected = true;
    const off = this.source.subscribe((event) => this.receive(event));
    // Events may have been sent while it wasn't listening: after the snapshot was taken and before
    // this subscription, or while it was disconnected (React hid the thread, or ran the effect
    // again), when a resync under way was dropped too. Ask from where the state is now (after any
    // the subscription replayed).
    if (this.connected && this.source.resync) this.gap();
    return () => {
      this.connected = false;
      this.attempt++;
      this.asked = "none";
      for (const w of this.waiting.splice(0)) w.done(false);
      off();
    };
  }

  /** Whether the snapshot is a window with items before it to load (with the source's loadEarlier). */
  hasEarlier(): boolean {
    return !!this.state.snapshot.start && !!this.source.loadEarlier;
  }

  /**
   * Whether item `id` is loaded with everything after it: it's in the window, not one of the items
   * from before it the window has for context (a subagent's call, whose earlier items aren't in).
   */
  isLoaded(id: string): boolean {
    return isLoaded(this.state.snapshot, id);
  }

  /**
   * Loads the page of items before the window's start (from the source's loadEarlier), and puts it
   * in front; with `to`, pages until that item is loaded with everything after it. Resolves once
   * it's done, or failed (`earlierError` says why). A load under way is joined, not repeated.
   */
  async loadEarlier({ to }: LoadEarlierOptions = {}): Promise<void> {
    const next = () => {
      if (this.paging) return this.paging;
      // It's the load under way before the source is asked, so one that fails straight away (the
      // source throws) is done with by the time it returns, and the next is asked for afresh.
      let done!: () => void;
      const paging = (this.paging = new Promise<void>((r) => (done = r)));
      void this.page()
        .catch((e) => {
          // It threw after the page came (putting it in, or a listener): it failed, so isn't stuck
          // loading. Unless what threw had started the next load, which is under way.
          if (this.paging !== paging && this.paging) return void console.error("agent-threads: loading earlier items failed", e);
          try {
            this.pageFailed(e);
          } catch (e) {
            console.error("agent-threads: a listener failed", e);
          }
        })
        .finally(() => {
          if (this.paging === paging) this.paging = null;
          done();
        });
      return paging;
    };
    if (to === undefined) {
      if (this.hasEarlier()) await next();
      return;
    }
    while (this.hasEarlier() && !this.isLoaded(to)) {
      await next();
      if (this.state.earlierError) return;
    }
  }

  /**
   * Loads the page before the window's start and puts it in, once the state has the events the page
   * has (a page can be from a later state). A resync that brings a fresh snapshot, or an
   * items.removed (which moves the window's start), meanwhile makes the page stale (its items may be older than the snapshot's, and events the
   * snapshot has in weren't applied, so can't be applied to the page): it's left out, and the page
   * before the new snapshot's start is asked for instead.
   */
  private async page(): Promise<void> {
    while (this.hasEarlier()) {
      const before = this.state.snapshot.start!;
      const epoch = this.snapshots;
      this.recorded = [];
      this.update({ ...this.state, loadingEarlier: true, earlierError: null });
      let page: ItemPage;
      try {
        page = await this.source.loadEarlier!(before);
      } catch (e) {
        this.pageFailed(e);
        return;
      }
      // A page from a later state than the store's waits for the store to get there: an
      // items.removed it already has (taken after a rewind whose event hasn't come yet) would
      // otherwise move the window's start again once it comes, past the page's items.
      if (page.seq > this.state.snapshot.seq && !(await this.reach(page.seq))) {
        this.recorded = null;
        this.paging = null;
        if (this.state.loadingEarlier) this.update({ ...this.state, loadingEarlier: false });
        return;
      }
      const recorded = this.recorded;
      this.recorded = null;
      if (epoch !== this.snapshots) continue;
      this.paging = null;
      const s = this.state.snapshot;
      // The page is from when the backend got the request, so it has every event applied before
      // then; events applied since that it doesn't have apply to its items too. Those that would
      // add an item or request it doesn't have are for the window (they're in it already).
      let theirs: Snapshot = { thread: s.thread, items: page.items, requests: page.requests, seq: page.seq };
      for (const e of recorded) {
        if (e.seq <= theirs.seq) continue;
        if (e.type === "item.added" && !theirs.items.some((i) => i.id === e.item.id)) continue;
        if (e.type === "request.opened" && !theirs.requests.some((r) => r.id === e.request.id)) continue;
        theirs = applyEvent(theirs, e);
      }
      const snapshot = withPage(s, { ...page, items: theirs.items, requests: theirs.requests });
      // A page that doesn't end at the window's start (or is another thread's) is left out. It's a
      // failure, not done, so loading back to an item doesn't ask for the same page forever.
      if (snapshot === s) {
        this.pageFailed(new Error(`the page of items before ${before} doesn't fit the thread's window`));
        return;
      }
      this.update({
        ...this.state,
        snapshot,
        view: buildView(snapshot.items, snapshot.requests, this.state.view),
        loadingEarlier: false,
      });
      return;
    }
    this.paging = null;
    if (this.state.loadingEarlier) this.update({ ...this.state, loadingEarlier: false });
  }

  /** Notes that loading earlier items failed, and why. */
  private pageFailed(e: unknown) {
    this.recorded = null;
    // Done before it says so, so what that sets off can load the next.
    this.paging = null;
    console.error("agent-threads: loading earlier items failed", e);
    this.update({ ...this.state, loadingEarlier: false, earlierError: e instanceof Error ? e.message : String(e) });
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
      // A page on its way is from before it: it's asked for again (see page).
      this.snapshots++;
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
    if (event.type === "items.removed" && snapshot !== state.snapshot) this.snapshots++;
    if (this.recorded && event.type !== "delta" && snapshot.seq !== state.snapshot.seq) this.recorded.push(event);
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
    if (this.waiting.length) {
      const seq = next.snapshot.seq;
      for (const w of this.waiting.filter((w) => w.seq <= seq)) w.done(true);
      this.waiting = this.waiting.filter((w) => w.seq > seq);
    }
    for (const l of this.listeners) l();
  }

  /** Resolves true once the state has the events up to `seq`, or false if the store disconnects first. */
  private reach(seq: number): Promise<boolean> {
    if (this.state.snapshot.seq >= seq) return Promise.resolve(true);
    if (!this.connected) return Promise.resolve(false);
    return new Promise((done) => this.waiting.push({ seq, done }));
  }
}

/**
 * Whether item `id` is in `snapshot` with everything after it: it's in its window, not one of the
 * items from before it the window has for context (a subagent's call, whose earlier items aren't in).
 */
export function isLoaded(snapshot: Snapshot, id: string): boolean {
  const ctx = snapshot.start ? (snapshot.context?.length ?? 0) : 0;
  for (let i = snapshot.items.length - 1; i >= 0; i--) if (snapshot.items[i]!.id === id) return i >= ctx;
  return false;
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
    case "items.removed":
      return event.item_ids.reduce(without, streaming);
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

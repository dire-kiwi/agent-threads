import { applyEvent, applyEvents, initialState, itemPage, snapshotWindow, type Item, type ItemPage, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "./store.js";
import { fixtureEvents, fixtureNames, fixtureThread, testSource, thread } from "./test/helpers.js";

const added = (seq: number, item: Item): ThreadEvent => ({ type: "item.added", thread_id: "th", seq, item });
const msg = (id: string, text = ""): Item => ({ id, type: "assistant_message", text });
const delta = (seq: number, item_id: string, text: string, offset = 0): ThreadEvent => ({ type: "delta", thread_id: "th", seq, item_id, kind: "text", offset, text });
const updated = (seq: number, item_id: string, patch: Record<string, unknown>): ThreadEvent => ({ type: "item.updated", thread_id: "th", seq, item_id, patch });

/**
 * A store on a test source, connected. The resync it asks for on connecting gets nothing (as from a
 * source with nothing new to send), and isn't passed on to `resync`.
 */
function connected(snapshot?: Snapshot, resync?: Parameters<typeof testSource>[1]) {
  let first = true;
  const t = testSource(snapshot, resync && ((seq) => (first ? void (first = false) : resync(seq))));
  const store = new ThreadStore(t.source);
  const disconnect = store.connect();
  return { ...t, store, disconnect, ids: () => store.getState().snapshot.items.map((i) => i.id) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("ThreadStore", () => {
  it("applies the source's events, and tells its listeners", () => {
    const { store, emit, ids } = connected();
    const heard = vi.fn();
    store.subscribe(heard);
    emit(added(1, msg("a", "hi")), added(2, msg("b", "there")));
    expect(ids()).toEqual(["a", "b"]);
    expect(store.getState().snapshot.seq).toBe(2);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("ignores events it has, and another thread's, without telling anyone", () => {
    const { store, emit } = connected();
    emit(added(1, msg("a")));
    const before = store.getState();
    const heard = vi.fn();
    store.subscribe(heard);
    emit(added(1, msg("a", "again")), { ...added(2, msg("x")), thread_id: "other" });
    expect(store.getState()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops taking events once disconnected", () => {
    const { store, emit, disconnect, listeners } = connected();
    disconnect();
    expect(listeners.size).toBe(0);
    emit(added(1, msg("a")));
    expect(store.getState().snapshot.items).toEqual([]);
  });

  it("notes what's streaming until its final text comes", () => {
    const { store, emit } = connected();
    emit(added(1, msg("a")), delta(1, "a", "Hel"), delta(1, "a", "lo", 3));
    expect(store.getState().streaming.has("a")).toBe(true);
    expect(store.getState().snapshot.items[0]).toMatchObject({ text: "Hello" });
    emit(updated(2, "a", { text: "Hello!" }));
    expect(store.getState().streaming.size).toBe(0);
    emit(added(3, msg("b")), delta(3, "b", "x"), { type: "turn.completed", thread_id: "th", seq: 4, turn_id: "t" });
    expect(store.getState().streaming.size).toBe(0);
  });

  it("ignores a stale delta, from before the state's seq", () => {
    const start = applyEvents(initialState(thread), [added(1, msg("a", "Hello")), updated(2, "a", { text: "Hello!" }), { type: "turn.completed", thread_id: "th", seq: 3, turn_id: "t" }]);
    const { store, emit } = connected(start);
    const before = store.getState();
    emit(delta(2, "a", " again", 5));
    expect(store.getState()).toBe(before);
    expect(store.getState().streaming.size).toBe(0);
  });

  it("skips deltas its snapshot already has", () => {
    // The source subscribed, then took a snapshot with "Hel" in, and passes on the delta it got before.
    const start = applyEvents(initialState(thread), [added(1, msg("a")), delta(1, "a", "Hel")]);
    const { store, emit } = connected(start);
    emit(delta(1, "a", "Hel"), delta(1, "a", "lo", 3));
    expect(store.getState().snapshot.items[0]).toMatchObject({ text: "Hello" });
  });

  it("keeps the view when an event leaves the items and requests as they were", () => {
    const { store, emit } = connected();
    emit(added(1, msg("a", "hi")));
    const view = store.getState().view;
    emit({ type: "turn.started", thread_id: "th", seq: 2, turn_id: "t" }, { type: "thread.updated", thread_id: "th", seq: 3, thread: { ...thread, status: "running" } });
    expect(store.getState().view).toBe(view);
    expect(store.getState().snapshot.thread.status).toBe("running");
  });

  describe("on connecting", () => {
    it("catches up on what was sent between the snapshot and subscribing", async () => {
      // The snapshot was taken mid-turn; the turn ended before the store subscribed, and no more events come.
      const start = applyEvents(initialState({ ...thread, status: "running" }), [added(1, msg("a", "Hel"))]);
      const resync = vi.fn(async () => [updated(2, "a", { text: "Hello" }), { type: "thread.updated", thread_id: "th", seq: 3, thread } as ThreadEvent]);
      const t = testSource(start, resync);
      const store = new ThreadStore(t.source);
      store.connect();
      expect(resync).toHaveBeenCalledWith(1);
      expect(store.getState().resyncing).toBe(true);
      await flush();
      expect(store.getState().snapshot.seq).toBe(3);
      expect(store.getState().snapshot.thread.status).toBe("idle");
      expect(store.getState().snapshot.items[0]).toMatchObject({ text: "Hello" });
      expect(store.getState().resyncing).toBe(false);
    });

    it("asks after taking what the subscription replays", () => {
      const resync = vi.fn(() => undefined);
      const t = testSource(undefined, resync);
      t.source.subscribe = (fn) => {
        fn(added(1, msg("a")));
        return () => {};
      };
      const store = new ThreadStore(t.source);
      store.connect();
      expect(resync).toHaveBeenCalledWith(1);
      expect(store.getState().resyncing).toBe(false);
    });

    it("doesn't ask a source that can't resync", () => {
      const { store } = connected();
      expect(store.getState().resyncing).toBe(false);
    });
  });

  describe("after a gap", () => {
    it("asks for the events after its seq, holding what comes meanwhile", async () => {
      let answer!: (r: ThreadEvent[]) => void;
      const resync = vi.fn(() => new Promise<ThreadEvent[]>((r) => (answer = r)));
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), added(4, msg("d")));
      expect(resync).toHaveBeenCalledWith(1);
      expect(store.getState().resyncing).toBe(true);
      expect(ids()).toEqual(["a"]);
      // More come while it waits, and a delta, which is dropped.
      emit(added(5, msg("e")), delta(5, "a", "lost"));
      expect(ids()).toEqual(["a"]);
      answer([added(2, msg("b")), added(3, msg("c")), added(4, msg("d"))]);
      await flush();
      expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
      expect(store.getState().snapshot.seq).toBe(5);
      expect(store.getState().resyncing).toBe(false);
      expect(store.getState().snapshot.items[0]).toMatchObject({ text: "" });
      expect(resync).toHaveBeenCalledTimes(1);
    });

    it("takes a fresh snapshot in place of its state", async () => {
      const fresh = applyEvents(initialState(thread), [added(1, msg("a")), added(2, msg("b")), added(3, msg("c"))]);
      const resync = vi.fn(async () => fresh);
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), delta(1, "a", "x"), added(4, msg("d")));
      await flush();
      expect(ids()).toEqual(["a", "b", "c", "d"]);
      expect(store.getState().streaming.size).toBe(0);
      expect(store.getState().resyncing).toBe(false);
    });

    it("waits for a source that sends the missing events itself", () => {
      const resync = vi.fn(() => undefined);
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), added(3, msg("c")));
      expect(store.getState().resyncing).toBe(true);
      emit(added(2, msg("b")));
      expect(ids()).toEqual(["a", "b", "c"]);
      expect(store.getState().resyncing).toBe(false);
    });

    it("treats a delta from after a missed event as a gap", async () => {
      const resync = vi.fn(async () => [added(2, msg("b"))]);
      const { emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), delta(2, "b", "x"));
      expect(resync).toHaveBeenCalledWith(1);
      await flush();
      expect(ids()).toEqual(["a", "b"]);
    });

    it("goes on past the gap when a resync brings nothing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resync = vi.fn(async () => [] as ThreadEvent[]);
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), added(3, msg("c")), added(4, msg("d")));
      await flush();
      expect(ids()).toEqual(["a", "c", "d"]);
      expect(store.getState().resyncing).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it("tries again with the next event after a resync fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const resync = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([added(2, msg("b"))]);
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), added(3, msg("c")));
      await flush();
      // Still missing seq 2, but not asking for it until the next event.
      expect(resync).toHaveBeenCalledTimes(1);
      expect(store.getState().resyncing).toBe(true);
      emit(added(4, msg("d")));
      await flush();
      expect(resync).toHaveBeenCalledTimes(2);
      expect(ids()).toEqual(["a", "b", "c", "d"]);
    });

    it("tries again after a failed resync when an event fills only part of the gap", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const resync = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([added(2, msg("b")), added(3, msg("c"))]);
      const { store, emit, ids } = connected(undefined, resync);
      emit(added(4, msg("d")));
      await flush();
      emit(added(1, msg("a")));
      expect(resync).toHaveBeenCalledTimes(2);
      expect(resync).toHaveBeenLastCalledWith(1);
      emit(added(5, msg("e")));
      await flush();
      expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
      expect(store.getState().resyncing).toBe(false);
    });

    it("applies the event anyway when the source can't resync", () => {
      const { store, emit, ids } = connected();
      emit(added(1, msg("a")), added(3, msg("c")));
      expect(ids()).toEqual(["a", "c"]);
      expect(store.getState().snapshot.seq).toBe(3);
    });

    it("applies a delta from past a gap when the source can't resync", () => {
      const { store, emit } = connected();
      emit(added(1, msg("a")), delta(2, "a", "x"));
      expect(store.getState().resyncing).toBe(false);
      expect(store.getState().snapshot.items[0]).toMatchObject({ text: "x" });
    });

    it("asks again when it's connected again mid-resync, and catches up", async () => {
      const answers: ((r: ThreadEvent[]) => void)[] = [];
      const resync = vi.fn(() => new Promise<ThreadEvent[]>((r) => answers.push(r)));
      const { store, emit, disconnect, ids } = connected(undefined, resync);
      emit(added(1, msg("a")), added(3, msg("c")));
      disconnect();
      // As React does running the effect again (StrictMode, Fast Refresh, <Activity>).
      store.connect();
      expect(resync).toHaveBeenCalledTimes(2);
      expect(resync).toHaveBeenLastCalledWith(1);
      emit(added(4, msg("d")));
      answers[1]!([added(2, msg("b"))]);
      await flush();
      expect(ids()).toEqual(["a", "b", "c", "d"]);
      expect(store.getState().resyncing).toBe(false);
      // The first resync's late answer changes nothing.
      answers[0]!([added(2, msg("stale"))]);
      await flush();
      expect(ids()).toEqual(["a", "b", "c", "d"]);
    });

    it("catches up on what it missed while disconnected, with no gap seen", async () => {
      const resync = vi.fn(async () => [updated(2, "a", { text: "done" }), { type: "turn.completed", thread_id: "th", seq: 3, turn_id: "t" } as ThreadEvent]);
      const { store, emit, disconnect } = connected(undefined, resync);
      emit(added(1, msg("a")), delta(1, "a", "do"));
      expect(resync).not.toHaveBeenCalled();
      disconnect();
      // The turn ends while nothing's listening, and no more events come.
      store.connect();
      expect(resync).toHaveBeenCalledWith(1);
      await flush();
      expect(store.getState().snapshot.seq).toBe(3);
      expect(store.getState().snapshot.items[0]).toMatchObject({ text: "done" });
      expect(store.getState().streaming.size).toBe(0);
      expect(store.getState().resyncing).toBe(false);
    });

    it("ends a resync on connecting again that brings nothing, quietly", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { store, emit, disconnect } = connected(undefined, async () => []);
      emit(added(1, msg("a")));
      disconnect();
      store.connect();
      await flush();
      expect(store.getState().resyncing).toBe(false);
      emit(delta(1, "a", "x"));
      expect(store.getState().snapshot.items[0]).toMatchObject({ text: "x" });
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores a resync that comes after it disconnected", async () => {
      let answer!: (r: ThreadEvent[]) => void;
      const { store, emit, disconnect, ids } = connected(undefined, () => new Promise((r) => (answer = r)));
      emit(added(1, msg("a")), added(3, msg("c")));
      disconnect();
      answer([added(2, msg("b"))]);
      await flush();
      expect(ids()).toEqual(["a"]);
      expect(store.getState().resyncing).toBe(true);
    });
  });

  describe("loading earlier items", () => {
    const agent = (id: string): Item => ({ id, type: "tool_call", name: "Agent", kind: "subagent", input: {}, status: "running" });
    /** A thread of m0..m9, with a subagent (s3) whose last item (b8) is in the window of 4 its store starts from. */
    function paged(limit = 4) {
      const items: Item[] = Array.from({ length: 10 }, (_, i) => (i === 3 ? agent("s3") : i === 8 ? { ...msg("b8"), parent_id: "s3" } : msg(`m${i}`, `m${i}`)));
      let whole = applyEvents(initialState(thread), items.map((item, i) => added(i + 1, item)));
      const pages: { before: number; resolve: (p: ItemPage) => void; reject: (e: Error) => void }[] = [];
      const t = testSource(snapshotWindow(whole, limit));
      t.source.loadEarlier = (before) => new Promise((resolve, reject) => void pages.push({ before, resolve, reject }));
      const store = new ThreadStore(t.source);
      store.connect();
      /** Answers the page asked for from the thread as it is now. */
      const answer = (n = 3) => pages.shift()!.resolve(itemPage(whole, store.getState().snapshot.start!, n));
      const change = (e: ThreadEvent) => {
        whole = applyEvent(whole, e);
        t.emit(e);
      };
      /** Changes the thread without the store hearing of it (it misses the events). */
      const missed = (...events: ThreadEvent[]) => void (whole = applyEvents(whole, events));
      return { ...t, store, pages, answer, change, missed, whole: () => whole, ids: () => store.getState().snapshot.items.map((i) => i.id) };
    }

    it("puts a page in front of the window, and notes while it's loading", async () => {
      const { store, pages, answer, ids } = paged();
      expect(ids()).toEqual(["s3", "m6", "m7", "b8", "m9"]);
      expect(store.hasEarlier()).toBe(true);
      expect(store.isLoaded("s3")).toBe(false);
      const done = store.loadEarlier();
      expect(store.getState().loadingEarlier).toBe(true);
      expect(pages.map((p) => p.before)).toEqual([6]);
      answer(2);
      await done;
      expect(store.getState().loadingEarlier).toBe(false);
      expect(ids()).toEqual(["s3", "m4", "m5", "m6", "m7", "b8", "m9"]);
      expect(store.getState().snapshot).toMatchObject({ start: 4, context: [3] });
      expect(store.getState().view.children.get("")!.map((i) => i.id)).toEqual(["s3", "m4", "m5", "m6", "m7", "m9"]);
      // The rest, and then there's nothing more to load.
      const rest = store.loadEarlier();
      answer(10);
      await rest;
      expect(ids()).toEqual(["m0", "m1", "m2", "s3", "m4", "m5", "m6", "m7", "b8", "m9"]);
      expect(store.hasEarlier()).toBe(false);
      expect(store.isLoaded("s3")).toBe(true);
      await store.loadEarlier();
      expect(pages).toEqual([]);
    });

    it("joins a load under way, and with `to` loads back to that item", async () => {
      const { store, pages, answer, ids } = paged();
      const a = store.loadEarlier();
      const b = store.loadEarlier();
      const c = store.loadEarlier({ to: "s3" });
      expect(pages).toHaveLength(1);
      answer(1);
      await a;
      await b;
      expect(ids()).toContain("m5");
      await flush();
      expect(pages).toHaveLength(1);
      answer(1);
      await flush();
      answer(1);
      await c;
      expect(store.isLoaded("s3")).toBe(true);
      expect(store.getState().snapshot.start).toBe(3);
      // Already in: nothing to load.
      await store.loadEarlier({ to: "m4" });
      expect(pages).toHaveLength(0);
    });

    it("notes why a page failed, and tries again when asked", async () => {
      const { store, pages, answer, ids } = paged();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const first = store.loadEarlier({ to: "m0" });
      pages.shift()!.reject(new Error("offline"));
      await first;
      expect(store.getState()).toMatchObject({ loadingEarlier: false, earlierError: "offline" });
      expect(err).toHaveBeenCalled();
      const again = store.loadEarlier();
      expect(store.getState().earlierError).toBeNull();
      answer();
      await again;
      expect(ids()).toContain("m5");
    });

    it("applies the events that come while a page loads to the page's items too", async () => {
      const { store, pages, change, whole, ids } = paged();
      const done = store.loadEarlier();
      // The page is taken now, before these.
      const page = itemPage(whole(), 6, 3);
      change(updated(11, "m5", { text: "m5 changed" }));
      change(updated(12, "s3", { status: "completed" }));
      change(added(13, msg("m10", "m10")));
      change({ type: "request.opened", thread_id: "th", seq: 14, request: { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {}, tool_call_id: "m10" } });
      pages.shift()!.resolve(page);
      await done;
      const s = store.getState().snapshot;
      expect(ids()).toEqual(["s3", "m4", "m5", "m6", "m7", "b8", "m9", "m10"]);
      expect(s.items.find((i) => i.id === "m5")).toMatchObject({ text: "m5 changed" });
      expect(s.items.find((i) => i.id === "s3")).toMatchObject({ status: "completed" });
      expect(s.requests.map((r) => r.id)).toEqual(["p1"]);
      expect(s.seq).toBe(14);
      expect(s).toEqual(snapshotWindow(whole(), 8));
    });

    it("asks again for a page that was on its way when a resync brought a fresh snapshot", async () => {
      const { store, pages, missed, whole } = paged();
      const done = store.loadEarlier();
      // The page is taken at seq 10, with the subagent running.
      const stale = itemPage(whole(), 6, 3);
      // Meanwhile the subagent ends, and a permission for m5 is asked and allowed: the store misses
      // these, and a resync brings a window of the same start with them in (seq 13).
      const p1 = { id: "p1", type: "permission" as const, name: "Bash", kind: "shell" as const, input: {}, tool_call_id: "m5" };
      missed(
        updated(11, "s3", { status: "completed" }),
        { type: "request.opened", thread_id: "th", seq: 12, request: p1 },
        { type: "request.resolved", thread_id: "th", seq: 13, request_id: "p1", resolution: { outcome: "allow" } },
      );
      (store as unknown as { caughtUp(r: Snapshot): void }).caughtUp(snapshotWindow(whole(), 4));
      expect(store.getState().snapshot).toMatchObject({ seq: 13, start: 6 });
      pages.shift()!.resolve(stale);
      await flush();
      // The stale page is left out, and the page before the fresh snapshot's start asked for.
      expect(pages.map((p) => p.before)).toEqual([6]);
      expect(store.getState().loadingEarlier).toBe(true);
      pages.shift()!.resolve(itemPage(whole(), 6, 3));
      await done;
      const s = store.getState().snapshot;
      expect(s).toEqual(snapshotWindow(whole(), 7));
      expect(s.items.find((i) => i.id === "s3")).toMatchObject({ status: "completed" });
      expect(s.requests).toEqual([{ ...p1, resolution: { outcome: "allow" } }]);
      expect(store.getState().loadingEarlier).toBe(false);
    });

    it("leaves out a page that doesn't end at the window's start, noting it failed", async () => {
      const { store, pages, whole, ids } = paged();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const done = store.loadEarlier();
      pages.shift()!.resolve(itemPage(whole(), 5, 3));
      await done;
      expect(store.getState().snapshot.start).toBe(6);
      expect(ids()).toEqual(["s3", "m6", "m7", "b8", "m9"]);
      expect(store.getState()).toMatchObject({ loadingEarlier: false, earlierError: "the page of items before 6 doesn't fit the thread's window" });
      expect(err).toHaveBeenCalled();
    });

    it("stops loading back to an item when a page doesn't fit, rather than asking for it forever", async () => {
      const { store, pages, whole } = paged();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const done = store.loadEarlier({ to: "m0" });
      pages.shift()!.resolve(itemPage(whole(), 5, 3));
      await done;
      expect(pages).toEqual([]);
      expect(store.getState()).toMatchObject({ loadingEarlier: false, earlierError: expect.stringContaining("doesn't fit") });
    });

    it("notes a failure that comes after the page does, rather than staying loading", async () => {
      const { store, pages, answer, ids } = paged();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      let broken = true;
      store.subscribe(() => {
        if (broken && store.getState().snapshot.start !== 6) throw new Error("listener broke");
      });
      const done = store.loadEarlier({ to: "m0" });
      answer(2);
      await done;
      // The page is in, but the load failed: it says why, and loading back to m0 stopped.
      expect(ids()).toContain("m4");
      expect(store.getState()).toMatchObject({ loadingEarlier: false, earlierError: "listener broke" });
      expect(pages).toEqual([]);
      expect(err).toHaveBeenCalled();
      // And the next load goes ahead.
      broken = false;
      const again = store.loadEarlier();
      expect(store.getState()).toMatchObject({ loadingEarlier: true, earlierError: null });
      answer(10);
      await again;
      expect(store.hasEarlier()).toBe(false);
    });

    it("asks the source again after it threw rather than failed a promise", async () => {
      const items = Array.from({ length: 5 }, (_, i) => msg(`m${i}`));
      const whole = applyEvents(initialState(thread), items.map((item, i) => added(i + 1, item)));
      const t = testSource(snapshotWindow(whole, 2));
      let calls = 0;
      t.source.loadEarlier = (before) => {
        if (++calls === 1) throw new Error("offline");
        return Promise.resolve(itemPage(whole, before, 10));
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const store = new ThreadStore(t.source);
      store.connect();
      await store.loadEarlier();
      expect(store.getState()).toMatchObject({ loadingEarlier: false, earlierError: "offline" });
      await store.loadEarlier();
      expect(calls).toBe(2);
      expect(store.getState().earlierError).toBeNull();
      expect(store.getState().snapshot).toEqual(whole);
    });

    it("has nothing to load without the source's loadEarlier", async () => {
      const items = Array.from({ length: 5 }, (_, i) => msg(`m${i}`));
      const whole = applyEvents(initialState(thread), items.map((item, i) => added(i + 1, item)));
      const { store } = connected(snapshotWindow(whole, 2));
      expect(store.hasEarlier()).toBe(false);
      await store.loadEarlier();
      expect(store.getState().snapshot.start).toBe(3);
    });
  });

  it.each(fixtureNames)("folds %s as applyEvents does", (name) => {
    const events = fixtureEvents(name);
    const start = initialState(fixtureThread(events));
    const { store, emit } = connected(start);
    emit(...events);
    expect(store.getState().snapshot).toEqual(applyEvents(start, events));
    expect(store.getState().streaming.size).toBe(0);
    expect(store.getState().resyncing).toBe(false);
  });
});

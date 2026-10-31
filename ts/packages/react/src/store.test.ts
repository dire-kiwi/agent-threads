import { applyEvents, initialState, type Item, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "./store.js";
import { fixtureEvents, fixtureNames, fixtureThread, testSource, thread } from "./test/helpers.js";

const added = (seq: number, item: Item): ThreadEvent => ({ type: "item.added", thread_id: "th", seq, item });
const msg = (id: string, text = ""): Item => ({ id, type: "assistant_message", text });
const delta = (seq: number, item_id: string, text: string): ThreadEvent => ({ type: "delta", thread_id: "th", seq, item_id, kind: "text", text });
const updated = (seq: number, item_id: string, patch: Record<string, unknown>): ThreadEvent => ({ type: "item.updated", thread_id: "th", seq, item_id, patch });

/** A store on a test source, connected. */
function connected(snapshot?: Snapshot, resync?: Parameters<typeof testSource>[1]) {
  const t = testSource(snapshot, resync);
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
    emit(added(1, msg("a")), delta(1, "a", "Hel"), delta(1, "a", "lo"));
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
    emit(delta(2, "a", " again"));
    expect(store.getState()).toBe(before);
    expect(store.getState().streaming.size).toBe(0);
  });

  it("keeps the view when an event leaves the items and requests as they were", () => {
    const { store, emit } = connected();
    emit(added(1, msg("a", "hi")));
    const view = store.getState().view;
    emit({ type: "turn.started", thread_id: "th", seq: 2, turn_id: "t" }, { type: "thread.updated", thread_id: "th", seq: 3, thread: { ...thread, status: "running" } });
    expect(store.getState().view).toBe(view);
    expect(store.getState().snapshot.thread.status).toBe("running");
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

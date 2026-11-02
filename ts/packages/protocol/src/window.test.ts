import { describe, expect, it } from "vitest";
import { readJson } from "./examples.js";
import type { Item, ItemPage, Snapshot, Thread, ThreadEvent, ThreadRequest } from "./generated.js";
import { applyEvent } from "./reducer.js";
import { itemPage, requestAnchor, snapshotWindow, withPage } from "./window.js";

const thread: Thread = { id: "th", harness: "claude", status: "waiting", created_at: "2026-11-01T00:00:00Z" };
const msg = (id: string, parent_id?: string, turn_id = "t1"): Item => ({ id, type: "assistant_message", text: id, turn_id, ...(parent_id ? { parent_id } : {}) });
const agent = (id: string, parent_id?: string): Item => ({
  id,
  type: "tool_call",
  name: "Agent",
  kind: "subagent",
  input: {},
  status: "completed",
  turn_id: "t1",
  ...(parent_id ? { parent_id } : {}),
});
const permission = (id: string, extra: Partial<ThreadRequest> = {}): ThreadRequest =>
  ({ id, type: "permission", name: "Bash", kind: "shell", input: {}, turn_id: "t1", ...extra }) as ThreadRequest;

/**
 * 0 m0, 1 sa (a subagent), 2 m2, 3 sb (sa's subagent), 4 m4, 5 b1 (sb's), 6 m6, 7 tc (sa's call),
 * 8 m8, 9 m9 (turn t2); requests: p-old answered at m2, p-sa open from sa for tc, p-new answered at
 * m8, p-turn answered with no call (turn t2: anchored at m9), p-none answered with neither.
 */
function state(): Snapshot {
  const items: Item[] = [
    msg("m0"),
    agent("sa"),
    msg("m2"),
    agent("sb", "sa"),
    msg("m4"),
    msg("b1", "sb"),
    msg("m6"),
    { id: "tc", type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "pending", parent_id: "sa", turn_id: "t1" },
    msg("m8"),
    msg("m9", undefined, "t2"),
  ];
  const requests = [
    permission("p-old", { tool_call_id: "m2", resolution: { outcome: "allow" } }),
    permission("p-sa", { tool_call_id: "tc", parent_id: "sa" }),
    permission("p-new", { tool_call_id: "m8", resolution: { outcome: "deny" } }),
    permission("p-turn", { turn_id: "t2", resolution: { outcome: "cancel" } }),
    permission("p-none", { turn_id: "t9", resolution: { outcome: "cancel" } }),
  ];
  return { thread, items, requests, seq: 20 };
}
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("snapshotWindow", () => {
  it("is the state itself without a limit, or with one it's within", () => {
    const s = state();
    expect(snapshotWindow(s)).toBe(s);
    expect(snapshotWindow(s, 10)).toBe(s);
    expect(snapshotWindow(s, 50)).toBe(s);
  });

  it("has the last items, the parents they and open requests need, and the requests anchored in it", () => {
    const w = snapshotWindow(state(), 2);
    expect(w.start).toBe(8);
    // p-sa is open: its call (tc) and its subagent (sa) come too.
    expect(w.context).toEqual([1, 7]);
    expect(ids(w.items)).toEqual(["sa", "tc", "m8", "m9"]);
    expect(ids(w.requests)).toEqual(["p-sa", "p-new", "p-turn", "p-none"]);
    expect(w.seq).toBe(20);
    expect(w.thread).toBe(state().thread);
  });

  it("brings the subagents its items belong to, however nested", () => {
    const w = snapshotWindow({ ...state(), requests: [] }, 5);
    expect(w.start).toBe(5);
    expect(w.context).toEqual([1, 3]);
    expect(ids(w.items)).toEqual(["sa", "sb", "b1", "m6", "tc", "m8", "m9"]);
  });

  it("brings the subagents still running, with theirs, for the items they'll go on to add", () => {
    // sb (sa's) is running but quiet: none of its items, nor a request of its, is in the window.
    const s = state();
    const quiet = { ...s, items: s.items.map((i) => (i.id === "sb" ? { ...i, status: "running" as const } : i)), requests: [] };
    const w = snapshotWindow(quiet, 2);
    expect(w.context).toEqual([1, 3]);
    expect(ids(w.items)).toEqual(["sa", "sb", "m8", "m9"]);
    // It goes on: its new item has its call to belong to.
    const next = applyEvent(w, { type: "item.added", thread_id: "th", seq: 21, item: msg("b10", "sb") });
    expect(next.items.find((i) => i.id === "sb")).toMatchObject({ status: "running" });
    // Pending counts as running; one that's ended doesn't.
    expect(snapshotWindow({ ...quiet, items: quiet.items.map((i) => (i.id === "sb" ? { ...i, status: "pending" as const } : i)) }, 2).context).toEqual([1, 3]);
    expect(snapshotWindow({ ...quiet, items: quiet.items.map((i) => (i.id === "sb" ? { ...i, status: "cancelled" as const } : i)) }, 2)).not.toHaveProperty("context");
  });

  it("leaves context out when it needs nothing from before it", () => {
    const w = snapshotWindow({ ...state(), requests: [] }, 1);
    expect(w).toEqual({ thread, items: [msg("m9", undefined, "t2")], requests: [], seq: 20, start: 9 });
  });
});

describe("itemPage", () => {
  it("has the items before an index, the parents they need, and the requests anchored in them", () => {
    const p = itemPage(state(), 6, 2);
    expect(p).toMatchObject({ thread_id: "th", start: 4, context: [1, 3], seq: 20 });
    expect(ids(p.items)).toEqual(["sa", "sb", "m4", "b1"]);
    expect(p.requests).toEqual([]);
    const q = itemPage(state(), 4, 4);
    expect(q.start).toBe(0);
    expect(q.context).toEqual([]);
    expect(ids(q.items)).toEqual(["m0", "sa", "m2", "sb"]);
    expect(ids(q.requests)).toEqual(["p-old"]);
  });

  it("keeps within the list", () => {
    expect(itemPage(state(), 50, 1).start).toBe(9);
    expect(itemPage(state(), -3, 5)).toMatchObject({ start: 0, items: [], context: [] });
  });
});

describe("withPage", () => {
  it("puts pages in front of a window until it's whole", () => {
    const whole = state();
    let w = snapshotWindow(whole, 2);
    for (const limit of [3, 2]) {
      const page = itemPage(whole, w.start!, limit);
      w = withPage(w, page);
      // The same as a window that had that many to begin with.
      expect(w).toEqual(snapshotWindow(whole, whole.items.length - page.start));
    }
    expect(w.start).toBe(3);
    w = withPage(w, itemPage(whole, 3, 10));
    expect(w).toEqual({ ...whole, requests: [whole.requests[0], ...whole.requests.slice(1)] });
    expect(w).not.toHaveProperty("start");
    expect(w).not.toHaveProperty("context");
  });

  it("orders the context of both by index", () => {
    // A window whose context is sa (1); a page from 4 whose context is sa and sb (1, 3).
    const whole = state();
    const w = snapshotWindow({ ...whole, requests: [] }, 4);
    expect(w.context).toEqual([1]);
    const next = withPage(w, itemPage(whole, 6, 2));
    expect(next.start).toBe(4);
    expect(next.context).toEqual([1, 3]);
    expect(ids(next.items)).toEqual(["sa", "sb", "m4", "b1", "m6", "tc", "m8", "m9"]);
  });

  it("takes the page's version of an item or request it has", () => {
    const whole = state();
    const w = snapshotWindow(whole, 2);
    const later = applyEvent(whole, { type: "item.updated", thread_id: "th", seq: 21, item_id: "sa", patch: { status: "failed" } });
    const next = withPage(w, itemPage(later, 8, 1));
    expect(next.items[0]).toMatchObject({ id: "sa", status: "failed" });
    expect(next.seq).toBe(20);
  });

  it("ignores a page for another thread, or that doesn't end at its start", () => {
    const whole = state();
    const w = snapshotWindow(whole, 2);
    expect(withPage(w, itemPage(whole, 7, 2))).toBe(w);
    expect(withPage(w, { ...itemPage(whole, 8, 2), thread_id: "other" })).toBe(w);
    expect(withPage(whole, itemPage(whole, 0, 2))).toBe(whole);
  });

  it("leaves events to apply as to any state", () => {
    const w = snapshotWindow(state(), 2);
    const e: ThreadEvent = { type: "item.added", thread_id: "th", seq: 21, item: msg("m10") };
    const next = applyEvent(w, e);
    expect(next.start).toBe(8);
    expect(next.context).toEqual([1, 7]);
    expect(ids(next.items).at(-1)).toBe("m10");
    // An update to an item it doesn't have only advances seq.
    const gone = applyEvent(next, { type: "item.updated", thread_id: "th", seq: 22, item_id: "m0", patch: { text: "x" } });
    expect(gone.items).toBe(next.items);
    expect(gone.seq).toBe(22);
  });
});

describe("requestAnchor", () => {
  it("is the request's tool call, else the last item of its turn, else -1", () => {
    const s = state();
    expect(s.requests.map((r) => requestAnchor(s.items, r))).toEqual([2, 7, 8, 9, -1]);
  });
});

describe("spec/examples", () => {
  const whole = readJson("examples/thread.snapshot.json") as Snapshot;
  const window = readJson("examples/thread.window.json") as Snapshot;
  const page = readJson("examples/thread.page.json") as ItemPage;

  it("thread.window.json is the snapshot's window of 8", () => expect(snapshotWindow(whole, 8)).toEqual(window));
  it("thread.page.json is its page of 3 before 5", () => expect(itemPage(whole, 5, 3)).toEqual(page));
  it("the window with the page is the window of 11", () => expect(withPage(window, page)).toEqual(snapshotWindow(whole, 11)));
});

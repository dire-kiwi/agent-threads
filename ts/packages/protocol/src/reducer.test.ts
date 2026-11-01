import { describe, expect, it } from "vitest";
import { readJson, readJsonl } from "./examples.js";
import type { AssistantMessage, Item, Snapshot, Thread, ThreadEvent, ToolCall } from "./generated.js";
import { applyEvent, applyEvents, initialState, isGap } from "./reducer.js";

const thread: Thread = { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" };
const user: Item = { id: "u1", type: "user_message", text: "hi" };
const call: ToolCall = { id: "tc1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "pending" };
const reply: AssistantMessage = { id: "a1", type: "assistant_message", text: "" };

/** A state with user, call and reply in it, at seq 3. */
function started(): Snapshot {
  let seq = 0;
  return applyEvents(
    initialState(thread),
    [user, call, reply].map((item): ThreadEvent => ({ type: "item.added", thread_id: "th", seq: ++seq, item })),
  );
}

describe("applyEvent", () => {
  it("adds items to the end, keeping the others", () => {
    const s = started();
    expect(s.items).toEqual([user, call, reply]);
    expect(s.seq).toBe(3);
    const next = applyEvent(s, { type: "item.added", thread_id: "th", seq: 4, item: { id: "n1", type: "notice", level: "info", text: "x" } });
    expect(next.items).toHaveLength(4);
    expect(next.items.slice(0, 3).every((item, i) => item === s.items[i])).toBe(true);
    expect(next.thread).toBe(s.thread);
    expect(next.requests).toBe(s.requests);
    expect(s.items).toHaveLength(3);
  });

  it("replaces an added item that has the id of one it has, in place", () => {
    const s = started();
    const again = { ...call, status: "running" as const };
    const next = applyEvent(s, { type: "item.added", thread_id: "th", seq: 4, item: again });
    expect(next.items).toEqual([user, again, reply]);
    expect(next.items[0]).toBe(s.items[0]);
  });

  it("patches an item: sets fields, removes nulls, leaves id and type", () => {
    const s = applyEvent(started(), {
      type: "item.updated",
      thread_id: "th",
      seq: 4,
      item_id: "tc1",
      patch: { status: "completed", result: { content: "a\nb" }, command: "ls", id: "other", type: "notice" },
    });
    expect(s.items[1]).toEqual({ ...call, status: "completed", result: { content: "a\nb" }, command: "ls" });
    const next = applyEvent(s, { type: "item.updated", thread_id: "th", seq: 5, item_id: "tc1", patch: { command: null } });
    expect(next.items[1]).not.toHaveProperty("command");
    expect(next.items[0]).toBe(s.items[0]);
    expect(next.items[2]).toBe(s.items[2]);
    expect(s.items[1]).toHaveProperty("command", "ls");
  });

  it("keeps an item a patch doesn't change", () => {
    const s = started();
    const next = applyEvent(s, { type: "item.updated", thread_id: "th", seq: 4, item_id: "tc1", patch: { status: "pending", title: null } });
    expect(next.items).toBe(s.items);
    expect(next.seq).toBe(4);
  });

  it("counts an update to an item it doesn't have", () => {
    const s = started();
    const next = applyEvent(s, { type: "item.updated", thread_id: "th", seq: 4, item_id: "nope", patch: { text: "x" } });
    expect(next.items).toBe(s.items);
    expect(next.seq).toBe(4);
  });

  /** A text delta to a1 at seq 3. */
  const delta = (text: string, offset: number, item_id = "a1", seq = 3): ThreadEvent => ({ type: "delta", thread_id: "th", seq, item_id, kind: "text", offset, text });

  it("appends deltas to text without counting them", () => {
    const s = started();
    const next = applyEvents(s, [delta("Hel", 0), delta("lo", 3)]);
    expect(next.items[2]).toEqual({ ...reply, text: "Hello" });
    expect(next.items[0]).toBe(s.items[0]);
    expect(next.items[1]).toBe(s.items[1]);
    expect(next.seq).toBe(3);
    // Not for items it doesn't have, items without text, or from before the state's last saved event.
    expect(applyEvent(s, delta("x", 0, "nope"))).toBe(s);
    expect(applyEvent(s, delta("x", 0, "tc1"))).toBe(s);
    expect(applyEvent(s, delta("x", 0, "a1", 2))).toBe(s);
    // One from after it (the state missed saved events) still applies.
    expect(applyEvent(s, delta("x", 0, "a1", 9)).items[2]).toEqual({ ...reply, text: "x" });
  });

  it("appends reasoning deltas", () => {
    const s = applyEvent(initialState(thread), { type: "item.added", thread_id: "th", seq: 1, item: { id: "r1", type: "reasoning", text: "a" } });
    expect(applyEvent(s, { type: "delta", thread_id: "th", seq: 1, item_id: "r1", kind: "reasoning", offset: 1, text: "b" }).items[0]).toMatchObject({ text: "ab" });
  });

  it("skips what of a delta the state already has", () => {
    // A snapshot taken after "Hel" and "lo" were sent has them in, and they come again after it.
    const s = applyEvents(started(), [delta("Hel", 0), delta("lo", 3)]);
    expect(applyEvent(s, delta("Hel", 0))).toBe(s);
    expect(applyEvent(s, delta("lo", 3))).toBe(s);
    expect(applyEvent(s, delta("el", 1))).toBe(s);
    // Part of it in already: the rest is appended.
    expect(applyEvent(s, delta("lo, world", 3)).items[2]).toEqual({ ...reply, text: "Hello, world" });
    expect(applyEvents(s, [delta("Hel", 0), delta("lo", 3), delta(", world", 5)]).items[2]).toEqual({ ...reply, text: "Hello, world" });
  });

  it("skips a delta past the end of the text", () => {
    // Deltas were missed: the item's final text puts it right.
    const s = applyEvent(started(), delta("Hel", 0));
    expect(applyEvent(s, delta("p", 5))).toBe(s);
  });

  it("ignores a delta whose kind isn't its item's", () => {
    const s = applyEvent(started(), { type: "item.added", thread_id: "th", seq: 4, item: { id: "r1", type: "reasoning", text: "" } });
    expect(applyEvent(s, { type: "delta", thread_id: "th", seq: 4, item_id: "a1", kind: "reasoning", offset: 0, text: "x" })).toBe(s);
    expect(applyEvent(s, { type: "delta", thread_id: "th", seq: 4, item_id: "r1", kind: "text", offset: 0, text: "x" })).toBe(s);
  });

  it("returns the state itself for an empty delta", () => {
    const s = started();
    expect(applyEvent(s, delta("", 0))).toBe(s);
  });

  it("opens and resolves requests", () => {
    const s = started();
    const open = applyEvents(s, [
      { type: "request.opened", thread_id: "th", seq: 4, request: { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} } },
      { type: "request.opened", thread_id: "th", seq: 5, request: { id: "q1", type: "question", questions: [{ id: "a", question: "?" }] } },
    ]);
    expect(open.requests.map((r) => r.id)).toEqual(["p1", "q1"]);
    expect(open.items).toBe(s.items);
    const resolved = applyEvent(open, { type: "request.resolved", thread_id: "th", seq: 6, request_id: "p1", resolution: { outcome: "allow" } });
    expect(resolved.requests).toEqual([open.requests[1]]);
    expect(resolved.requests[0]).toBe(open.requests[1]);
    const unknown = applyEvent(resolved, { type: "request.resolved", thread_id: "th", seq: 7, request_id: "p1", resolution: { outcome: "allow" } });
    expect(unknown.requests).toBe(resolved.requests);
    expect(unknown.seq).toBe(7);
  });

  it("replaces the thread", () => {
    const s = started();
    const running: Thread = { ...thread, status: "running", run: { id: "r", spawner: "direct" } };
    const next = applyEvent(s, { type: "thread.updated", thread_id: "th", seq: 4, thread: running });
    expect(next.thread).toBe(running);
    expect(next.items).toBe(s.items);
  });

  it("counts turn events", () => {
    const s = started();
    const next = applyEvent(s, { type: "turn.started", thread_id: "th", seq: 4, turn_id: "t1" });
    expect(next).toEqual({ ...s, seq: 4 });
    expect(next.items).toBe(s.items);
  });

  it("ignores events it already has, and other threads' events", () => {
    const s = started();
    expect(applyEvent(s, { type: "item.added", thread_id: "th", seq: 3, item: { ...reply, text: "again" } })).toBe(s);
    expect(applyEvent(s, { type: "item.added", thread_id: "th", seq: 1, item: user })).toBe(s);
    expect(applyEvent(s, { type: "item.added", thread_id: "other", seq: 4, item: user })).toBe(s);
    expect(applyEvent(s, { type: "delta", thread_id: "other", seq: 3, item_id: "a1", kind: "text", offset: 0, text: "x" })).toBe(s);
  });

  it("counts event types it doesn't know", () => {
    const s = started();
    const next = applyEvent(s, { type: "turn.paused", thread_id: "th", seq: 4 } as unknown as ThreadEvent);
    expect(next).toEqual({ ...s, seq: 4 });
  });
});

describe("isGap", () => {
  it("is true for a saved event more than one past the state", () => {
    const s = started();
    expect(isGap(s, { type: "turn.started", thread_id: "th", seq: 4, turn_id: "t" })).toBe(false);
    expect(isGap(s, { type: "turn.started", thread_id: "th", seq: 3, turn_id: "t" })).toBe(false);
    expect(isGap(s, { type: "turn.started", thread_id: "th", seq: 5, turn_id: "t" })).toBe(true);
    expect(isGap(s, { type: "delta", thread_id: "th", seq: 5, item_id: "a1", kind: "text", offset: 0, text: "" })).toBe(false);
    expect(isGap(s, { type: "turn.started", thread_id: "other", seq: 9, turn_id: "t" })).toBe(false);
  });
});

describe("spec/examples/thread", () => {
  const events = readJsonl("examples/thread.events.jsonl") as ThreadEvent[];
  const first = events[0] as Extract<ThreadEvent, { type: "thread.updated" }>;

  it("folds into thread.snapshot.json", () => {
    expect(applyEvents(initialState(first.thread), events)).toEqual(readJson("examples/thread.snapshot.json"));
  });

  it("folds the same with every event delivered twice", () => {
    const twice = events.flatMap((e): ThreadEvent[] => [e, e]);
    expect(applyEvents(initialState(first.thread), twice)).toEqual(readJson("examples/thread.snapshot.json"));
  });

  it("has seqs that go up by one", () => {
    let seq = 0;
    for (const e of events) {
      if (e.type === "delta") expect(e.seq).toBe(seq);
      else expect(e.seq).toBe(++seq);
    }
  });
});

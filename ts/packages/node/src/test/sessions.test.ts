// Sessions: where each turn leaves the harness's session, and rewind, new_session and compact,
// against a fake harness whose turns the test ends (the recorded fixtures have the real CLIs').

import { describe, expect, it } from "vitest";
import { applyEvents, initialState, type Item, type ThreadEvent, type TurnResult, type TurnSession } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads, CommandError } from "../agent-threads.js";
import type { Harness, HarnessSession, ThreadContext } from "../harness.js";
import { resumeAtPoint, revertPoint, RewindError } from "../sessions.js";
import { MemoryStore } from "../stores/memory.js";

/** A harness whose turns the test ends, with the session it says. */
function fake(point: typeof resumeAtPoint) {
  const h = { ctx: undefined as ThreadContext | undefined, compacts: 0, changes: 0 };
  const session: HarnessSession = {
    start: () => {},
    steer: () => {},
    carryOver: () => {},
    interrupt: () => {},
    live: () => false,
    release: () => {},
    optionsChanged: () => void h.changes++,
    close: async () => {},
    compact: () => void h.compacts++,
    rewindPoint: point,
  };
  const harness: Harness = { name: "fake", open: (c) => ((h.ctx = c), session) };
  return { h, harness };
}

async function setup(point = resumeAtPoint, create: { session_id?: string } = {}) {
  const { h, harness } = fake(point);
  const events: ThreadEvent[] = [];
  const sdk = new AgentThreads({ store: new MemoryStore(), harnesses: { fake: harness }, permissions: "allow" });
  sdk.subscribe((e) => events.push(e));
  const thread = await sdk.create(create);
  /** A turn: it runs in `session` (a new one if the thread has none), and the harness marks it `at`. */
  const turn = async (text: string, session?: string, at?: string) => {
    await sdk.send(thread.id, text);
    if (session) h.ctx!.setThread({ session_id: session });
    h.ctx!.addItem({ id: `a-${text}`, type: "assistant_message", text: `re: ${text}` });
    h.ctx!.endTurn({ ok: true, ...(at ? { session_at: at } : {}) });
  };
  const snap = () => sdk.snapshot(thread.id);
  return { sdk, h, id: thread.id, events, turn, snap };
}

const turnIds = (items: Item[]) => items.filter((i): i is TurnResult => i.type === "turn_result").map((r) => r.turn_id!);
const sessions = (items: Item[]) => items.filter((i): i is TurnResult => i.type === "turn_result").map((r) => r.session);

describe("a turn_result's session", () => {
  it("has the session the turn ended in, its mark, and whether the turn started it", async () => {
    const { sdk, id, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await turn("two", undefined, "m2");
    await turn("three"); // no mark
    await sdk.newSession(id);
    await turn("four", "S2", "m4");
    expect(sessions((await snap()).items)).toEqual([{ id: "S1", at: "m1", started: true }, { id: "S1", at: "m2" }, { id: "S1" }, { id: "S2", at: "m4", started: true }]);
  });

  it("is left out when the turn ended with no session", async () => {
    const { turn, snap } = await setup();
    await turn("one");
    expect(sessions((await snap()).items)).toEqual([undefined]);
  });
});

describe("rewind", () => {
  it("removes the turn's items and later turns', and resumes the session at the turn before's mark", async () => {
    const { sdk, h, id, events, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await turn("two", undefined, "m2");
    await turn("three", undefined, "m3");
    const before = await snap();
    const [, t2] = turnIds(before.items);
    const changes = h.changes;
    await sdk.rewind(id, t2!);
    const s = await snap();
    expect(s.items.map((i) => i.type)).toEqual(["user_message", "assistant_message", "turn_result", "notice"]);
    expect(s.items.at(-1)).toMatchObject({ type: "notice", level: "info", code: "rewind" });
    expect(s.thread).toMatchObject({ session_id: "S1", resume_at: "m1" });
    expect(h.changes).toBe(changes + 1);
    const removed = events.find((e) => e.type === "items.removed");
    expect(removed && "item_ids" in removed ? removed.item_ids : []).toEqual(before.items.slice(3).map((i) => i.id));
    expect(s).toEqual(applyEvents(initialState(events[0]!.type === "thread.updated" ? events[0]!.thread : s.thread), events));
  });

  it("to before a session's first turn starts a new one", async () => {
    const { sdk, id, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await turn("two", undefined, "m2");
    await sdk.rewind(id, turnIds((await snap()).items)[0]!);
    const s = await snap();
    expect(s.thread.session_id).toBeUndefined();
    expect(s.thread.resume_at).toBeUndefined();
    expect(s.items.map((i) => i.type)).toEqual(["notice"]);
  });

  it("to before the first turn after a new_session keeps the new session's notice, and starts a new one", async () => {
    const { sdk, id, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await sdk.newSession(id);
    await turn("two", "S2", "m2");
    await sdk.rewind(id, turnIds((await snap()).items)[1]!);
    const s = await snap();
    expect(s.thread.session_id).toBeUndefined();
    expect(s.items.map((i) => (i.type === "notice" ? i.code : i.type))).toEqual(["user_message", "assistant_message", "turn_result", "session.new", "rewind"]);
  });

  it("goes back into the session before a new_session, taking the new session's notice with it", async () => {
    const { sdk, id, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await turn("two", undefined, "m2");
    await sdk.newSession(id);
    await turn("three", "S2", "m3");
    const [, t2, t3] = turnIds((await snap()).items);
    await sdk.rewind(id, t2!);
    const s = await snap();
    expect(s.thread).toMatchObject({ session_id: "S1", resume_at: "m1" });
    expect(s.items.some((i) => i.type === "notice" && i.code === "session.new")).toBe(false);
    expect(turnIds(s.items)).not.toContain(t3);
  });

  it("is refused for a Claude session the thread adopted, to before its first turn in it", async () => {
    const { sdk, id, turn, snap } = await setup(resumeAtPoint, { session_id: "S0" });
    await turn("one", undefined, "m1");
    const before = await snap();
    await expect(sdk.rewind(id, turnIds(before.items)[0]!)).rejects.toThrow(CommandError);
    expect(await snap()).toEqual(before);
  });

  it("reverts a Codex session to before the first turn from there that has a mark", async () => {
    const { sdk, id, turn, snap } = await setup(revertPoint, { session_id: "S0" });
    await turn("one", undefined, "c1");
    await turn("two"); // no mark
    await turn("three", undefined, "c3");
    const [t1, t2] = turnIds((await snap()).items);
    await sdk.rewind(id, t2!);
    expect((await snap()).thread).toMatchObject({ session_id: "S0", resume_at: "c3" });
    await sdk.rewind(id, t1!);
    expect((await snap()).thread).toMatchObject({ session_id: "S0", resume_at: "c1" });
  });

  it("keeps a Codex revert not yet made when a second rewind, to before turns with no mark, needs it", async () => {
    const { sdk, id, turn, snap } = await setup(revertPoint);
    await turn("one", "S", "c1");
    await turn("two"); // failed before Codex marked it
    await turn("three", undefined, "c3");
    const [, t2, t3] = turnIds((await snap()).items);
    await sdk.rewind(id, t3!);
    expect((await snap()).thread).toMatchObject({ session_id: "S", resume_at: "c3" });
    // Codex still has turn three: reverting to before it is what takes it back to before turn two.
    await sdk.rewind(id, t2!);
    expect((await snap()).thread).toMatchObject({ session_id: "S", resume_at: "c3" });
    expect(turnIds((await snap()).items)).toHaveLength(1);
  });

  it("is refused while a turn runs, and for a turn the thread hasn't", async () => {
    const { sdk, id, turn, snap } = await setup();
    await turn("one", "S1", "m1");
    await expect(sdk.rewind(id, "turn_nope")).rejects.toThrow(/no turn turn_nope/);
    await sdk.send(id, "two");
    await expect(sdk.rewind(id, turnIds((await snap()).items)[0]!)).rejects.toThrow(/a turn is running/);
    await expect(sdk.newSession(id)).rejects.toThrow(/a turn is running/);
    await expect(sdk.compact(id)).rejects.toThrow(/a turn is running/);
  });
});

describe("new_session", () => {
  it("lets go of the session, and does nothing when there's none", async () => {
    const { sdk, h, id, events, turn, snap } = await setup();
    const n = events.length;
    await sdk.newSession(id);
    expect(events.length).toBe(n);
    await turn("one", "S1", "m1");
    await sdk.handle({ type: "new_session", thread_id: id });
    const s = await snap();
    expect(s.thread.session_id).toBeUndefined();
    expect(s.items.at(-1)).toMatchObject({ type: "notice", code: "session.new" });
    expect(h.changes).toBeGreaterThan(0);
  });
});

describe("compact", () => {
  it("runs a turn with no message, and is refused with no session", async () => {
    const { sdk, h, id, turn, snap } = await setup();
    await expect(sdk.compact(id)).rejects.toThrow(/no conversation to compact/);
    await turn("one", "S1", "m1");
    const n = (await snap()).items.length;
    await sdk.handle({ type: "compact", thread_id: id });
    expect(h.compacts).toBe(1);
    expect((await snap()).thread.status).toBe("running");
    h.ctx!.addItem({ id: "c1", type: "compaction", trigger: "manual" });
    h.ctx!.endTurn({ ok: true, session_at: "m2" });
    const s = await snap();
    expect(s.items.slice(n).map((i) => i.type)).toEqual(["compaction", "turn_result"]);
    expect(sessions(s.items).at(-1)).toEqual({ id: "S1", at: "m2" });
  });
});

describe("the rewind points", () => {
  const s = (id: string, at?: string, started?: boolean): TurnSession => ({ id, ...(at ? { at } : {}), ...(started ? { started } : {}) });
  it("resume at the latest mark before the turn, in its session", () => {
    expect(resumeAtPoint([s("A", "a1", true), s("A"), s("A", "a3")], 2)).toEqual({ session_id: "A", resume_at: "a1" });
    expect(resumeAtPoint([s("A", "a1", true), s("B", "b1", true)], 1)).toEqual({});
    expect(resumeAtPoint([undefined, s("A", "a1", true)], 0)).toEqual({});
    expect(() => resumeAtPoint([s("A", undefined, true), s("A", "a2")], 1)).toThrow(RewindError);
    expect(() => resumeAtPoint([s("A", "a1")], 0)).toThrow(RewindError);
  });
  it("revert to before the first mark from the turn on, in its session", () => {
    expect(revertPoint([s("A", "a1", true), s("A"), s("A", "a3")], 1)).toEqual({ session_id: "A", resume_at: "a3" });
    expect(revertPoint([s("A", "a1", true), s("A"), s("B", "b1", true)], 1)).toEqual({ session_id: "A" });
    expect(revertPoint([s("A", "a1", true)], 0)).toEqual({});
  });
});

describe("a turn the backend lost", () => {
  /** A thread whose turn was running when its backend went (without closing), loaded by another. */
  async function lost(create: { session_id?: string }, before?: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const store = new MemoryStore();
    const first = fake(resumeAtPoint);
    const sdk = new AgentThreads({ store, harnesses: { fake: first.harness }, permissions: "allow" });
    const thread = await sdk.create(create);
    const t = { sdk, h: first.h, id: thread.id } as unknown as Awaited<ReturnType<typeof setup>>;
    if (before) await before(t);
    await sdk.send(thread.id, "the lost one");
    // The harness says which session the turn runs in (a new one, if the thread had none), then the
    // backend goes.
    first.h.ctx!.setThread({ session_id: create.session_id ?? "S-new" });
    await sdk.eventsSince(thread.id, 0);
    const next = new AgentThreads({ store, harnesses: { fake: fake(resumeAtPoint).harness }, permissions: "allow" });
    const s = await next.snapshot(thread.id);
    return { next, id: thread.id, s };
  }

  it("records that it started the session it got", async () => {
    const { next, id, s } = await lost({});
    expect(sessions(s.items)).toEqual([{ id: "S-new", started: true }]);
    await next.rewind(id, turnIds(s.items)[0]!);
    expect((await next.snapshot(id)).thread.session_id).toBeUndefined();
  });

  it("records that it started the one it got after a new_session", async () => {
    const { s } = await lost({}, async ({ sdk, h, id }) => {
      await sdk.send(id, "one");
      h.ctx!.setThread({ session_id: "S-old" });
      h.ctx!.endTurn({ ok: true, session_at: "m1" });
      await sdk.newSession(id);
    });
    expect(sessions(s.items)).toEqual([{ id: "S-old", at: "m1", started: true }, { id: "S-new", started: true }]);
  });

  it("records that it continued a session the thread adopted", async () => {
    const { next, id, s } = await lost({ session_id: "S0" });
    expect(sessions(s.items)).toEqual([{ id: "S0" }]);
    await expect(next.rewind(id, turnIds(s.items)[0]!)).rejects.toThrow(CommandError);
  });
});

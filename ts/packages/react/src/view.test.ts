import { applyEvent, applyEvents, initialState, type Item, type ThreadRequest, type ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { describe, expect, it } from "vitest";
import { fixtureEvents, fixtureThread } from "./test/helpers.js";
import { buildView, groupRows, lineage, type ToolGroup } from "./view.js";

const call = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "running", ...extra });
const text = (id: string, t: string, parent_id?: string): Item => ({ id, type: "assistant_message", text: t, ...(parent_id ? { parent_id } : {}) });
const user: Item = { id: "u1", type: "user_message", text: "hi" };

describe("buildView", () => {
  it("splits the items into the main thread's and each subagent's", () => {
    const sub = call("s1", { name: "Agent", kind: "subagent" });
    const items = [user, sub, call("c1", { parent_id: "s1" }), text("m1", "done", "s1"), text("m2", "ok")];
    const v = buildView(items, []);
    expect(v.children.get("")!.map((i) => i.id)).toEqual(["u1", "s1", "m2"]);
    expect(v.children.get("s1")!.map((i) => i.id)).toEqual(["c1", "m1"]);
    expect(v.subagents.get("s1")).toMatchObject({ id: "s1", status: "running", toolUses: 1, waiting: false, items: v.children.get("s1") });
  });

  it("keeps the lists, subagents and maps an event leaves as they were", () => {
    const sub = call("s1", { name: "Agent", kind: "subagent" });
    const items = [user, sub, call("c1", { parent_id: "s1" }), text("m2", "ok")];
    const v1 = buildView(items, []);
    // The main thread's reply grows: the subagent's list and info stay.
    const grown = [...items.slice(0, 3), text("m2", "ok, more")];
    const v2 = buildView(grown, [], v1);
    expect(v2.children.get("")).not.toBe(v1.children.get(""));
    expect(v2.children.get("s1")).toBe(v1.children.get("s1"));
    expect(v2.subagents).toBe(v1.subagents);
    expect(v2.requestsByCall).toBe(v1.requestsByCall);
    // Nothing changes: it's all the same.
    const v3 = buildView(grown.slice(), [], v2);
    expect(v3.children).toBe(v2.children);
  });

  it("notes the open requests by call, and the subagents waiting on one", () => {
    const sub = call("s1", { name: "Agent", kind: "subagent" });
    const req: ThreadRequest = { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {}, tool_call_id: "c1", parent_id: "s1" };
    const v = buildView([sub, call("c1", { parent_id: "s1", status: "pending" })], [req]);
    expect(v.requestsByCall.get("c1")).toBe(req);
    expect(v.subagents.get("s1")!.waiting).toBe(true);
  });

  it("gives a subagent's status from its call's", () => {
    const status = (s: ToolCall["status"]) => buildView([call("s", { kind: "subagent", status: s })], []).subagents.get("s")!.status;
    expect([status("pending"), status("running"), status("completed"), status("failed"), status("denied"), status("cancelled")]).toEqual([
      "running",
      "running",
      "completed",
      "failed",
      "stopped",
      "stopped",
    ]);
  });

  it("takes a subagent's status, background and tool uses from its subagent, where the harness gives them", () => {
    const sub = call("s", { kind: "subagent", status: "completed", subagent: { status: "running", background: true, tool_uses: 3 } });
    expect(buildView([sub], []).subagents.get("s")).toMatchObject({ status: "running", background: true, toolUses: 3 });
  });

  it("follows nested subagents out", () => {
    const v = buildView([call("a", { kind: "subagent" }), call("b", { kind: "subagent", parent_id: "a" }), call("c", { kind: "subagent", parent_id: "b" })], []);
    expect(lineage(v.subagents, "c")).toEqual(["c", "b", "a"]);
  });
});

describe("groupRows", () => {
  it("groups tool calls in a row, and leaves out messages with no text yet", () => {
    const rows = groupRows([user, call("c1"), text("m0", ""), call("c2"), text("m1", "hi"), call("c3")]);
    expect(rows.map((r) => (r.type === "tool_group" ? r.calls.map((c) => c.id).join("+") : r.id))).toEqual(["u1", "c1+c2", "m1", "c3"]);
  });

  it("shows the calls `alone` picks by themselves", () => {
    const rows = groupRows([call("c1"), call("order", { name: "lookup_order", kind: "app" }), call("c2")], undefined, (c) => c.name === "lookup_order");
    expect(rows.map((r) => r.type)).toEqual(["tool_group", "tool_call", "tool_group"]);
  });

  it("keeps the rows that are the same, and the list if they all are", () => {
    const c1 = call("c1");
    const items = [user, c1, call("c2"), text("m1", "hi")];
    const rows = groupRows(items);
    expect(groupRows(items.slice(), rows)).toBe(rows);
    // The reply grows: the group stays.
    const next = groupRows([...items.slice(0, 3), text("m1", "hi there")], rows);
    expect(next).not.toBe(rows);
    expect(next[1]).toBe(rows[1]);
    // A call in the group gets its result: a new group, with the other call as it was.
    const done = groupRows([user, { ...c1, status: "completed" }, items[2]!, items[3]!], rows);
    expect(done[1]).not.toBe(rows[1]);
    expect((done[1] as ToolGroup).calls[1]).toBe(items[2]);
    expect(done[2]).toBe(rows[2]);
  });
});

describe("on a fixture", () => {
  it("rebuilds only what each event changes", () => {
    const events = fixtureEvents("claude/subagent");
    let s = initialState(fixtureThread(events));
    let v = buildView(s.items, s.requests);
    for (const e of events) {
      const next = applyEvent(s, e);
      const nv = buildView(next.items, next.requests, v);
      for (const [id, list] of nv.children) {
        const old = v.children.get(id);
        const changed = !old || old.length !== list.length || list.some((it, i) => it !== old[i]);
        expect(list === old).toBe(!changed);
      }
      s = next;
      v = nv;
    }
    const final = applyEvents(initialState(fixtureThread(events)), events);
    expect(v.subagents.size).toBe(1);
    const [sub] = v.subagents.values();
    expect(sub).toMatchObject({ status: "completed", toolUses: 1 });
    expect(v.children.get("")!.length + sub!.items.length).toBe(final.items.length);
  });
});

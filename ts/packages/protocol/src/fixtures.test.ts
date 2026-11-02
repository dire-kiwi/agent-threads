// Each fixture's expected.jsonl (spec/fixtures/<harness>/<scenario>) is a valid stream of events:
// every event is a ThreadEvent, and they fold with applyEvent into a finished thread. And the values
// in the store conformance suite (spec/conformance/store.json) are valid too.

import { readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readJson, readJsonl, specDir } from "./examples.js";
import type { Snapshot, ThreadEvent } from "./generated.js";
import { applyEvents, initialState, openRequests } from "./reducer.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(readJson("protocol.schema.json") as object, "protocol");
const validEvent = ajv.getSchema("protocol#/$defs/ThreadEvent")!;

const fixtures = readdirSync(specDir + "fixtures", { withFileTypes: true })
  .filter((h) => h.isDirectory())
  .flatMap((h) => readdirSync(`${specDir}fixtures/${h.name}`).map((s) => `${h.name}/${s}`))
  .sort();

describe.each(fixtures)("spec/fixtures/%s/expected.jsonl", (fixture) => {
  const events = readJsonl(`fixtures/${fixture}/expected.jsonl`) as ThreadEvent[];

  it("is ThreadEvents", () => {
    for (const [i, event] of events.entries()) {
      validEvent(event);
      expect({ event: i + 1, errors: validEvent.errors ?? [] }).toEqual({ event: i + 1, errors: [] });
    }
  });

  it("folds into a finished thread", () => {
    const first = events[0]!;
    expect(first.type).toBe("thread.updated");
    const s: Snapshot = applyEvents(initialState(first.type === "thread.updated" ? first.thread : (undefined as never)), events);
    expect(s.seq).toBe(events.filter((e) => e.type !== "delta").length);
    expect(openRequests(s)).toEqual([]);
    expect(["idle", "error"]).toContain(s.thread.status);
    // Every turn ended, with a turn_result, and the snapshot has those a rewind didn't remove.
    const started = events.flatMap((e) => (e.type === "turn.started" ? [e.turn_id] : []));
    const completed = events.flatMap((e) => (e.type === "turn.completed" ? [e.turn_id] : []));
    expect(completed).toEqual(started);
    const results = events.flatMap((e) => (e.type === "item.added" && e.item.type === "turn_result" ? [e.item] : []));
    expect(results.map((r) => r.turn_id)).toEqual(started);
    const removed = new Set(events.flatMap((e) => (e.type === "items.removed" ? e.item_ids : [])));
    expect(s.items.filter((i) => i.type === "turn_result").map((i) => i.id)).toEqual(results.filter((r) => !removed.has(r.id)).map((r) => r.id));
    expect(s.items.filter((i) => i.type === "tool_call" && (i.status === "running" || i.status === "pending"))).toEqual([]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
  });
});

describe("spec/conformance/store.json", () => {
  const { values } = readJson("conformance/store.json") as { values: Record<string, unknown> };
  // T* are threads, E*, F* and D events, S* snapshots; R* are runs, which are each backend's own.
  const defs: Record<string, string> = { T: "Thread", E: "ThreadEvent", F: "ThreadEvent", D: "ThreadEvent", S: "Snapshot" };
  it.each(Object.keys(values).filter((k) => defs[k[0]!]))("%s is valid", (name) => {
    const validate = ajv.getSchema(`protocol#/$defs/${defs[name[0]!]}`)!;
    validate(values[name]);
    expect(validate.errors ?? []).toEqual([]);
  });
});

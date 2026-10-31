// Each fixture's expected.jsonl (spec/fixtures/<harness>/<scenario>) is a valid stream of events:
// every event is a ThreadEvent, and they fold with applyEvent into a finished thread.

import { readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readJson, readJsonl, specDir } from "./examples.js";
import type { Snapshot, ThreadEvent } from "./generated.js";
import { applyEvents, initialState } from "./reducer.js";

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
    expect(s.requests).toEqual([]);
    expect(["idle", "error"]).toContain(s.thread.status);
    // Every turn ended with a turn_result, and nothing was left running.
    const turns = events.filter((e) => e.type === "turn.started").length;
    expect(s.items.filter((i) => i.type === "turn_result")).toHaveLength(turns);
    expect(s.items.filter((i) => i.type === "tool_call" && (i.status === "running" || i.status === "pending"))).toEqual([]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
  });
});

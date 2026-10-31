// For the tests: the fixtures' event streams (spec/fixtures/<harness>/<scenario>/expected.jsonl),
// and a source the test pushes events through.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialState, type Snapshot, type Thread, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import type { ThreadSource } from "../store.js";

// Not with `new URL`: jsdom has its own, which takes only http(s) URLs.
const specDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../spec/");

/** Every fixture, as "<harness>/<scenario>". */
export const fixtureNames: string[] = readdirSync(specDir + "fixtures", { withFileTypes: true })
  .filter((h) => h.isDirectory())
  .flatMap((h) => readdirSync(`${specDir}fixtures/${h.name}`).map((s) => `${h.name}/${s}`))
  .sort();

/** A fixture's expected events. */
export function fixtureEvents(name: string): ThreadEvent[] {
  return readFileSync(`${specDir}fixtures/${name}/expected.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ThreadEvent);
}

/** The thread a fixture's events start with (its first event is a thread.updated). */
export function fixtureThread(events: ThreadEvent[]): Thread {
  const first = events[0];
  if (first?.type !== "thread.updated") throw new Error("a fixture starts with thread.updated");
  return first.thread;
}

export const thread: Thread = { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" };

/** A source the test sends events through with `emit`. */
export function testSource(snapshot: Snapshot = initialState(thread), resync?: ThreadSource["resync"]) {
  const listeners = new Set<(e: ThreadEvent) => void>();
  const source: ThreadSource = {
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    ...(resync ? { resync } : {}),
  };
  return { source, emit: (...events: ThreadEvent[]) => events.forEach((e) => listeners.forEach((l) => l(e))), listeners };
}

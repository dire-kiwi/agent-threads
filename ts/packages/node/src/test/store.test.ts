// Every built-in store passes spec/conformance/store.json, as spec/conformance/store.md says to run
// it; and the JSONL store copes with a crash mid-write.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Thread } from "@dire-kiwi/agent-threads-protocol";
import { StoreError, type Store } from "../store.js";
import { FileStore } from "../stores/file.js";
import { MemoryState, MemoryStore } from "../stores/memory.js";
import { SqliteStore } from "../stores/sqlite.js";
import { readJson, tempDir } from "./spec.js";

interface Step {
  op: string;
  args?: unknown[];
  result?: unknown;
  error?: string;
}
interface Case {
  name: string;
  persistent?: boolean;
  steps: Step[];
}
const suite = readJson("conformance/store.json") as { values: Record<string, unknown>; cases: Case[] };

/** {"$": "NAME"} replaced with a copy of the value NAME. */
function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$ === "string") return structuredClone(suite.values[o.$]);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
}

/** A way to open a store, and to open it again on the same data. */
interface Kind {
  name: string;
  persistent: boolean;
  open(): { store: Store; reopen(): Promise<Store> };
}

const kinds: Kind[] = [
  {
    name: "MemoryStore",
    persistent: false,
    open() {
      const state = new MemoryState();
      return { store: new MemoryStore(state), reopen: async () => new MemoryStore(state) };
    },
  },
  {
    name: "FileStore",
    persistent: true,
    open() {
      const dir = tempDir();
      let store = new FileStore(dir);
      return {
        store,
        async reopen() {
          await store.close();
          return (store = new FileStore(dir));
        },
      };
    },
  },
  {
    name: "SqliteStore",
    persistent: true,
    open() {
      const path = join(tempDir(), "threads.db");
      let store = new SqliteStore(path);
      return {
        store,
        async reopen() {
          await store.close();
          return (store = new SqliteStore(path));
        },
      };
    },
  },
];

describe.each(kinds)("$name", (kind) => {
  it.each(suite.cases.filter((c) => kind.persistent || !c.persistent))("$name", async (c) => {
    const opened = kind.open();
    let store = opened.store;
    try {
      for (const [i, step] of c.steps.entries()) {
        const where = `step ${i + 1} (${step.op})`;
        if (step.op === "reopen") {
          store = await opened.reopen();
          continue;
        }
        let result: unknown;
        let error: string | undefined;
        try {
          const op = (store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.op]!;
          result = await op.apply(store, resolve(step.args ?? []) as unknown[]);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          error = e.kind;
        }
        if ("error" in step) expect(error, `${where}: expected a ${step.error} error`).toBe(step.error);
        else {
          expect(error, `${where}: unexpected ${error} error`).toBeUndefined();
          expect(result ?? null, where).toEqual(resolve(step.result ?? null));
        }
      }
    } finally {
      await store.close?.();
    }
  });
});

describe("FileStore", () => {
  const thread: Thread = { id: "th_1", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" };
  const event = (seq: number) => ({ type: "turn.started" as const, thread_id: "th_1", seq, turn_id: `t${seq}` });

  it("drops a half-written last line, and appends after it", async () => {
    const dir = tempDir();
    const a = new FileStore(dir);
    await a.createThread(thread);
    await a.appendEvents("th_1", [event(1)]);
    await a.close();
    const [file] = readdirSync(dir);
    appendFileSync(join(dir, file!), '{"events":[{"type":"turn.sta');

    const b = new FileStore(dir);
    expect(await b.lastSeq("th_1")).toBe(1);
    await b.appendEvents("th_1", [event(2)]);
    await b.close();
    expect(readFileSync(join(dir, file!), "utf8").endsWith("\n")).toBe(true);
    expect((await new FileStore(dir).readEvents("th_1")).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps one file per thread, named for it", async () => {
    const dir = tempDir();
    const s = new FileStore(dir);
    await s.createThread({ ...thread, id: "a/b" });
    await s.createThread({ ...thread, id: "c" });
    await s.close();
    expect(readdirSync(dir).sort()).toEqual(["a%2Fb.jsonl", "c.jsonl"]);
  });
});

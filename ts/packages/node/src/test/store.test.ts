// Every built-in store passes spec/conformance/store.json, as spec/conformance/store.md says to run
// it; and the JSONL store copes with a crash mid-write.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
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

  it("keeps a run moved to another thread there after it's reopened", async () => {
    const dir = tempDir();
    const a = new FileStore(dir);
    for (const id of ["z", "a"]) await a.createThread({ ...thread, id });
    const run = { id: "r", thread_id: "z", spawner: "shim", started_at: "2026-11-01T00:00:01Z" };
    await a.putRun(run);
    await a.putRun({ ...run, thread_id: "a", started_at: "2026-11-01T00:00:02Z" });
    await a.putRun({ ...run, thread_id: "z", started_at: "2026-11-01T00:00:03Z" });
    await a.putRun({ ...run, thread_id: "a", started_at: "2026-11-01T00:00:04Z" });
    await a.close();
    const b = new FileStore(dir);
    expect(await b.getRun("r")).toEqual({ ...run, thread_id: "a", started_at: "2026-11-01T00:00:04Z" });
    await b.deleteThread("z");
    await b.close();
    expect(await new FileStore(dir).activeRuns()).toEqual([{ ...run, thread_id: "a", started_at: "2026-11-01T00:00:04Z" }]);
  });

  /** Runs `fn` with FileHandle's `method` replaced (on every handle) by `fake`. */
  async function patched<K extends "write" | "datasync">(method: K, fake: (original: FileHandle[K]) => FileHandle[K], fn: () => Promise<void>) {
    const probe = await open(join(tempDir(), "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const original = proto[method];
    proto[method] = fake(original);
    try {
      await fn();
    } finally {
      proto[method] = original;
    }
  }

  it("leaves nothing of an append whose sync fails, so trying it again doesn't repeat it", async () => {
    const dir = tempDir();
    const s = new FileStore(dir);
    await s.createThread(thread);
    let fail = true;
    await patched(
      "datasync",
      (original) =>
        async function (this: FileHandle) {
          if (fail) {
            fail = false;
            throw new Error("EIO");
          }
          return original.call(this);
        },
      async () => {
        await expect(s.appendEvents("th_1", [event(1)])).rejects.toThrow("EIO");
        expect(await s.lastSeq("th_1")).toBe(0);
        await s.appendEvents("th_1", [event(1)]);
      },
    );
    await s.appendEvents("th_1", [event(2)]);
    await s.close();
    const lines = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l).events?.[0]?.seq ?? "thread")).toEqual(["thread", 1, 2]);
    const again = new FileStore(dir);
    expect((await again.readEvents("th_1")).map((e) => e.seq)).toEqual([1, 2]);
    expect(await again.readEvents("th_1", { after: 1 })).toEqual([event(2)]);
  });

  it("writes every byte of a line the file takes a few at a time", async () => {
    const dir = tempDir();
    const s = new FileStore(dir);
    const big = { ...event(1), turn_id: "t".repeat(10_000) };
    await patched(
      "write",
      (original) =>
        function (this: FileHandle, buffer: Buffer, offset: number, length: number) {
          return (original as (b: Buffer, o: number, l: number) => Promise<{ bytesWritten: number }>).call(this, buffer, offset, Math.min(length, 4096));
        } as FileHandle["write"],
      async () => {
        await s.createThread(thread);
        await s.appendEvents("th_1", [big]);
      },
    );
    await s.close();
    expect(await new FileStore(dir).readEvents("th_1")).toEqual([big]);
  });

  it("cuts off a line whose write fails partway, so the next one starts clean", async () => {
    const dir = tempDir();
    const s = new FileStore(dir);
    await s.createThread(thread);
    let fail = true;
    await patched(
      "write",
      (original) =>
        async function (this: FileHandle, buffer: Buffer, offset: number, length: number) {
          const write = original as (b: Buffer, o: number, l: number) => Promise<{ bytesWritten: number }>;
          if (!fail) return write.call(this, buffer, offset, length);
          fail = false;
          await write.call(this, buffer, offset, Math.floor(length / 2));
          throw new Error("EFBIG");
        } as FileHandle["write"],
      async () => {
        await expect(s.appendEvents("th_1", [event(1)])).rejects.toThrow("EFBIG");
        await s.appendEvents("th_1", [event(1)]);
      },
    );
    await s.close();
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(text.split("\n").filter(Boolean).map((l) => Object.keys(JSON.parse(l))[0])).toEqual(["thread", "events"]);
    expect((await new FileStore(dir).readEvents("th_1")).map((e) => e.seq)).toEqual([1]);
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

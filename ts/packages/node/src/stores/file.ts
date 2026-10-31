// A store in a directory, with one JSONL file per thread. Each line is a change: the thread as
// created or updated, a batch of events, a snapshot or a run. The files are read into memory when
// the store opens, and each change is appended and synced before the operation returns, so it
// survives the process being killed. A half-written last line (from a crash mid-write) is dropped.

import { mkdirSync, readdirSync, readFileSync, truncateSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot, Thread, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { checkEvents, notFound, StoreError, type ReadOptions, type RunRecord, type Store } from "../store.js";
import { MemoryState, MemoryStore } from "./memory.js";

type Line = { thread: Thread } | { events: ThreadEvent[] } | { snapshot: Snapshot } | { run: RunRecord };

const SUFFIX = ".jsonl";

export class FileStore implements Store {
  readonly dir: string;
  #mem: MemoryStore;
  #files = new Map<string, FileHandle>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.#mem = new MemoryStore(this.#load());
  }

  #path(id: string): string {
    return join(this.dir, encodeURIComponent(id) + SUFFIX);
  }

  #load(): MemoryState {
    const state = new MemoryState();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const path = join(this.dir, name);
      let text = readFileSync(path, "utf8");
      const end = text.lastIndexOf("\n") + 1;
      if (end < text.length) {
        // The last write didn't finish: it never returned, so it didn't happen.
        truncateSync(path, Buffer.byteLength(text.slice(0, end)));
        text = text.slice(0, end);
      }
      let id: string | undefined;
      for (const raw of text.split("\n")) {
        if (!raw) continue;
        const line = JSON.parse(raw) as Line;
        if ("thread" in line) {
          id = line.thread.id;
          state.threads.set(id, line.thread);
          if (!state.events.has(id)) state.events.set(id, []);
        } else if (id === undefined) {
          throw new Error(`${path} doesn't start with its thread`);
        } else if ("events" in line) {
          state.events.get(id)!.push(...line.events);
        } else if ("snapshot" in line) {
          state.snapshots.set(id, line.snapshot);
        } else if ("run" in line) {
          state.runs.set(line.run.id, line.run);
        }
      }
    }
    return state;
  }

  /** Runs `op` after every operation before it, so each one is atomic. */
  #serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #append(id: string, line: Line): Promise<void> {
    let file = this.#files.get(id);
    if (!file) {
      file = await open(this.#path(id), "a");
      this.#files.set(id, file);
    }
    await file.write(JSON.stringify(line) + "\n");
    await file.datasync();
  }

  #known(id: string): void {
    if (!this.#mem.state.threads.has(id)) throw notFound(id);
  }

  createThread(thread: Thread): Promise<void> {
    return this.#serial(async () => {
      if (this.#mem.state.threads.has(thread.id)) throw new StoreError("exists", `thread ${thread.id} exists`);
      await this.#append(thread.id, { thread });
      await this.#mem.createThread(thread);
    });
  }

  getThread(id: string): Promise<Thread | null> {
    return this.#mem.getThread(id);
  }

  listThreads(): Promise<Thread[]> {
    return this.#mem.listThreads();
  }

  updateThread(thread: Thread): Promise<void> {
    return this.#serial(async () => {
      this.#known(thread.id);
      await this.#append(thread.id, { thread });
      await this.#mem.updateThread(thread);
    });
  }

  deleteThread(id: string): Promise<boolean> {
    return this.#serial(async () => {
      if (!this.#mem.state.threads.has(id)) return false;
      await this.#files.get(id)?.close();
      this.#files.delete(id);
      await unlink(this.#path(id));
      return this.#mem.deleteThread(id);
    });
  }

  appendEvents(id: string, events: ThreadEvent[]): Promise<void> {
    return this.#serial(async () => {
      checkEvents(id, await this.#mem.lastSeq(id), events);
      if (!events.length) return;
      await this.#append(id, { events });
      await this.#mem.appendEvents(id, events);
    });
  }

  readEvents(id: string, options?: ReadOptions): Promise<ThreadEvent[]> {
    return this.#mem.readEvents(id, options);
  }

  lastSeq(id: string): Promise<number> {
    return this.#mem.lastSeq(id);
  }

  saveSnapshot(id: string, snapshot: Snapshot): Promise<void> {
    return this.#serial(async () => {
      this.#known(id);
      await this.#append(id, { snapshot });
      await this.#mem.saveSnapshot(id, snapshot);
    });
  }

  loadSnapshot(id: string): Promise<Snapshot | null> {
    return this.#mem.loadSnapshot(id);
  }

  putRun(run: RunRecord): Promise<void> {
    return this.#serial(async () => {
      this.#known(run.thread_id);
      await this.#append(run.thread_id, { run });
      await this.#mem.putRun(run);
    });
  }

  getRun(id: string): Promise<RunRecord | null> {
    return this.#mem.getRun(id);
  }

  activeRuns(): Promise<RunRecord[]> {
    return this.#mem.activeRuns();
  }

  close(): Promise<void> {
    return this.#serial(async () => {
      const files = [...this.#files.values()];
      this.#files.clear();
      await Promise.all(files.map((f) => f.close()));
    });
  }
}

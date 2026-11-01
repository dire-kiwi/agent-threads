// A store in a directory, with one JSONL file per thread. Each line is a change: the thread as
// created or updated, a batch of events, a snapshot or a run. The files are read into memory when
// the store opens, and each change is appended and synced before the operation returns, so it
// survives the process being killed. A write that fails is cut off the file again, so a failed
// operation leaves nothing behind; a half-written last line (from a crash mid-write) is dropped.

import { mkdirSync, readdirSync, readFileSync, truncateSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot, Thread, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { checkEvents, notFound, StoreError, type ReadOptions, type RunRecord, type Store } from "../store.js";
import { MemoryState, MemoryStore } from "./memory.js";

// A run's lines carry a revision, counted across the store, since a run moved to another thread is
// in two files: the latest of its lines says where it is (or, if it's `run_moved`, that it's gone).
// Events appended with runs (appendEvents' `runs`) are one line, so they're written together or not at all.
type Line =
  | { thread: Thread }
  | { events: ThreadEvent[]; runs?: { run: RunRecord; rev: number }[] }
  | { snapshot: Snapshot }
  | { run: RunRecord; rev?: number }
  | { run_moved: string; rev?: number };

const SUFFIX = ".jsonl";

export class FileStore implements Store {
  readonly dir: string;
  #mem: MemoryStore;
  #files = new Map<string, { handle: FileHandle; size: number }>();
  #queue: Promise<unknown> = Promise.resolve();
  #rev = 0;
  /** Why a failed write couldn't be undone, after which nothing more is written until a reopen. */
  #broken: { error: unknown } | undefined;

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
    const runs = new Map<string, { run: RunRecord | null; rev: number }>(); // each run's latest line
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
      const mine = new Map<string, { run: RunRecord | null; rev: number }>(); // this file's, as its lines leave them
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
          const log = state.events.get(id)!;
          for (const e of line.events) if (e.seq > (log[log.length - 1]?.seq ?? 0)) log.push(e);
          for (const r of line.runs ?? []) mine.set(r.run.id, { run: r.run, rev: r.rev });
        } else if ("snapshot" in line) {
          state.snapshots.set(id, line.snapshot);
        } else if ("run" in line) {
          mine.set(line.run.id, { run: line.run, rev: line.rev ?? 0 });
        } else if ("run_moved" in line) {
          mine.set(line.run_moved, { run: null, rev: line.rev ?? 0 });
        }
      }
      for (const [rid, r] of mine) {
        this.#rev = Math.max(this.#rev, r.rev);
        if (r.rev >= (runs.get(rid)?.rev ?? -1)) runs.set(rid, r);
      }
    }
    for (const [rid, r] of runs) if (r.run) state.runs.set(rid, r.run);
    return state;
  }

  /** Runs `op` after every operation before it, so each one is atomic. */
  #serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #file(id: string): Promise<{ handle: FileHandle; size: number }> {
    let file = this.#files.get(id);
    if (!file) {
      const handle = await open(this.#path(id), "a");
      file = { handle, size: (await handle.stat()).size };
      this.#files.set(id, file);
    }
    return file;
  }

  /**
   * Appends lines (to one thread's file or several), all or none: each is written in full and
   * synced, and if one fails, what was written is cut off again.
   */
  async #append(...lines: [id: string, line: Line][]): Promise<void> {
    if (this.#broken) throw new Error(`the store can't be written to until it's opened again: a failed write couldn't be undone (${message(this.#broken.error)})`);
    const written: { file: { handle: FileHandle; size: number }; size: number }[] = [];
    try {
      for (const [id, line] of lines) {
        const file = await this.#file(id);
        written.push({ file, size: file.size });
        const bytes = Buffer.from(JSON.stringify(line) + "\n");
        for (let at = 0; at < bytes.length; ) {
          const { bytesWritten } = await file.handle.write(bytes, at, bytes.length - at);
          if (bytesWritten <= 0) throw new Error("the file took no more bytes");
          at += bytesWritten;
        }
        await file.handle.datasync();
        file.size += bytes.length;
      }
    } catch (e) {
      for (const { file, size } of written.reverse()) {
        try {
          await file.handle.truncate(size);
          await file.handle.datasync();
          file.size = size;
        } catch (undo) {
          this.#broken = { error: undo };
        }
      }
      throw e;
    }
  }

  #known(id: string): void {
    if (!this.#mem.state.threads.has(id)) throw notFound(id);
  }

  createThread(thread: Thread): Promise<void> {
    return this.#serial(async () => {
      if (this.#mem.state.threads.has(thread.id)) throw new StoreError("exists", `thread ${thread.id} exists`);
      await this.#append([thread.id, { thread }]);
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
      await this.#append([thread.id, { thread }]);
      await this.#mem.updateThread(thread);
    });
  }

  deleteThread(id: string): Promise<boolean> {
    return this.#serial(async () => {
      if (!this.#mem.state.threads.has(id)) return false;
      await this.#files.get(id)?.handle.close();
      this.#files.delete(id);
      await unlink(this.#path(id));
      return this.#mem.deleteThread(id);
    });
  }

  appendEvents(id: string, events: ThreadEvent[], runs: RunRecord[] = []): Promise<void> {
    return this.#serial(async () => {
      checkEvents(id, await this.#mem.lastSeq(id), events, runs);
      if (!events.length && !runs.length) return;
      const moves = runs.map((run) => this.#moved(run));
      let rev = this.#rev;
      const lines: [string, Line][] = [];
      const revs: { run: RunRecord; rev: number }[] = [];
      for (const [i, run] of runs.entries()) {
        const from = moves[i];
        if (from) lines.push([from, { run_moved: run.id, rev: ++rev }]);
        revs.push({ run, rev: ++rev });
      }
      await this.#append(...lines, [id, { events, ...(revs.length ? { runs: revs } : {}) }]);
      this.#rev = rev;
      await this.#mem.appendEvents(id, events, runs);
    });
  }

  /** The thread a run was in before, if putting it in another moves it out of that one's file. */
  #moved(run: RunRecord): string | undefined {
    const before = this.#mem.state.runs.get(run.id);
    return before && before.thread_id !== run.thread_id && this.#mem.state.threads.has(before.thread_id) ? before.thread_id : undefined;
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
      await this.#append([id, { snapshot }]);
      await this.#mem.saveSnapshot(id, snapshot);
    });
  }

  loadSnapshot(id: string): Promise<Snapshot | null> {
    return this.#mem.loadSnapshot(id);
  }

  putRun(run: RunRecord): Promise<void> {
    return this.#serial(async () => {
      this.#known(run.thread_id);
      const moved = this.#moved(run);
      const rev = this.#rev + (moved ? 2 : 1);
      await this.#append(...(moved ? [[moved, { run_moved: run.id, rev: rev - 1 }] as [string, Line]] : []), [run.thread_id, { run, rev }]);
      this.#rev = rev;
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
      await Promise.all(files.map((f) => f.handle.close()));
    });
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

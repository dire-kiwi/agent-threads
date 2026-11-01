// A store in memory: for tests, demos, and apps that don't keep threads.

import type { Snapshot, Thread, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { byStart, checkEvents, isActive, notFound, StoreError, type ReadOptions, type RunRecord, type Store } from "../store.js";

/** Everything a MemoryStore holds. Another MemoryStore made on it sees the same threads. */
export class MemoryState {
  threads = new Map<string, Thread>();
  events = new Map<string, ThreadEvent[]>();
  snapshots = new Map<string, Snapshot>();
  runs = new Map<string, RunRecord>();
}

const copy = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  readonly state: MemoryState;

  constructor(state: MemoryState = new MemoryState()) {
    this.state = state;
  }

  #log(id: string): ThreadEvent[] {
    const log = this.state.events.get(id);
    if (!log) throw notFound(id);
    return log;
  }

  async createThread(thread: Thread): Promise<void> {
    if (this.state.threads.has(thread.id)) throw new StoreError("exists", `thread ${thread.id} exists`);
    this.state.threads.set(thread.id, copy(thread));
    this.state.events.set(thread.id, []);
  }

  async getThread(id: string): Promise<Thread | null> {
    const t = this.state.threads.get(id);
    return t ? copy(t) : null;
  }

  async listThreads(): Promise<Thread[]> {
    return [...this.state.threads.values()].sort(byStart).map(copy);
  }

  async updateThread(thread: Thread): Promise<void> {
    if (!this.state.threads.has(thread.id)) throw notFound(thread.id);
    this.state.threads.set(thread.id, copy(thread));
  }

  async deleteThread(id: string): Promise<boolean> {
    if (!this.state.threads.has(id)) return false;
    this.state.threads.delete(id);
    this.state.events.delete(id);
    this.state.snapshots.delete(id);
    for (const [rid, r] of this.state.runs) if (r.thread_id === id) this.state.runs.delete(rid);
    return true;
  }

  async appendEvents(id: string, events: ThreadEvent[], runs: RunRecord[] = []): Promise<void> {
    const log = this.#log(id);
    checkEvents(id, log.length ? log[log.length - 1]!.seq : 0, events, runs);
    for (const e of events) log.push(copy(e));
    for (const r of runs) this.state.runs.set(r.id, copy(r));
  }

  async readEvents(id: string, { after = 0, limit }: ReadOptions = {}): Promise<ThreadEvent[]> {
    const log = this.#log(id);
    // Events are numbered from 1 with no gaps, so the ones after `after` start at index `after`.
    const out = log.slice(Math.max(0, after), limit === undefined ? undefined : Math.max(0, after) + limit);
    return out.map(copy);
  }

  async lastSeq(id: string): Promise<number> {
    const log = this.#log(id);
    return log.length ? log[log.length - 1]!.seq : 0;
  }

  async saveSnapshot(id: string, snapshot: Snapshot): Promise<void> {
    this.#log(id);
    this.state.snapshots.set(id, copy(snapshot));
  }

  async loadSnapshot(id: string): Promise<Snapshot | null> {
    this.#log(id);
    const s = this.state.snapshots.get(id);
    return s ? copy(s) : null;
  }

  async putRun(run: RunRecord): Promise<void> {
    if (!this.state.threads.has(run.thread_id)) throw notFound(run.thread_id);
    this.state.runs.set(run.id, copy(run));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const r = this.state.runs.get(id);
    return r ? copy(r) : null;
  }

  async activeRuns(): Promise<RunRecord[]> {
    return [...this.state.runs.values()].filter(isActive).sort(byStart).map(copy);
  }
}

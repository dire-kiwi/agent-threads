// Where threads live: their Thread, their saved events (the source of truth), a snapshot to start
// from, and the harness processes the backend started. spec/conformance/store.md says what each
// operation does; MemoryStore, FileStore and SqliteStore all pass spec/conformance/store.json, and
// an app can implement Store on its own database the same way.

import type { Snapshot, Thread, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";

/** A harness process the backend started: its own record, for a spawner to re-attach to. */
export interface RunRecord {
  id: string;
  thread_id: string;
  spawner: string;
  /** How far into the run's output the backend has read. */
  offset?: number;
  started_at: string;
  /** Set once the backend has finished with the run. */
  ended_at?: string;
  /** Anything else the backend keeps about it, stored as given. */
  data?: unknown;
  [k: string]: unknown;
}

export interface ReadOptions {
  /** Events with a seq greater than this. */
  after?: number;
  /** At most this many. */
  limit?: number;
}

export interface Store {
  /** Adds a thread, with no events. Fails with `exists` if there's one with its id. */
  createThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | null>;
  /** Every thread, oldest first by created_at, then by id. */
  listThreads(): Promise<Thread[]>;
  /** Replaces the thread with the same id, in full. Fails with `not_found`. */
  updateThread(thread: Thread): Promise<void>;
  /** Deletes the thread with its events, snapshot and runs; whether there was one. */
  deleteThread(id: string): Promise<boolean>;
  /**
   * Appends saved events, all of them or none. Each is for the thread, isn't a delta, and has the
   * seq after the one before it. With `runs` (the thread's), it puts them too, in the same atomic
   * write: a run's offset is saved with the events made from its output, so after a restart the
   * output is read again from exactly there. Fails with `not_found`, `invalid` or `seq`.
   */
  appendEvents(id: string, events: ThreadEvent[], runs?: RunRecord[]): Promise<void>;
  /** The thread's events after `after`, in order, at most `limit` of them. Fails with `not_found`. */
  readEvents(id: string, options?: ReadOptions): Promise<ThreadEvent[]>;
  /** The seq of the thread's last event, or 0. Fails with `not_found`. */
  lastSeq(id: string): Promise<number>;
  /** Keeps the snapshot, replacing the one before. Fails with `not_found`. */
  saveSnapshot(id: string, snapshot: Snapshot): Promise<void>;
  /** The last snapshot saved, or null. Fails with `not_found`. */
  loadSnapshot(id: string): Promise<Snapshot | null>;
  /** Adds the run, or replaces the one with its id. Fails with `not_found` if its thread doesn't exist. */
  putRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  /** The runs with no ended_at, oldest first by started_at, then by id. */
  activeRuns(): Promise<RunRecord[]>;
  /** Lets go of files and connections. */
  close?(): Promise<void>;
}

export type StoreErrorKind = "exists" | "not_found" | "invalid" | "seq";

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  constructor(kind: StoreErrorKind, message: string) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
  }
}

/** Checks a batch of events (and runs) for appendEvents to thread `id`, whose last seq is `last`. */
export function checkEvents(id: string, last: number, events: ThreadEvent[], runs: RunRecord[] = []): void {
  for (const r of runs) if (r.thread_id !== id) throw new StoreError("invalid", `thread ${r.thread_id}'s run appended to ${id}`);
  let seq = last;
  for (const e of events) {
    if (e.type === "delta") throw new StoreError("invalid", "deltas aren't saved");
    if (e.thread_id !== id) throw new StoreError("invalid", `an event for thread ${e.thread_id} appended to ${id}`);
    if (e.seq !== ++seq) throw new StoreError("seq", `event seq ${e.seq}, where ${seq} comes next`);
  }
}

/** Oldest first by created_at (threads) or started_at (runs), then by id. */
export function byStart(a: { id: string; created_at?: unknown; started_at?: unknown }, b: typeof a): number {
  const x = String(a.created_at ?? a.started_at ?? "");
  const y = String(b.created_at ?? b.started_at ?? "");
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const isActive = (r: RunRecord): boolean => r.ended_at === undefined || r.ended_at === null;

export const notFound = (id: string): StoreError => new StoreError("not_found", `no thread ${id}`);

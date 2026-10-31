// A store in a SQLite database, with Node's built-in node:sqlite (no native dependency). Values are
// kept as JSON text, so they come back exactly as they were given.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Snapshot, Thread, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { checkEvents, notFound, StoreError, type ReadOptions, type RunRecord, type Store } from "../store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  active INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_active ON runs (active, started_at, id);
`;

export interface SqliteStoreOptions {
  /** An open database to use instead of opening `path`; the store doesn't close it. */
  database?: DatabaseSync;
}

export class SqliteStore implements Store {
  readonly path: string;
  #db: DatabaseSync;
  #owned: boolean;
  #stmts = new Map<string, StatementSync>();

  /** `path` is the database file (created if it doesn't exist), or ":memory:". */
  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.path = path;
    if (options.database) {
      this.#db = options.database;
      this.#owned = false;
    } else {
      // Loaded here rather than imported, so only apps that use SQLite load it.
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      this.#db = new sqlite.DatabaseSync(path);
      this.#owned = true;
    }
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  #q(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  #known(id: string): void {
    if (!this.#q("SELECT 1 FROM threads WHERE id = ?").get(id)) throw notFound(id);
  }

  #last(id: string): number {
    const row = this.#q("SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?").get(id) as { seq: number | null };
    return Number(row.seq ?? 0);
  }

  async createThread(thread: Thread): Promise<void> {
    this.#tx(() => {
      if (this.#q("SELECT 1 FROM threads WHERE id = ?").get(thread.id)) {
        throw new StoreError("exists", `thread ${thread.id} exists`);
      }
      this.#q("INSERT INTO threads (id, created_at, data) VALUES (?, ?, ?)").run(thread.id, String(thread.created_at ?? ""), JSON.stringify(thread));
    });
  }

  async getThread(id: string): Promise<Thread | null> {
    const row = this.#q("SELECT data FROM threads WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  async listThreads(): Promise<Thread[]> {
    const rows = this.#q("SELECT data FROM threads ORDER BY created_at, id").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async updateThread(thread: Thread): Promise<void> {
    const r = this.#q("UPDATE threads SET created_at = ?, data = ? WHERE id = ?").run(String(thread.created_at ?? ""), JSON.stringify(thread), thread.id);
    if (!Number(r.changes)) throw notFound(thread.id);
  }

  async deleteThread(id: string): Promise<boolean> {
    return this.#tx(() => {
      // Spelled out rather than left to ON DELETE CASCADE, for a database opened without foreign keys.
      for (const table of ["events", "snapshots", "runs"]) this.#q(`DELETE FROM ${table} WHERE thread_id = ?`).run(id);
      return Number(this.#q("DELETE FROM threads WHERE id = ?").run(id).changes) > 0;
    });
  }

  async appendEvents(id: string, events: ThreadEvent[]): Promise<void> {
    this.#tx(() => {
      this.#known(id);
      checkEvents(id, this.#last(id), events);
      const insert = this.#q("INSERT INTO events (thread_id, seq, data) VALUES (?, ?, ?)");
      for (const e of events) insert.run(id, e.seq, JSON.stringify(e));
    });
  }

  async readEvents(id: string, { after = 0, limit }: ReadOptions = {}): Promise<ThreadEvent[]> {
    this.#known(id);
    const rows = this.#q("SELECT data FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(id, after, limit ?? -1) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async lastSeq(id: string): Promise<number> {
    this.#known(id);
    return this.#last(id);
  }

  async saveSnapshot(id: string, snapshot: Snapshot): Promise<void> {
    this.#known(id);
    this.#q("INSERT INTO snapshots (thread_id, data) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET data = excluded.data").run(
      id,
      JSON.stringify(snapshot),
    );
  }

  async loadSnapshot(id: string): Promise<Snapshot | null> {
    this.#known(id);
    const row = this.#q("SELECT data FROM snapshots WHERE thread_id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  async putRun(run: RunRecord): Promise<void> {
    this.#known(run.thread_id);
    this.#q(
      `INSERT INTO runs (id, thread_id, started_at, active, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at, active = excluded.active, data = excluded.data`,
    ).run(run.id, run.thread_id, String(run.started_at ?? ""), run.ended_at == null ? 1 : 0, JSON.stringify(run));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = this.#q("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  async activeRuns(): Promise<RunRecord[]> {
    const rows = this.#q("SELECT data FROM runs WHERE active = 1 ORDER BY started_at, id").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async close(): Promise<void> {
    this.#stmts.clear();
    if (this.#owned && this.#db.isOpen) this.#db.close();
  }
}

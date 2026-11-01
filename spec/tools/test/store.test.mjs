// spec/conformance/store.json holds together: a reference in-memory store, written from
// spec/conformance/store.md, passes every case. It also shows the shape of a backend's runner.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const suite = JSON.parse(readFileSync(new URL("../../conformance/store.json", import.meta.url), "utf8"));

class StoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const copy = (v) => structuredClone(v);
const byStart = (a, b) => (a.created_at ?? a.started_at).localeCompare(b.created_at ?? b.started_at) || a.id.localeCompare(b.id);

/** The reference store. Its state is a plain object, so "reopening" it keeps everything. */
class MemoryStore {
  constructor(state = { threads: new Map(), events: new Map(), snapshots: new Map(), runs: new Map() }) {
    this.s = state;
  }
  #known(id) {
    if (!this.s.threads.has(id)) throw new StoreError("not_found", `no thread ${id}`);
  }
  createThread(t) {
    if (this.s.threads.has(t.id)) throw new StoreError("exists", `thread ${t.id} exists`);
    this.s.threads.set(t.id, copy(t));
    this.s.events.set(t.id, []);
    return null;
  }
  getThread(id) {
    return this.s.threads.has(id) ? copy(this.s.threads.get(id)) : null;
  }
  listThreads() {
    return [...this.s.threads.values()].sort(byStart).map(copy);
  }
  updateThread(t) {
    this.#known(t.id);
    this.s.threads.set(t.id, copy(t));
    return null;
  }
  deleteThread(id) {
    if (!this.s.threads.has(id)) return false;
    for (const m of [this.s.threads, this.s.events, this.s.snapshots]) m.delete(id);
    for (const [rid, r] of this.s.runs) if (r.thread_id === id) this.s.runs.delete(rid);
    return true;
  }
  appendEvents(id, events, runs = []) {
    this.#known(id);
    for (const r of runs) if (r.thread_id !== id) throw new StoreError("invalid", `a run of ${r.thread_id}`);
    const log = this.s.events.get(id);
    let seq = log.length;
    for (const e of events) {
      if (e.type === "delta") throw new StoreError("invalid", "deltas aren't saved");
      if (e.thread_id !== id) throw new StoreError("invalid", `an event for ${e.thread_id}`);
      if (e.seq !== ++seq) throw new StoreError("seq", `seq ${e.seq}, not ${seq}`);
    }
    log.push(...events.map(copy));
    for (const r of runs) this.s.runs.set(r.id, copy(r));
    return null;
  }
  readEvents(id, { after = 0, limit } = {}) {
    this.#known(id);
    const out = this.s.events.get(id).filter((e) => e.seq > after);
    return copy(limit === undefined ? out : out.slice(0, limit));
  }
  lastSeq(id) {
    this.#known(id);
    return this.s.events.get(id).length;
  }
  saveSnapshot(id, snap) {
    this.#known(id);
    this.s.snapshots.set(id, copy(snap));
    return null;
  }
  loadSnapshot(id) {
    this.#known(id);
    return this.s.snapshots.has(id) ? copy(this.s.snapshots.get(id)) : null;
  }
  putRun(r) {
    this.#known(r.thread_id);
    this.s.runs.set(r.id, copy(r));
    return null;
  }
  getRun(id) {
    return this.s.runs.has(id) ? copy(this.s.runs.get(id)) : null;
  }
  activeRuns() {
    return [...this.s.runs.values()].filter((r) => !r.ended_at).sort(byStart).map(copy);
  }
}

/** Replace {"$": "NAME"} with the suite's value NAME. */
const resolve = (v) => {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && typeof v.$ === "string") return copy(suite.values[v.$]);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
};

for (const c of suite.cases) {
  test(c.name, () => {
    let store = new MemoryStore();
    for (const [i, step] of c.steps.entries()) {
      const where = `step ${i + 1} (${step.op})`;
      if (step.op === "reopen") {
        store = new MemoryStore(store.s);
        continue;
      }
      let result;
      let error;
      try {
        result = store[step.op](...resolve(step.args));
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        error = e.kind;
      }
      if ("error" in step) assert.equal(error, step.error, `${where}: expected a ${step.error} error`);
      else {
        assert.equal(error, undefined, `${where}: unexpected ${error} error`);
        assert.deepEqual(result, resolve(step.result), where);
      }
    }
  });
}

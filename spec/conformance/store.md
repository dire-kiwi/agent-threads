# Store conformance

Every backend has a `Store` interface with three implementations built in (Memory, a JSONL file
store and SQLite), and apps can write their own on their database. They all have to behave the
same, so they all pass the cases in [store.json](store.json). This is what the operations are and
how a test runs the cases. [../tools/test/store.test.mjs](../tools/test/store.test.mjs) has a
reference in-memory store and runner that pass them.

## What a store holds

- **Threads**: each thread's `Thread` (as in the protocol), by id.
- **Events**: each thread's saved events (every event but `delta`), in `seq` order. They're the
  source of truth: a thread's state is what folding its events gives.
- **A snapshot** per thread, optionally: the latest one the backend saved, so it needn't fold every
  event again when it starts.
- **Runs**: the harness processes the backend started, for the shim spawner to re-attach to after a
  restart. A run is the backend's own record, not a protocol type:

  ```json
  {"id": "run_1", "thread_id": "th_1", "spawner": "shim", "offset": 18342,
   "started_at": "2026-11-01T00:00:01Z", "ended_at": "2026-11-01T00:05:00Z", "data": {"dir": "..."}}
  ```

  `offset` is how far into the run's `out.jsonl` the backend has read; `ended_at` is set once it
  has finished with the run; `data` is anything else the backend keeps about it, stored as given.

A store keeps every value exactly as it was given: fields it doesn't know (a newer backend's, the
app's `metadata`, `raw` payloads), unicode, numbers, nesting and `null`s. What's read back is equal
to what was written, as JSON (key order aside).

## Operations

Named here as in `store.json`; each backend names them idiomatically (`append_events` in Rust,
`AppendEvents` in Go) and may make them async. "Fails with `x`" means it returns or throws the
store's error of kind `x`, which each backend maps from its own error type.

| Operation | Does | Fails with |
| --- | --- | --- |
| `createThread(thread)` | Adds a thread, with no events. | `exists` if there's one with its id. |
| `getThread(id)` | The thread, or `null`. | |
| `listThreads()` | All threads, oldest first by `created_at`, then by `id`. | |
| `updateThread(thread)` | Replaces the thread with the same id (in full: fields it doesn't have any more are gone). | `not_found` |
| `deleteThread(id)` | Deletes the thread, its events, its snapshot and its runs. `true` if there was one, `false` if not. | |
| `appendEvents(id, events)` | Appends saved events, all of them or none. Each must be for the thread (`thread_id`), not a `delta`, and have the `seq` after the one before it (the first after `lastSeq`). An empty list does nothing. | `not_found`; `invalid` for a delta or another thread's event; `seq` for a gap or a repeat. |
| `readEvents(id, {after, limit?})` | The thread's events with `seq` greater than `after`, in order, at most `limit` of them. | `not_found` |
| `lastSeq(id)` | The `seq` of the thread's last event; 0 if it has none. | `not_found` |
| `saveSnapshot(id, snapshot)` | Keeps the snapshot, replacing the one before. | `not_found` |
| `loadSnapshot(id)` | The last snapshot saved, or `null`. | `not_found` |
| `putRun(run)` | Adds the run, or replaces the one with its id. | `not_found` if its thread doesn't exist. |
| `getRun(id)` | The run, or `null`. | |
| `activeRuns()` | The runs with no `ended_at`, oldest first by `started_at`, then by `id`. | |

Checks happen in the order listed under "Fails with": an `appendEvents` to a thread that doesn't
exist fails with `not_found`, whatever its events.

Besides what the cases can check:

- **Concurrency.** A store may be used from several tasks or threads at once. Each operation is
  atomic, and `appendEvents` to one thread are serialized (two can't both take the same `seq`).
- **Durability** (JSONL, SQLite). Once `appendEvents` or `putRun` returns, the data survives the
  process being killed. A JSONL store that finds a half-written last line when it opens (from a
  crash mid-write) ignores that line rather than failing.
- **Deleting** frees the id: a thread created again with it starts with no events, snapshot or runs.

## Running the cases

`store.json` has `values` (threads, events, snapshots and runs, by name) and `cases`. A test runs
each case on a new, empty store:

1. For each step, replace every `{"$": "NAME"}` in its `args` and `result` with a copy of the value
   `NAME`.
2. Call `op` with the `args`. `reopen` (no args) closes the store and opens it again on the same
   file or database; the Memory store passes it the same in-memory state, or skips cases with
   `"persistent": true`.
3. If the step has `error`, the call must fail with that kind. Otherwise it must succeed, and return
   a value equal to `result` (as JSON; `null` for operations that return nothing).

The cases are written so a store has no choices to make: every result is fully determined.

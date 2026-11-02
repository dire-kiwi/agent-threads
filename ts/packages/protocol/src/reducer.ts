// A thread's state, folded from its events. The Node backend keeps snapshots with it and React
// renders from it, so both agree on what a thread is.
//
// It never changes the state it's given. What an event leaves as it was keeps its identity: an
// event about one item makes a new items array holding a new object for that item, and every
// other item is the same object as before, so a UI row showing it needn't redraw. An event that
// changes nothing returns the state itself.

import type { Item, Snapshot, Thread, ThreadEvent, ThreadRequest } from "./generated.js";

/** A thread's state before any of its events. */
export function initialState(thread: Thread): Snapshot {
  return { thread, items: [], requests: [], seq: 0 };
}

/**
 * The state after `event`. Events for another thread, and saved events the state already has
 * (seq at or below state.seq, e.g. replayed after a reconnect), change nothing.
 */
export function applyEvent(state: Snapshot, event: ThreadEvent): Snapshot {
  if (event.thread_id !== state.thread.id) return state;
  if (event.type === "delta") {
    // A delta from before the last saved event the state has is already in it.
    if (event.seq < state.seq || !event.text) return state;
    return withItem(state, event.item_id, (item) => {
      if (item.type !== (event.kind === "text" ? "assistant_message" : "reasoning")) return item;
      // The text from offset on. Some of it may be in already (a snapshot taken after the delta
      // was sent has it), and the rest is appended. One past the end of the text means deltas
      // were missed: it's skipped, and the item's final text puts it right.
      const have = item.text.length - event.offset;
      if (have < 0 || have >= event.text.length) return item;
      return { ...item, text: item.text + event.text.slice(have) };
    });
  }
  if (event.seq <= state.seq) return state;
  const next = apply(state, event);
  return { ...next, seq: event.seq };
}

/** The requests that are open: those not resolved yet. */
export function openRequests(state: Pick<Snapshot, "requests">): ThreadRequest[] {
  return state.requests.filter((r) => !r.resolution);
}

/** The state after each of `events` in turn. */
export function applyEvents(state: Snapshot, events: Iterable<ThreadEvent>): Snapshot {
  for (const event of events) state = applyEvent(state, event);
  return state;
}

/**
 * Whether `event` shows that saved events before it were missed: it's saved, and its seq is more
 * than one past the state's. A client that sees one should catch up from state.seq, or take a
 * fresh snapshot, rather than apply it.
 */
export function isGap(state: Snapshot, event: ThreadEvent): boolean {
  return event.type !== "delta" && event.thread_id === state.thread.id && event.seq > state.seq + 1;
}

function apply(state: Snapshot, event: Exclude<ThreadEvent, { type: "delta" }>): Snapshot {
  switch (event.type) {
    case "thread.updated":
      return { ...state, thread: event.thread };
    case "turn.started":
    case "turn.completed":
      return state;
    case "item.added": {
      const at = indexOf(state.items, event.item.id);
      return { ...state, items: at < 0 ? [...state.items, event.item] : replace(state.items, at, event.item) };
    }
    case "item.updated":
      return withItem(state, event.item_id, (item) => patched(item, event.patch));
    case "request.opened": {
      const at = indexOf(state.requests, event.request.id);
      return {
        ...state,
        requests: at < 0 ? [...state.requests, event.request] : replace(state.requests, at, event.request),
      };
    }
    case "request.resolved": {
      // It stays, with its resolution, so a UI can show how it was answered.
      const at = indexOf(state.requests, event.request_id);
      if (at < 0) return state;
      return { ...state, requests: replace(state.requests, at, { ...state.requests[at]!, resolution: event.resolution }) };
    }
    default:
      // A newer backend's event type: there's nothing to do with it but count it.
      return state;
  }
}

/** The state with the item `id` changed by `change`; the state itself if there's none, or `change` returns it as it was. */
function withItem(state: Snapshot, id: string, change: (item: Item) => Item): Snapshot {
  const at = indexOf(state.items, id);
  if (at < 0) return state;
  const item = state.items[at]!;
  const next = change(item);
  return next === item ? state : { ...state, items: replace(state.items, at, next) };
}

/** The item with patch's fields set, and those set to null removed. id and type stay. */
function patched(item: Item, patch: { [k: string]: unknown }): Item {
  const fields = item as unknown as Record<string, unknown>;
  const changes = Object.entries(patch).filter(
    ([k, v]) => k !== "id" && k !== "type" && (v === null ? k in fields : fields[k] !== v),
  );
  if (!changes.length) return item;
  const next = { ...fields };
  for (const [k, v] of changes) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as unknown as Item;
}

// Updates are nearly always to recent items and requests, so look from the end.
function indexOf(list: readonly (Item | ThreadRequest)[], id: string): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === id) return i;
  return -1;
}

function replace<T>(list: readonly T[], at: number, value: T): T[] {
  const next = list.slice();
  next[at] = value;
  return next;
}

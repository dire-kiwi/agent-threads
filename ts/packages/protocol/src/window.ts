// Windows of a thread's state, and pages of the items before them (spec/PROTOCOL.md, "Windows"): a
// thread can run to thousands of items, so a client starts from its last ones and loads earlier
// ones a page at a time. Items are only ever added at the end of the list, so an item's index in it
// never changes, and windows and pages say where they are by index.

import type { Item, ItemPage, Snapshot, ThreadRequest } from "./generated.js";

/**
 * The window of `state` with its last `limit` items, and what they need from before them: the
 * subagent calls they and the open requests belong to, the open requests' tool calls, and the
 * subagents still running (which may go on adding items to the window), with their own. Without
 * a limit, or with one it's within, it's the state itself. `state` must be whole (not a window).
 */
export function snapshotWindow(state: Snapshot, limit?: number): Snapshot {
  const items = state.items;
  if (limit === undefined || items.length <= limit) return state;
  const start = items.length - Math.max(0, Math.floor(limit));
  const at = indices(items);
  const need = new Set<string>();
  for (let i = start; i < items.length; i++) need.add(items[i]!.parent_id ?? "");
  for (const r of state.requests) {
    if (r.resolution) continue;
    need.add(r.parent_id ?? "");
    need.add(r.tool_call_id ?? "");
  }
  // A subagent that's quiet now may go on: its items would come with no call to hang them from.
  for (let i = 0; i < start; i++) if (isRunningSubagent(items[i]!)) need.add(items[i]!.id);
  const context = contextOf(items, at, need, start);
  return {
    thread: state.thread,
    items: [...context.map((i) => items[i]!), ...items.slice(start)],
    requests: state.requests.filter((r) => {
      if (!r.resolution) return true;
      const a = anchor(items, at, r);
      return a < 0 || a >= start;
    }),
    seq: state.seq,
    ...(start ? { start } : {}),
    ...(context.length ? { context } : {}),
  };
}

/**
 * The page of `state`'s items before index `before` (a window's start), at most `limit` of them,
 * with what they need from before them (the subagent calls they belong to) and the requests they
 * have. `state` must be whole.
 */
export function itemPage(state: Snapshot, before: number, limit: number): ItemPage {
  const items = state.items;
  const end = Math.max(0, Math.min(Math.floor(before), items.length));
  const start = Math.max(0, end - Math.max(0, Math.floor(limit)));
  const at = indices(items);
  const need = new Set<string>();
  for (let i = start; i < end; i++) need.add(items[i]!.parent_id ?? "");
  const context = contextOf(items, at, need, start);
  return {
    thread_id: state.thread.id,
    items: [...context.map((i) => items[i]!), ...items.slice(start, end)],
    requests: state.requests.filter((r) => {
      const a = anchor(items, at, r);
      return a >= start && a < end;
    }),
    start,
    context,
    seq: state.seq,
  };
}

/**
 * `state` (a window) with `page`, the page before its start, put in front of its items: the
 * context items of both in order (the page's version of one they share), less those the page's own
 * items have, then the page's items, then its own. The page's requests go in front of its own, the
 * page's version of one it has replacing it in place. A page for another thread, or that doesn't
 * end at its start, changes nothing.
 */
export function withPage(state: Snapshot, page: ItemPage): Snapshot {
  const before = state.start ?? 0;
  const own = state.context ?? [];
  const theirs = page.context ?? [];
  const body = page.items.slice(theirs.length);
  if (page.thread_id !== state.thread.id || !before || page.start + body.length !== before || page.start >= before) return state;
  const fresh = new Set(body.map((i) => i.id));
  const ctx = new Map<number, Item>();
  own.forEach((index, i) => {
    const item = state.items[i];
    if (item && index < page.start && !fresh.has(item.id)) ctx.set(index, item);
  });
  theirs.forEach((index, i) => {
    const item = page.items[i];
    if (item && index < page.start && !fresh.has(item.id)) ctx.set(index, item);
  });
  const context = [...ctx.keys()].sort((a, b) => a - b);
  const kept = state.items.slice(own.length).filter((i) => !fresh.has(i.id));
  const pageRequests = new Map<string, ThreadRequest>(page.requests.map((r) => [r.id, r]));
  const requests = [
    ...page.requests.filter((r) => !state.requests.some((s) => s.id === r.id)),
    ...state.requests.map((r) => pageRequests.get(r.id) ?? r),
  ];
  const { start: _start, context: _context, ...rest } = state;
  return {
    ...rest,
    items: [...context.map((i) => ctx.get(i)!), ...body, ...kept],
    requests,
    ...(page.start ? { start: page.start } : {}),
    ...(page.start && context.length ? { context } : {}),
  };
}

/**
 * Where a request is in the thread's items: the index of its tool call, or else of the last item
 * of its turn; -1 if it has neither. A window or page has the requests whose anchor is in it.
 */
export function requestAnchor(items: readonly Item[], request: ThreadRequest): number {
  return anchor(items, indices(items), request);
}

function anchor(items: readonly Item[], at: Map<string, number>, r: ThreadRequest): number {
  const call = r.tool_call_id ? at.get(r.tool_call_id) : undefined;
  if (call !== undefined) return call;
  if (r.turn_id) for (let i = items.length - 1; i >= 0; i--) if (items[i]!.turn_id === r.turn_id) return i;
  return -1;
}

const isRunningSubagent = (item: Item): boolean =>
  item.type === "tool_call" && item.kind === "subagent" && (item.status === "pending" || item.status === "running");

function indices(items: readonly Item[]): Map<string, number> {
  const at = new Map<string, number>();
  items.forEach((item, i) => at.set(item.id, i));
  return at;
}

/** The indices before `start` of the items with an id in `need`, and of their parents, however nested; ascending. */
function contextOf(items: readonly Item[], at: Map<string, number>, need: Set<string>, start: number): number[] {
  const out = new Set<number>();
  const seen = new Set<string>();
  for (const first of need) {
    for (let id: string | undefined = first; id && !seen.has(id); ) {
      seen.add(id);
      const i = at.get(id);
      if (i === undefined) break;
      if (i < start) out.add(i);
      id = items[i]!.parent_id;
    }
  }
  return [...out].sort((a, b) => a - b);
}

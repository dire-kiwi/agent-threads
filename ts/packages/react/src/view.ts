// A thread's items arranged for drawing: each list of items (the main thread's, and each
// subagent's), what's known of each subagent, the open requests by the tool call they're for, and
// the answered requests by the list they're drawn in.
// It's rebuilt for each change, keeping what the change left as it was (lists, subagents, rows) as
// the same objects, so the rows showing them don't redraw. applyEvent does the same for items.

import type { Item, ThreadRequest, ToolCall } from "@dire-kiwi/agent-threads-protocol";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/** A subagent: a tool call of kind `subagent`, and the items it made. */
export interface SubagentInfo {
  /** Its call's id, which its items have as their `parent_id`. */
  id: string;
  call: ToolCall;
  /** What it did: the items whose parent_id is its id. */
  items: readonly Item[];
  status: SubagentStatus;
  /** How many tools it has called. */
  toolUses: number;
  /** One of its requests (a permission or question) is open. */
  waiting: boolean;
  /** The subagent that started this one, for nested subagents. */
  parent?: string;
}

export interface ThreadView {
  /** The items of each list, in order, by parent_id: "" for the main thread, a subagent's id for its own. */
  children: ReadonlyMap<string, readonly Item[]>;
  /** The thread's subagents, in the order they started, by id. */
  subagents: ReadonlyMap<string, SubagentInfo>;
  /** The open requests for tool calls, by the call's id. */
  requestsByCall: ReadonlyMap<string, ThreadRequest>;
  /** The resolved requests, oldest first, by the list they're drawn in: their parent_id, "" for the main thread's. */
  answered: ReadonlyMap<string, readonly ThreadRequest[]>;
}

export const NO_ITEMS: readonly Item[] = Object.freeze([]);

/** The view of `items` and `requests`, keeping what's unchanged from `prev` (the view of an earlier state). */
export function buildView(items: readonly Item[], requests: readonly ThreadRequest[], prev?: ThreadView): ThreadView {
  const children = new Map<string, Item[]>([["", []]]);
  for (const item of items) {
    const parent = item.parent_id ?? "";
    const list = children.get(parent);
    if (list) list.push(item);
    else children.set(parent, [item]);
  }
  const lists = children as Map<string, readonly Item[]>;
  if (prev) {
    for (const [id, list] of children) {
      const old = prev.children.get(id);
      if (old && sameList(old, list)) lists.set(id, old);
    }
  }

  const waiting = new Set<string>();
  const requestsByCall = new Map<string, ThreadRequest>();
  const answered = new Map<string, readonly ThreadRequest[]>();
  for (const r of requests) {
    if (r.resolution) {
      const list = answered.get(r.parent_id ?? "");
      if (list) (list as ThreadRequest[]).push(r);
      else answered.set(r.parent_id ?? "", [r]);
      continue;
    }
    if (r.parent_id) waiting.add(r.parent_id);
    if (r.tool_call_id) requestsByCall.set(r.tool_call_id, r);
  }
  if (prev) {
    for (const [id, list] of answered) {
      const old = prev.answered.get(id);
      if (old && sameList(old, list)) answered.set(id, old);
    }
  }

  const subagents = new Map<string, SubagentInfo>();
  for (const item of items) {
    if (item.type !== "tool_call" || item.kind !== "subagent") continue;
    const own = lists.get(item.id) ?? NO_ITEMS;
    const info: SubagentInfo = {
      id: item.id,
      call: item,
      items: own,
      status: subagentStatus(item),
      toolUses: own.reduce((n, i) => (i.type === "tool_call" ? n + 1 : n), 0),
      waiting: waiting.has(item.id),
      parent: item.parent_id,
    };
    const old = prev?.subagents.get(item.id);
    subagents.set(item.id, old && shallowEqual(old, info) ? old : info);
  }

  return {
    children: prev && sameMap(prev.children, lists) ? prev.children : lists,
    subagents: prev && sameMap(prev.subagents, subagents) ? prev.subagents : subagents,
    requestsByCall: prev && sameMap(prev.requestsByCall, requestsByCall) ? prev.requestsByCall : requestsByCall,
    answered: prev && sameMap(prev.answered, answered) ? prev.answered : answered,
  };
}

function subagentStatus(call: ToolCall): SubagentStatus {
  switch (call.status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/** A subagent and the subagents that started it, innermost first. */
export function lineage(subagents: ReadonlyMap<string, SubagentInfo>, id: string): string[] {
  const out: string[] = [];
  for (let cur: string | undefined = id; cur && !out.includes(cur); cur = subagents.get(cur)?.parent) out.push(cur);
  return out;
}

// ---------- rows ----------

/**
 * Tool calls in a row, shown together. Keyed by its first call, or by the key of the group it was
 * before (when earlier calls are put in front of it, say), so its row stays the same row.
 */
export interface ToolGroup {
  type: "tool_group";
  key: string;
  calls: readonly ToolCall[];
}

/** A resolved request, drawn where it was asked (see groupRows). */
export interface RequestRow {
  type: "request";
  request: ThreadRequest;
}

/** One row of a list: an item, a group of tool calls, or an answered request. */
export type Row = Item | ToolGroup | RequestRow;

export const rowKey = (row: Row): string => (row.type === "tool_group" ? `g:${row.key}` : row.type === "request" ? `r:${row.request.id}` : row.id);

/**
 * The rows to draw for a list of items: tool calls in a row become a group (except those `alone`
 * says to show by themselves), and assistant messages and reasoning with no text yet are left out.
 * `answered` (the list's resolved requests) are drawn where they were asked: a permission just
 * before its tool call, a question in place of its call (the card has the answers), one without a
 * call in the list after the last item of its turn, and one with neither at the end. Rows
 * unchanged from `prev` (the rows of an earlier version of the list) are its, and so is the list
 * if they all are; a group keeps the key it had in `prev`.
 */
export function groupRows(
  items: readonly Item[],
  prev?: readonly Row[],
  alone?: (call: ToolCall) => boolean,
  answered: readonly ThreadRequest[] = NO_REQUESTS,
): readonly Row[] {
  // Where each answered request goes: at a call (before it, or in its place), or after an item.
  const atCall = new Map<string, ThreadRequest>();
  const after = new Map<number, ThreadRequest[]>();
  if (answered.length) {
    const at = new Map<string, number>();
    items.forEach((item, i) => at.set(item.id, i));
    for (const r of answered) {
      const call = r.tool_call_id !== undefined ? at.get(r.tool_call_id) : undefined;
      if (call !== undefined && items[call]!.type === "tool_call" && !atCall.has(r.tool_call_id!)) {
        atCall.set(r.tool_call_id!, r);
        continue;
      }
      let last = items.length - 1;
      if (r.turn_id) for (let i = items.length - 1; i >= 0; i--) if (items[i]!.turn_id === r.turn_id) { last = i; break; }
      const list = after.get(last);
      if (list) list.push(r);
      else after.set(last, [r]);
    }
  }
  const old = new Map<string, ToolGroup>();
  const oldRequests = new Map<string, RequestRow>();
  const keyOf = new Map<string, string>();
  for (const r of prev ?? []) {
    if (r.type === "tool_group") {
      old.set(r.key, r);
      for (const c of r.calls) keyOf.set(c.id, r.key);
    } else if (r.type === "request") oldRequests.set(r.request.id, r);
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  let group: ToolCall[] | null = null;
  const request = (r: ThreadRequest) => {
    group = null;
    const was = oldRequests.get(r.id);
    rows.push(was && was.request === r ? was : { type: "request", request: r });
  };
  const pending = after.get(-1);
  if (pending) pending.forEach(request);
  items.forEach((item, i) => {
    const asked = item.type === "tool_call" ? atCall.get(item.id) : undefined;
    if (asked) request(asked);
    if (asked?.type === "question") {
      // The card has the answers.
    } else if ((item.type === "assistant_message" || item.type === "reasoning") && !item.text.trim()) {
      // Nothing to show yet.
    } else if (item.type === "tool_call" && !alone?.(item)) {
      if (group) group.push(item);
      else rows.push({ type: "tool_group", key: item.id, calls: (group = [item]) });
    } else {
      group = null;
      rows.push(item);
    }
    after.get(i)?.forEach(request);
  });
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.type !== "tool_group") continue;
    // The key of the group one of its calls was in, unless an earlier group has taken it.
    let key = r.calls.map((c) => keyOf.get(c.id)).find((k) => k !== undefined && !used.has(k)) ?? r.key;
    if (used.has(key)) key = `${r.key}:${i}`;
    used.add(key);
    const was = old.get(key);
    rows[i] = was && sameList(was.calls, r.calls) ? was : key === r.key ? r : { ...r, key };
  }
  if (!prev?.length) return rows;
  return rows.length === prev.length && rows.every((r, i) => r === prev[i]) ? prev : rows;
}

const NO_REQUESTS: readonly ThreadRequest[] = Object.freeze([]);

// ---------- helpers ----------

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

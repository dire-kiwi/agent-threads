// A thread's items arranged for drawing: each list of items (the main thread's, and each
// subagent's), what's known of each subagent, and the open requests by the tool call they're for.
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
  /**
   * It runs in the background: its call returned as soon as it started, and it carries on after
   * (so it can be running while its call has completed, and after its turn).
   */
  background: boolean;
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
  for (const r of requests) {
    if (r.parent_id) waiting.add(r.parent_id);
    if (r.tool_call_id) requestsByCall.set(r.tool_call_id, r);
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
      background: !!item.subagent?.background,
      toolUses: item.subagent?.tool_uses ?? own.reduce((n, i) => (i.type === "tool_call" ? n + 1 : n), 0),
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
  };
}

/** The subagent's own status where the harness gives it (a background one's call has completed), or its call's. */
function subagentStatus(call: ToolCall): SubagentStatus {
  if (call.subagent) return call.subagent.status;
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

/** Tool calls in a row, shown together. Keyed by its first call, which stays its first. */
export interface ToolGroup {
  type: "tool_group";
  key: string;
  calls: readonly ToolCall[];
}

/** One row of a list: an item, or a group of tool calls. */
export type Row = Item | ToolGroup;

export const rowKey = (row: Row): string => (row.type === "tool_group" ? `g:${row.key}` : row.id);

/**
 * The rows to draw for a list of items: tool calls in a row become a group (except those `alone`
 * says to show by themselves), and assistant messages and reasoning with no text yet are left out.
 * Rows unchanged from `prev` (the rows of an earlier version of the list) are its, and so is the
 * list if they all are.
 */
export function groupRows(items: readonly Item[], prev?: readonly Row[], alone?: (call: ToolCall) => boolean): readonly Row[] {
  const rows: Row[] = [];
  let group: ToolCall[] | null = null;
  for (const item of items) {
    if ((item.type === "assistant_message" || item.type === "reasoning") && !item.text.trim()) continue;
    if (item.type === "tool_call" && !alone?.(item)) {
      if (group) group.push(item);
      else rows.push({ type: "tool_group", key: item.id, calls: (group = [item]) });
      continue;
    }
    group = null;
    rows.push(item);
  }
  if (!prev?.length) return rows;
  const old = new Map<string, ToolGroup>();
  for (const r of prev) if (r.type === "tool_group") old.set(r.key, r);
  let same = rows.length === prev.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.type === "tool_group") {
      const was = old.get(r.key);
      if (was && sameList(was.calls, r.calls)) rows[i] = was;
    }
    if (rows[i] !== prev[i]) same = false;
  }
  return same ? prev : rows;
}

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

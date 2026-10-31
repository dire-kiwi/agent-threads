// The app's permission policy: whether the agent may call a tool, decided in code or by asking the
// user (which opens a `permission` request).

import type { Thread, ToolKind } from "@dire-kiwi/agent-threads-protocol";

/** A tool call the agent wants to make. */
export interface PermissionQuery {
  /** The tool's name (an MCP or app tool's own name, without Claude's `mcp__server__` prefix). */
  name: string;
  kind: ToolKind;
  input: unknown;
  title?: string;
  /** The MCP server, for an `mcp` tool. */
  server?: string;
  /** Why the harness is asking, when it says. */
  reason?: string;
  /** The tool_call item it's for. */
  toolCallId?: string;
  /** The subagent call it's from. */
  parentId?: string;
}

export interface PermissionContext {
  threadId: string;
  thread: Thread;
  metadata: { [k: string]: unknown };
}

/** `ask` asks the user; a deny can say why, and the agent is told. */
export type PermissionDecision = "allow" | "deny" | "ask" | { deny: string };

export type PermissionPolicy =
  | PermissionDecision
  | ((query: PermissionQuery, ctx: PermissionContext) => PermissionDecision | Promise<PermissionDecision>);

/**
 * Which tool a query is about, for a standing answer: its kind, its MCP server and its name, since
 * two servers (or an app tool and a built-in) can have tools of the same name.
 */
export function permissionKey(query: Pick<PermissionQuery, "kind" | "server" | "name">): string {
  return JSON.stringify([query.kind, query.server ?? null, query.name]);
}

/** Runs a policy; synchronously when it answers synchronously, so its effects keep their order. */
export function decide(policy: PermissionPolicy, query: PermissionQuery, ctx: PermissionContext): PermissionDecision | Promise<PermissionDecision> {
  if (typeof policy !== "function") return policy;
  try {
    const d = policy(query, ctx);
    return d instanceof Promise ? d.catch((e) => ({ deny: `The permission policy failed: ${e instanceof Error ? e.message : e}` })) : d;
  } catch (e) {
    return { deny: `The permission policy failed: ${e instanceof Error ? e.message : e}` };
  }
}

// The app's permission policy: whether the agent may call a tool, decided in code or by asking the
// user (which opens a `permission` request).

import type { PermissionMode, StandingAnswer, Thread, ToolKind } from "@dire-kiwi/agent-threads-protocol";

/** A tool call the agent wants to make. */
export interface PermissionQuery {
  /** The tool's name (an MCP or app tool's own name, without Claude's `mcp__server__` prefix). */
  name: string;
  kind: ToolKind;
  input: unknown;
  title?: string;
  /**
   * The command, for a `shell` call, as the tool_call shows it: Codex's `bash -lc` wrapper is
   * taken off (the input has it as Codex gave it).
   */
  command?: string;
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
export interface StandingKey {
  kind: ToolKind;
  server?: string;
  name: string;
}

export function permissionKey(query: Pick<PermissionQuery, "kind" | "server" | "name">): StandingKey {
  return { kind: query.kind, ...(query.server ? { server: query.server } : {}), name: query.name };
}

/** Whether a standing answer is for the tool `key`. */
export function standsFor(answer: StandingAnswer, key: StandingKey): boolean {
  return answer.kind === key.kind && answer.name === key.name && (answer.server || undefined) === (key.server || undefined);
}

/** What the agent is told when the thread's mode (dont_ask) denies what it would have asked. */
export const DONT_ASK_DENIAL = "Denied automatically: this thread's permission mode is dont_ask, so the user isn't asked.";

/**
 * What the thread's permission mode makes of a call the policy would ask the user about: bypass
 * allows it, dont_ask denies it.
 */
export function modeDecision(mode: PermissionMode | undefined, d: PermissionDecision): PermissionDecision {
  if (d !== "ask") return d;
  if (mode === "bypass") return "allow";
  if (mode === "dont_ask") return { deny: DONT_ASK_DENIAL };
  return d;
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

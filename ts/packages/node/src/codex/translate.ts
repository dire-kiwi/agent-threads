// Codex's items, plans, questions and usage in the protocol's terms (spec/fixtures/README.md,
// "Codex").

import type { FileChange, PermissionMode, Question, SubagentState, SubagentStatus, Todo, ToolStatus, Usage } from "@dire-kiwi/agent-threads-protocol";
import type { McpServer } from "../harness.js";
import { resultText, slim, type ToolFields } from "../claude/translate.js";
import type {
  AskForApproval,
  CollabAgentState,
  CollabAgentToolCallThreadItem,
  CommandExecutionThreadItem,
  DynamicToolCallThreadItem,
  FileChangeThreadItem,
  FileUpdateChange,
  ImageViewThreadItem,
  McpToolCallThreadItem,
  SandboxMode,
  ThreadItem,
  TokenUsageBreakdown,
  ToolRequestUserInputQuestion,
  Turn,
  TurnPlanStep,
  WebSearchThreadItem,
} from "./protocol.js";

/** The MCP server that serves a thread's app tools when Codex can't take them as dynamic tools. */
export const APP_SERVER = "app";

/** The items that are tool calls. */
export type ToolItem = CommandExecutionThreadItem | FileChangeThreadItem | McpToolCallThreadItem | DynamicToolCallThreadItem | WebSearchThreadItem | ImageViewThreadItem;

export function isToolItem(item: ThreadItem): item is ToolItem {
  return ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView"].includes(item.type);
}

/** Codex wraps commands in a login shell: `/usr/bin/bash -lc 'cmd'` is shown as cmd. */
export function unwrapCommand(command: string): string {
  const m = /^(?:\S*\/)?(?:bash|zsh|sh) -lc (?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s.exec(command);
  if (!m) return command;
  if (m[1] !== undefined) return m[1].replace(/'\\''/g, "'");
  return m[2]!.replace(/\\(.)/g, "$1");
}

/** A tool item's tool_call fields (all but id, status and the item's own). `mcpApp`: app tools are on the app MCP server. */
export function codexTool(item: ToolItem, mcpApp = false): ToolFields {
  switch (item.type) {
    case "commandExecution":
      return { name: "commandExecution", kind: "shell", input: { command: item.command, cwd: item.cwd }, command: unwrapCommand(item.command) };
    case "fileChange":
      return { name: "fileChange", kind: "edit", input: { changes: item.changes }, changes: fileChanges(item.changes) };
    case "mcpToolCall":
      if (mcpApp && item.server === APP_SERVER) return { name: item.tool, kind: "app", input: item.arguments ?? {} };
      return { name: item.tool, kind: "mcp", input: item.arguments ?? {}, server: item.server };
    case "dynamicToolCall":
      return { name: item.tool, kind: "app", input: item.arguments ?? {} };
    case "webSearch":
      return { name: "webSearch", kind: "web", input: { query: item.query, ...(item.action ? { action: item.action } : {}) }, ...webFields(item) };
    case "imageView":
      return { name: "imageView", kind: "read", input: { path: item.path }, path: item.path };
  }
}

function webFields(item: WebSearchThreadItem): Pick<ToolFields, "query" | "url"> {
  const action = (item.action ?? {}) as { url?: unknown; query?: unknown };
  const query = item.query || (typeof action.query === "string" ? action.query : "");
  return { ...(query ? { query } : {}), ...(typeof action.url === "string" && action.url ? { url: action.url } : {}) };
}

export function fileChanges(changes: FileUpdateChange[] | undefined): FileChange[] {
  return (changes ?? []).map((c) => {
    const kind = c.kind as { type?: string; move_path?: string | null };
    const f: FileChange = { path: c.path, op: kind?.type === "add" ? "add" : kind?.type === "delete" ? "delete" : "update" };
    if (c.diff) f.diff = c.diff;
    if (kind?.move_path) f.move_to = kind.move_path;
    return f;
  });
}

const STATUSES: { [s: string]: ToolStatus } = { completed: "completed", failed: "failed", declined: "denied", inProgress: "running" };

/** What a tool item's completion changes in its call (`denied`: the call was denied, and stays so). */
export function codexDone(item: ToolItem, denied: boolean): { [k: string]: unknown } {
  const status = STATUSES[(item as { status?: string }).status ?? "completed"] ?? "completed";
  const patch: { [k: string]: unknown } = { status: denied ? "denied" : status };
  switch (item.type) {
    case "commandExecution":
      // A command with no output has none (null), but still an exit code.
      if (typeof item.aggregatedOutput === "string" || typeof item.exitCode === "number") {
        patch.result = { ...slim(item.aggregatedOutput ?? ""), ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}) };
      }
      break;
    case "fileChange":
      patch.changes = fileChanges(item.changes);
      break;
    case "mcpToolCall":
      if (item.result) {
        patch.result = { ...slim(resultText(item.result.content)), ...(item.result.structuredContent ? { structured: item.result.structuredContent } : {}) };
      } else if (item.error) patch.result = { content: item.error.message ?? String(item.error) };
      break;
    case "dynamicToolCall":
      patch.result = slim((item.contentItems ?? []).flatMap((c) => (c.type === "inputText" ? [String(c.text)] : [])).join("\n"));
      break;
    case "webSearch":
      Object.assign(patch, webFields(item));
      break;
  }
  return patch;
}

/**
 * What a spawnAgent call's completion changes in its call. The spawn returns as soon as the child
 * thread has started, and the child runs on: a background subagent, until its turn ends.
 */
export function spawnDone(item: CollabAgentToolCallThreadItem): { [k: string]: unknown } {
  const status: ToolStatus = item.status === "failed" ? "failed" : item.status === "interrupted" ? "cancelled" : "completed";
  if (status !== "completed" || !item.receiverThreadIds?.length) return { status };
  return { status, subagent: { status: "running", background: true, ...(item.model ? { model: item.model } : {}) } satisfies SubagentState };
}

/** How a collab call's agentsStates entry says a child thread is getting on, as a SubagentStatus. */
export function collabStatus(state: CollabAgentState | undefined): SubagentStatus | undefined {
  switch (state?.status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "shutdown":
    case "interrupted":
      return "stopped";
  }
  return undefined;
}

/** A subagent after an agentsStates entry about its child thread (undefined if it says nothing). */
export function collabSubagent(s: SubagentState, state: CollabAgentState | undefined): SubagentState | undefined {
  const status = collabStatus(state);
  if (!status) return undefined;
  const next: SubagentState = { ...s, status };
  // Taken up again, it hasn't a report yet.
  if (status === "running") delete next.summary;
  else if (state?.message) next.summary = state.message;
  return next;
}

/** A subagent after its child thread's turn ended, with the child's last message (or the turn's error). */
export function childTurnSubagent(s: SubagentState, turn: Turn | undefined, last: string | undefined): SubagentState {
  const status: SubagentStatus = turn?.status === "completed" ? "completed" : turn?.status === "interrupted" ? "stopped" : "failed";
  const summary = (status === "failed" ? turn?.error?.message : undefined) ?? last;
  return { ...s, status, ...(summary ? { summary } : {}) };
}

/**
 * What a turn used. Codex reports the thread's running totals (again after a resume), so it's how
 * far they are past the thread's usage before the turn. Its input tokens include the cached ones,
 * which (as Claude's do) `input_tokens` leaves out.
 */
export function codexUsage(total: TokenUsageBreakdown, before: Usage = {} as Usage): Usage {
  const b = before as Partial<Usage>;
  const cached = total.cachedInputTokens - (b.cache_read_tokens ?? 0);
  const input = total.inputTokens - (b.input_tokens ?? 0) - (b.cache_read_tokens ?? 0);
  const pos = (n: number) => Math.max(0, n);
  return {
    input_tokens: pos(input - cached),
    output_tokens: pos(total.outputTokens - (b.output_tokens ?? 0)),
    cache_read_tokens: pos(cached),
    cache_write_tokens: pos((total.cacheWriteInputTokens ?? 0) - (b.cache_write_tokens ?? 0)),
  };
}

/** requestUserInput's questions. */
export function questions(qs: ToolRequestUserInputQuestion[]): Question[] {
  return qs.map((q) => ({
    id: q.id,
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options ? { options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
    ...(q.isOther ? { allow_other: true } : {}),
    ...(q.isSecret ? { secret: true } : {}),
  }));
}

export function todos(plan: TurnPlanStep[]): Todo[] {
  return plan.map((s) => ({ text: s.step, status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending" }));
}

/** How a permission mode runs under Codex: its approval policy and sandbox. */
export function codexPolicy(mode: PermissionMode | undefined): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  switch (mode) {
    case "accept_edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "plan":
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "bypass":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
}

/** An MCP server as Codex's `mcp_servers` config has it, or why it can't be. */
export function mcpServerConfig(s: McpServer): { [k: string]: unknown } | { unsupported: string } {
  if ("url" in s) {
    if (s.type === "sse") return { unsupported: "Codex doesn't support SSE MCP servers" };
    return { url: s.url, ...(s.headers && Object.keys(s.headers).length ? { http_headers: s.headers } : {}) };
  }
  return { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
}

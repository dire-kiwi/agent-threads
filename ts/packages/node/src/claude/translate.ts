// Claude Code's tools, results and usage in the protocol's terms (spec/fixtures/README.md, "Claude
// Code").

import type { FileChange, Question, SubagentState, SubagentStatus, ToolCall, ToolKind, Usage } from "@dire-kiwi/agent-threads-protocol";

/** The in-process MCP server that serves a thread's app tools. */
export const APP_SERVER = "app";

/** Tool results longer than this are cut short, as Huntaway does. */
export const MAX_RESULT = 30_000;

const KINDS: { [name: string]: ToolKind } = {
  Bash: "shell",
  BashOutput: "shell",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "subagent",
  Agent: "subagent",
  TodoWrite: "todo",
};

/** A tool_call's fields for a Claude tool_use (all but id, status and the item's own). */
export type ToolFields = Pick<ToolCall, "name" | "kind" | "input"> &
  Partial<Pick<ToolCall, "server" | "command" | "path" | "query" | "url" | "changes" | "title" | "todos">>;

export function claudeTool(name: string, input: unknown): ToolFields {
  const args = (input && typeof input === "object" ? input : {}) as { [k: string]: unknown };
  const t: ToolFields = { name, kind: name.startsWith("mcp__") ? "mcp" : (KINDS[name] ?? "other"), input: input ?? {} };
  if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    t.name = rest.join("__");
    if (server === APP_SERVER) t.kind = "app";
    else if (server) t.server = server;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  switch (t.kind) {
    case "shell":
      if (typeof args.command === "string") t.command = args.command;
      break;
    case "read":
      if (str(args.file_path)) t.path = str(args.file_path);
      break;
    case "search":
      if (str(args.pattern)) t.query = str(args.pattern);
      if (str(args.path)) t.path = str(args.path);
      break;
    case "web":
      if (str(args.url)) t.url = str(args.url);
      if (str(args.query)) t.query = str(args.query);
      break;
    case "edit":
      if (str(args.file_path)) t.changes = [{ path: str(args.file_path)!, op: "update" }];
      break;
    case "subagent":
      if (str(args.description)) t.title = str(args.description);
      break;
    case "todo":
      if (Array.isArray(args.todos)) {
        t.todos = args.todos.map((x: { content?: unknown; status?: unknown }) => ({
          text: String(x?.content ?? ""),
          status: (x?.status === "in_progress" || x?.status === "completed" ? x.status : "pending") as "pending" | "in_progress" | "completed",
        }));
      }
      break;
  }
  return t;
}

type Json = { [k: string]: any };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** How Claude says a subagent ended (in its task_* messages and the Agent call's result), as a SubagentStatus. */
export function subagentEnd(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
  return undefined;
}

/** A subagent call's subagent, as a task_started (of a local_agent) says it has started. */
export function subagentStarted(call: ToolCall, m: Json): SubagentState {
  const s: SubagentState = { ...call.subagent, status: "running" };
  if (m.is_backgrounded === true) s.background = true;
  if (str(m.subagent_type)) s.agent_type = m.subagent_type;
  const model = str(m.model) ?? str((call.input as Json | undefined)?.model);
  if (model) s.model = model;
  return s;
}

/** A subagent, after a task_progress, task_updated or task_notification about it. */
export function subagentTask(s: SubagentState, m: Json): SubagentState {
  const next: SubagentState = { ...s };
  switch (m.subtype) {
    case "task_progress":
      if (str(m.description)) next.activity = m.description;
      if (count(m.usage?.tool_uses) !== undefined) next.tool_uses = m.usage.tool_uses;
      break;
    case "task_updated": {
      // Continued (with SendMessage) after it ended, it runs again.
      const end = subagentEnd(m.patch?.status);
      if (m.patch?.status === "running") {
        next.status = "running";
        delete next.summary;
      } else if (end && s.status === "running") next.status = end;
      break;
    }
    case "task_notification": {
      const end = subagentEnd(m.status);
      if (end && s.status === "running") next.status = end;
      if (count(m.usage?.tool_uses) !== undefined) next.tool_uses = m.usage.tool_uses;
      // A foreground subagent's report is its call's result.
      if (s.background && str(m.summary)) next.summary = slim(m.summary).content;
      break;
    }
  }
  return next;
}

/**
 * A subagent call's subagent, as its result says (`meta` is the result's tool_use_result, `text`
 * its content). Undefined for a call whose subagent never started (it failed, or was denied).
 */
export function subagentResult(call: ToolCall, isError: boolean, interrupted: boolean, meta: unknown, text: string): SubagentState | undefined {
  if (call.kind !== "subagent" || (!call.subagent && isError)) return undefined;
  const r: Json = meta && typeof meta === "object" ? meta : {};
  const s: SubagentState = { status: "running", ...call.subagent };
  if (str(r.resolvedModel)) s.model = r.resolvedModel;
  if (str(r.agentType)) s.agent_type = r.agentType;
  if (count(r.totalToolUseCount) !== undefined) s.tool_uses = r.totalToolUseCount;
  // A background subagent's call returns as soon as it has started it.
  if (r.isAsync === true || r.status === "async_launched" || /^\s*Async agent launched/.test(text)) s.background = true;
  else if (s.status === "running") s.status = isError ? (interrupted ? "stopped" : "failed") : (subagentEnd(r.status) ?? "completed");
  return s;
}

/** A permission's title: what it's about, in a few words. */
export function title(t: ToolFields): string {
  if (t.command) return t.command;
  if (t.path) return t.path;
  if (t.changes?.length) return t.changes.map((c) => c.path).join(", ");
  return t.name;
}

type Block = { type?: string; text?: string; tool_name?: string };

/** A tool result's content as text: text blocks joined by newlines, images as [image]. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : b.type === "tool_reference" ? (b.tool_name ?? null) : null))
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** A result's content, cut short if it's long. */
export function slim(text: string): { content: string; truncated?: boolean } {
  return text.length > MAX_RESULT ? { content: text.slice(0, MAX_RESULT), truncated: true } : { content: text };
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A structuredPatch as a unified diff's hunks. */
export function hunks(patch: Hunk[]): string {
  return patch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("");
}

/** An Edit/Write result's file change, from its tool_use_result. */
export function editChange(result: { [k: string]: unknown }, path: string | undefined): FileChange | undefined {
  if (!Array.isArray(result.structuredPatch)) return undefined;
  const p = typeof result.filePath === "string" ? result.filePath : path;
  if (!p) return undefined;
  const create = result.type === "create";
  return { path: p, op: create ? "add" : "update", diff: create ? String(result.content ?? "") : hunks(result.structuredPatch as Hunk[]) };
}

/**
 * What a turn used: its result's model_usage_since_last_result, summed over the models. (Its
 * `usage` is only the last model call's, and total_cost_usd is the session's so far.)
 */
export function claudeUsage(result: { model_usage_since_last_result?: { [model: string]: { [k: string]: number | undefined } } }): Usage {
  const u = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  for (const m of Object.values(result.model_usage_since_last_result ?? {})) {
    u.input_tokens += m.inputTokens ?? 0;
    u.output_tokens += m.outputTokens ?? 0;
    u.cache_read_tokens += m.cacheReadInputTokens ?? 0;
    u.cache_write_tokens += m.cacheCreationInputTokens ?? 0;
    u.cost_usd = Math.round((u.cost_usd + (m.costUSD ?? 0)) * 1e12) / 1e12;
  }
  return u;
}

interface AskInput {
  questions?: { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
}

/** AskUserQuestion's questions; each one's id is its text, and "Other" is always offered. */
export function questions(input: unknown): Question[] {
  return ((input as AskInput)?.questions ?? []).map((q) => ({
    id: q.question,
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    ...(q.multiSelect ? { multi_select: true } : {}),
    allow_other: true,
  }));
}

/** The permission mode as Claude Code names it, or nothing for the default. */
export function claudePermissionMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case "accept_edits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypass":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

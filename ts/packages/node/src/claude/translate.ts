// Claude Code's tools, results and usage in the protocol's terms (spec/fixtures/README.md, "Claude
// Code").

import type { FileChange, Question, ToolCall, ToolKind, Usage } from "@dire-kiwi/agent-threads-protocol";

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
    // dont_ask: Claude asks, and agent-threads denies what it asks about (so the policy still allows
    // what it allows).
    default:
      return undefined;
  }
}

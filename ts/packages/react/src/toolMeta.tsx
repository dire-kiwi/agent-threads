// A tool call's summary line: its icon, a verb (or the tool's name) and what it's about, from the
// normalized fields the backend fills in for its kind (see spec/PROTOCOL.md, "Tool calls"), with
// the input as the harness gave it to fall back on.

import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import type { ToolMeta } from "./config.js";
import { AppIcon, BotIcon, FileIcon, GlobeIcon, ListIcon, PencilIcon, PlugIcon, SearchIcon, TerminalIcon, WrenchIcon } from "./icons.js";

type Input = Record<string, unknown>;

const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** `path` relative to `cwd`, when it's inside it. */
export function relative(path: string | undefined, cwd?: string): string {
  if (!path) return "";
  if (cwd && path.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")) return path.slice(cwd.length).replace(/^\//, "");
  return path;
}

/** The built-in summary of a call. */
export function toolMeta(call: ToolCall, cwd?: string): ToolMeta {
  const input: Input = call.input && typeof call.input === "object" ? (call.input as Input) : {};
  const rel = (p?: string) => relative(p, cwd);
  switch (call.kind) {
    case "shell":
      return { icon: <TerminalIcon />, label: "Ran", summary: call.command ?? str(input.command) };
    case "read":
      return { icon: <FileIcon />, label: "Read", summary: rel(call.path ?? str(input.file_path ?? input.path)) };
    case "edit": {
      const changes = call.changes ?? [];
      const label =
        call.name === "Write" || (changes.length > 0 && changes.every((c) => c.op === "add"))
          ? "Wrote"
          : changes.length > 0 && changes.every((c) => c.op === "delete")
            ? "Deleted"
            : "Edited";
      const paths = changes.length ? changes.map((c) => rel(c.path)) : [rel(call.path ?? str(input.file_path ?? input.notebook_path))];
      return { icon: <PencilIcon />, label, summary: paths.join(", ") };
    }
    case "search": {
      const query = call.query ?? str(input.pattern ?? input.query);
      const path = call.path ?? str(input.path);
      if (call.name === "Glob") return { icon: <SearchIcon />, label: "Listed", summary: query };
      return { icon: <SearchIcon />, label: "Searched", summary: path ? `${query}  in ${rel(path)}` : query };
    }
    case "web": {
      const url = call.url ?? str(input.url);
      if (url) return { icon: <GlobeIcon />, label: "Fetched", summary: url };
      return { icon: <GlobeIcon />, label: "Searched the web", summary: call.query ?? str(input.query) };
    }
    case "mcp":
      return { icon: <PlugIcon />, label: call.server ? `${call.server} · ${call.name}` : call.name, summary: call.title ?? brief(input) };
    case "app":
      return { icon: <AppIcon />, label: call.name, summary: call.title ?? brief(input) };
    case "subagent":
      return { icon: <BotIcon />, label: "Subagent", summary: call.title ?? str(input.description ?? input.prompt).split("\n")[0]! };
    case "todo": {
      const todos = call.todos ?? [];
      const done = todos.filter((t) => t.status === "completed").length;
      return { icon: <ListIcon />, label: "Updated the plan", summary: todos.length ? `${done} of ${todos.length} done` : "" };
    }
    default:
      return { icon: <WrenchIcon />, label: call.name.replace(/^mcp__/, "").replace(/__/g, " · "), summary: call.title ?? brief(input) };
  }
}

/** A short line for an input: its first few simple fields. */
export function brief(input: unknown): string {
  if (input == null || typeof input !== "object") return input == null ? "" : String(input);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v == null || typeof v === "object" || v === "" || v === false) continue;
    parts.push(`${k}: ${String(v).split("\n")[0]}`);
    if (parts.length === 3) break;
  }
  const line = parts.join(", ");
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

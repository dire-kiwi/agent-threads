// Tool calls: a row each, with a summary line that opens to show the call's input and result. The
// built-in renderers draw each kind (shell, edit, read, search, web, mcp, app, todo, other); an app
// adds its own by tool name or kind (see ThreadConfig), and a subagent is a row of its own.

import type { FileChange, ThreadRequest, ToolCall as ToolCallItem, ToolKind } from "@dire-kiwi/agent-threads-protocol";
import { memo, useEffect, useMemo, useState, type ComponentType } from "react";
import type { ThreadConfig, ToolBodyProps, ToolRenderer } from "../config.js";
import { useRevealed, useThreadConfig, useThreadState } from "../hooks.js";
import { ShieldIcon, SpinnerIcon, XIcon } from "../icons.js";
import { toolMeta } from "../toolMeta.js";
import type { ToolGroup as ToolGroupRow } from "../view.js";
import { Subagent } from "./Subagent.js";
import { Chevron, CodeBlock, cx } from "./ui.js";

type Input = Record<string, unknown>;
const inputOf = (call: ToolCallItem): Input => (call.input && typeof call.input === "object" ? (call.input as Input) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** How the call's drawn: the app's renderer for its name, over the app's for its kind, over the built-in one. */
export function toolRenderer(config: ThreadConfig, call: Pick<ToolCallItem, "name" | "kind">): ToolRenderer {
  const byName = config.tools?.[call.name];
  const byKind = config.toolKinds?.[call.kind];
  const builtin = builtinToolRenderers[call.kind] ?? builtinToolRenderers.other;
  return byName || byKind ? { ...builtin, ...byKind, ...byName } : builtin;
}

/**
 * What a permission card shows of the call it asks about, under its summary line: the renderer's
 * body, except the built-in ones that only show a result (read, search, web), whose input it shows
 * instead (what's to be read, searched or fetched).
 */
export function permissionBody(renderer: ToolRenderer): ComponentType<ToolBodyProps> {
  return renderer.Body === ReadBody || renderer.Body === WebBody ? InputBody : (renderer.Body ?? GenericBody);
}

/** A tool call: its summary line, which opens to show its input and result. */
export const ToolCall = memo(function ToolCall({ call, className }: { call: ToolCallItem; className?: string }) {
  const config = useThreadConfig();
  const renderer = toolRenderer(config, call);
  const request = useThreadState((s) => s.view.requestsByCall.get(call.id));
  if (renderer.Row)
    return (
      <div className={cx("at-tool", className)} data-tool-row="">
        <renderer.Row call={call} request={request} />
      </div>
    );
  if (call.kind === "subagent" && !config.tools?.[call.name]?.Body && !config.toolKinds?.subagent?.Body) return <Subagent call={call} className={className} />;
  return <PlainToolCall call={call} renderer={renderer} request={request} className={className} />;
});

function PlainToolCall({ call, renderer, request, className }: { call: ToolCallItem; renderer: ToolRenderer; request?: ThreadRequest; className?: string }) {
  const [open, setOpen] = useState(false);
  const cwd = useThreadState((s) => s.snapshot.thread.cwd);
  const meta = { ...toolMeta(call, cwd), ...renderer.meta?.(call, cwd) };
  const Body = renderer.Body ?? GenericBody;
  return (
    <div className={cx("at-tool", `at-tool-${call.kind}`, `at-tool-${call.status}`, className)} data-tool-row="">
      <button type="button" className="at-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span className="at-tool-icon">{meta.icon}</span>
        <span className="at-tool-label">{meta.label}</span>
        <span className="at-tool-summary">{meta.summary}</span>
        <ToolStatus call={call} request={request} />
      </button>
      {open && (
        <div className="at-tool-body">
          <Body call={call} />
        </div>
      )}
    </div>
  );
}

/** Where a call's got to, at the end of its row: nothing once it's done. */
export function ToolStatus({ call, request }: { call: ToolCallItem; request?: ThreadRequest }) {
  if (request)
    return (
      <span className="at-tool-status at-attention">
        {request.type === "question" ? "waiting for an answer" : "needs approval"} <ShieldIcon size={12} />
      </span>
    );
  switch (call.status) {
    case "pending":
    case "running":
      return (
        <span className="at-tool-status at-progress" aria-label={call.status}>
          <SpinnerIcon size={12} className="at-spin" />
        </span>
      );
    case "failed":
      return (
        <span className="at-tool-status at-bad" aria-label="failed">
          <XIcon size={12} />
        </span>
      );
    case "denied":
      return <span className="at-tool-status at-bad">denied</span>;
    case "cancelled":
      return <span className="at-tool-status at-faint">cancelled</span>;
    default:
      return null;
  }
}

// ---------- groups ----------

/** How many of a group's calls show before "Show n earlier". */
const SHOWN = 6;

/** Tool calls in a row: the latest few, and a button for the rest. */
export const ToolGroup = memo(function ToolGroup({ group, className }: { group: ToolGroupRow; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.calls.length - SHOWN;
  // A subagent being revealed that's in one of the hidden calls shows them.
  const hiddenIds = useMemo(() => (hidden > 0 ? group.calls.slice(0, hidden).map((c) => c.id) : []), [group.calls, hidden]);
  const reveal = useRevealed(hiddenIds);
  useEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const shown = expanded || hidden <= 0 ? group.calls : group.calls.slice(hidden);
  return (
    <div className={cx("at-tool-group", className)}>
      {!expanded && hidden > 0 && (
        <button type="button" className="at-tool-more" onClick={() => setExpanded(true)}>
          Show {hidden} earlier tool call{hidden > 1 ? "s" : ""}
        </button>
      )}
      {shown.map((c) => (
        <ToolCall key={c.id} call={c} />
      ))}
    </div>
  );
});

// ---------- built-in bodies ----------

/** The call's result: its text (an error's in red), and whether it was cut short. */
export function ToolResultView({ call }: ToolBodyProps) {
  const r = call.result;
  if (!r) return null;
  const error = call.status === "failed" || (r.exit_code != null && r.exit_code !== 0);
  const text = r.content || (r.structured != null ? JSON.stringify(r.structured, null, 2) : "");
  return (
    <>
      <CodeBlock text={text} tone={error ? "error" : undefined} />
      {(r.truncated || (r.exit_code != null && r.exit_code !== 0)) && (
        <div className="at-tool-note">
          {[r.exit_code != null && r.exit_code !== 0 && `exit code ${r.exit_code}`, r.truncated && "output cut short"].filter(Boolean).join(" · ")}
        </div>
      )}
    </>
  );
}

function InputBody({ call }: ToolBodyProps) {
  return <CodeBlock text={JSON.stringify(call.input, null, 2) ?? ""} />;
}

function GenericBody({ call }: ToolBodyProps) {
  return (
    <>
      <CodeBlock text={JSON.stringify(call.input, null, 2) ?? ""} />
      <ToolResultView call={call} />
    </>
  );
}

function ShellBody({ call }: ToolBodyProps) {
  const command = call.command ?? str(inputOf(call).command);
  return (
    <>
      <CodeBlock text={`$ ${command}`} className="at-code-command" />
      <ToolResultView call={call} />
    </>
  );
}

function ReadBody({ call }: ToolBodyProps) {
  return call.result ? <ToolResultView call={call} /> : <div className="at-tool-note">Reading…</div>;
}

function WebBody({ call }: ToolBodyProps) {
  const url = call.url ?? str(inputOf(call).url);
  return (
    <>
      {url && /^https?:\/\//.test(url) && (
        <a className="at-tool-link" href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      )}
      <ToolResultView call={call} />
    </>
  );
}

/** A file edit: each change's diff, or the edit as the harness gave it. Its result only if it failed. */
function EditBody({ call }: ToolBodyProps) {
  const input = inputOf(call);
  const changes = call.changes ?? [];
  let shown;
  if (changes.some((c) => c.diff)) shown = changes.map((c, i) => <PatchDiff key={i} change={c} />);
  else if (typeof input.old_string === "string" || typeof input.new_string === "string")
    shown = <EditDiff before={str(input.old_string)} after={str(input.new_string)} />;
  else if (Array.isArray(input.edits))
    shown = (input.edits as Input[]).map((e, i) => <EditDiff key={i} before={str(e.old_string)} after={str(e.new_string)} />);
  else if (typeof input.content === "string") shown = <CodeBlock text={input.content} />;
  else shown = <CodeBlock text={JSON.stringify(call.input, null, 2) ?? ""} />;
  return (
    <>
      {shown}
      {call.status === "failed" && <ToolResultView call={call} />}
    </>
  );
}

/** A replacement of `before` with `after`, as Claude's Edit gives it. */
export function EditDiff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="at-code at-diff">
      {before.split("\n").map((l, i) => (
        <div key={`o${i}`} className="at-diff-del">
          - {l}
        </div>
      ))}
      {after.split("\n").map((l, i) => (
        <div key={`n${i}`} className="at-diff-add">
          + {l}
        </div>
      ))}
    </pre>
  );
}

/** A unified diff of one file, as Codex gives it. */
export function PatchDiff({ change }: { change: FileChange }) {
  const lines = (change.diff ?? "").replace(/\n$/, "").split("\n");
  const tone = (l: string) =>
    l.startsWith("+") && !l.startsWith("+++") ? "at-diff-add" : l.startsWith("-") && !l.startsWith("---") ? "at-diff-del" : l.startsWith("@@") ? "at-diff-hunk" : undefined;
  return (
    <div className="at-diff-file">
      <div className="at-diff-path">
        {change.op === "add" ? "new " : change.op === "delete" ? "deleted " : ""}
        {change.path}
        {change.move_to ? ` → ${change.move_to}` : ""}
      </div>
      <pre className="at-code at-diff">
        {lines.map((l, i) => (
          <div key={i} className={tone(l)}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function TodoBody({ call }: ToolBodyProps) {
  const todos = call.todos ?? [];
  if (!todos.length) return <GenericBody call={call} />;
  return (
    <ul className="at-todos">
      {todos.map((t, i) => (
        <li key={i} className={`at-todo at-todo-${t.status}`}>
          <span aria-hidden>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span> {t.text}
        </li>
      ))}
    </ul>
  );
}

/** The built-in renderers, by kind. */
export const builtinToolRenderers: Record<ToolKind, ToolRenderer> = {
  shell: { Body: ShellBody },
  read: { Body: ReadBody },
  edit: { Body: EditBody },
  search: { Body: ReadBody },
  web: { Body: WebBody },
  mcp: { Body: GenericBody },
  app: { Body: GenericBody },
  subagent: { Body: GenericBody },
  todo: { Body: TodoBody },
  other: { Body: GenericBody },
};

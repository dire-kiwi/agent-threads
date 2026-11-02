// A subagent: a row like a tool call's, which opens to show what the subagent did (its own items,
// drawn as a thread of their own) and its report.

import type { Item, ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLoadEarlier, useRevealed, useThreadState } from "../hooks.js";
import { isLoaded } from "../store.js";
import { BotIcon, CheckIcon, FileIcon, ShieldIcon, SpinnerIcon, XIcon } from "../icons.js";
import { toolMeta } from "../toolMeta.js";
import { NO_ITEMS, type SubagentInfo, type SubagentStatus } from "../view.js";
import { MessageList } from "./MessageList.js";
import { LoadEarlier } from "./LoadEarlier.js";
import { Chevron, CodeBlock, Collapsible, cx, Markdown, plural } from "./ui.js";

type Input = Record<string, unknown>;
const inputOf = (call: ToolCall): Input => (call.input && typeof call.input === "object" ? (call.input as Input) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** What kind of subagent it is, e.g. "Explore"; "Subagent" for a general one. */
export function subagentKind(call: ToolCall): string {
  const type = str(inputOf(call).subagent_type);
  return type && type !== "general-purpose" ? type : "Subagent";
}

/** Its title: its description, or the first line of its prompt. */
export function subagentTitle(call: ToolCall): string {
  const input = inputOf(call);
  return call.title || str(input.description) || str(input.prompt).split("\n")[0]!.slice(0, 80) || subagentKind(call);
}

/**
 * The subagent's report, from its call's result: Claude frames a subagent's report with notes for
 * the agent (its lines indented under "The report follows:"), which this takes off.
 */
export function reportText(content: string): string {
  const marker = "The report follows:\n";
  const at = content.indexOf(marker);
  if (at < 0) return content.trim();
  const lines: string[] = [];
  for (const line of content.slice(at + marker.length).split("\n")) {
    if (line && !line.startsWith("  ")) break;
    lines.push(line.slice(2));
  }
  return lines.join("\n").trim();
}

/** What it's doing now: its latest tool call, or writing its reply. */
function activity(items: readonly Item[], cwd?: string): string | undefined {
  const last = items[items.length - 1];
  if (!last) return undefined;
  if (last.type === "tool_call") {
    const m = toolMeta(last, cwd);
    return m.summary ? `${m.label} ${m.summary}` : m.label;
  }
  if (last.type === "assistant_message") return "Writing…";
  if (last.type === "reasoning") return "Thinking…";
  return undefined;
}

/** Where a subagent's got to: working (and on what), waiting on the user, done, failed or stopped. */
export function SubagentStatusBadge({ status, waiting, activity, className }: {
  status: SubagentStatus;
  waiting?: boolean;
  activity?: string;
  className?: string;
}) {
  return (
    <span className={cx("at-tool-status", className)}>
      {status === "running" && waiting ? (
        <span className="at-attention">
          needs you <ShieldIcon size={12} />
        </span>
      ) : status === "running" ? (
        <>
          {activity && <span className="at-subagent-activity">{activity}</span>}
          <SpinnerIcon size={12} className="at-spin at-progress" />
        </>
      ) : status === "completed" ? (
        <CheckIcon size={12} className="at-good" />
      ) : status === "failed" ? (
        <span className="at-bad">
          failed <XIcon size={12} />
        </span>
      ) : (
        <span className="at-faint">stopped</span>
      )}
    </span>
  );
}

/** A subagent's row, which opens to show what it did. */
export const Subagent = memo(function Subagent({ call, className }: { call: ToolCall; className?: string }) {
  const sub = useThreadState((s) => s.view.subagents.get(call.id));
  const cwd = useThreadState((s) => s.snapshot.thread.cwd);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => [call.id], [call.id]);
  const reveal = useRevealed(ids);
  useEffect(() => {
    if (!reveal) return;
    setOpen(true);
    if (!reveal.self) return;
    setFlash(true);
    reveal.done();
    requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
  }, [reveal]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [flash]);
  // One that started before the items loaded has them loaded back to its start once it's opened.
  // They come in below its row, and the thread keeps its place from the end: it's shown again after.
  const loaded = useThreadState((s) => isLoaded(s.snapshot, call.id));
  const loadEarlier = useLoadEarlier();
  useEffect(() => {
    if (open && !loaded) void loadEarlier({ to: call.id }).then(() => ref.current?.scrollIntoView?.({ block: "start" }));
  }, [open, loaded, loadEarlier, call.id]);
  const items = sub?.items ?? NO_ITEMS;
  const status = sub?.status ?? "running";
  return (
    <div ref={ref} className={cx("at-tool", "at-subagent", flash && "at-flash", className)} data-tool-row="" data-subagent={call.id}>
      <button type="button" className="at-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span className="at-tool-icon">
          <BotIcon />
        </span>
        <span className="at-tool-label">{subagentKind(call)}</span>
        <span className="at-tool-summary at-subagent-title">{subagentTitle(call)}</span>
        <SubagentStatusBadge status={status} waiting={sub?.waiting} activity={status === "running" ? activity(items, cwd) : undefined} />
      </button>
      {open && sub && <SubagentBody sub={sub} loaded={loaded} />}
    </div>
  );
});

/** What a subagent did, under its row: its prompt, its items and its report. */
function SubagentBody({ sub, loaded }: { sub: SubagentInfo; loaded: boolean }) {
  const { call } = sub;
  const input = inputOf(call);
  const meta = [str(input.model), sub.toolUses > 0 && plural(sub.toolUses, "tool use")].filter(Boolean);
  const prompt = str(input.prompt);
  const hasText = sub.items.some((i) => i.type === "assistant_message" && i.text.trim());
  const report = call.result && call.status === "completed" ? reportText(call.result.content) : "";
  return (
    <div className="at-subagent-body">
      {meta.length > 0 && <div className="at-subagent-meta">{meta.join(" · ")}</div>}
      {prompt && (
        <Collapsible label="Prompt" icon={<FileIcon />}>
          <div className="at-pre-wrap">{prompt}</div>
        </Collapsible>
      )}
      {!loaded && <LoadEarlier to={sub.id} />}
      <MessageList parentId={sub.id} />
      {sub.status === "running" && (
        <div className="at-working">
          <span className="at-dot" /> Working…
        </div>
      )}
      {sub.status === "failed" && call.result ? (
        <CodeBlock text={call.result.content} tone="error" />
      ) : (
        !hasText && report && <Markdown text={report} />
      )}
      {sub.status === "stopped" && !report && <div className="at-faint at-small">Stopped before it finished.</div>}
    </div>
  );
}

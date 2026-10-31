// The thread's lines that aren't anyone talking: a compaction, the end of a turn, and notices.

import type { Compaction, Notice as NoticeItem, TurnResult as TurnResultItem, Usage } from "@dire-kiwi/agent-threads-protocol";
import { memo, useState } from "react";
import { AlertIcon, LayersIcon } from "../icons.js";
import { Chevron, CodeBlock, cost, cx, Markdown, seconds, tokens } from "./ui.js";

/** The harness compacted its context: how big it was, and the summary it goes on from (which opens). */
export const CompactionLine = memo(function CompactionLine({ item, className }: { item: Compaction; className?: string }) {
  const [open, setOpen] = useState(false);
  const summary = item.summary;
  return (
    <div className={cx("at-line", "at-compaction", className)}>
      <button type="button" className="at-line-rule" disabled={!summary} aria-expanded={summary ? open : undefined} onClick={() => setOpen(!open)}>
        <span className="at-rule" />
        <LayersIcon size={12} />
        {item.trigger === "auto" ? "Context full, conversation compacted" : "Conversation compacted"}
        {item.tokens_before != null && ` · ${tokens(item.tokens_before)} tokens`}
        {summary && <Chevron open={open} size={11} />}
        <span className="at-rule" />
      </button>
      {open && summary && (
        <div className="at-compaction-summary">
          <Markdown text={summary} />
        </div>
      )}
    </div>
  );
});

/** What a turn's usage comes to, e.g. "1.2k in · 300 out · $0.003". */
export function usageText(usage: Usage): string {
  const input = usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  return [`${tokens(input)} in`, `${tokens(usage.output_tokens)} out`, usage.cost_usd != null && cost(usage.cost_usd)].filter(Boolean).join(" · ");
}

/** How a turn ended: done, interrupted or failed, how long it took and what it used. */
export const TurnResult = memo(function TurnResult({ item, className }: { item: TurnResultItem; className?: string }) {
  const error = !item.ok && !item.interrupted;
  const bits = [item.duration_ms != null && seconds(item.duration_ms), item.usage && usageText(item.usage)].filter(Boolean);
  return (
    <div className={cx("at-line", "at-turn-result", error && "at-turn-error", className)} title={item.error}>
      <div className="at-line-rule">
        <span className="at-rule" />
        {item.interrupted ? "Interrupted" : error ? `Failed${item.error ? `: ${firstLine(item.error)}` : ""}` : "Turn complete"}
        {bits.map((b) => ` · ${b}`).join("")}
        <span className="at-rule" />
      </div>
    </div>
  );
});

const firstLine = (s: string) => {
  const line = s.split("\n")[0]!;
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
};

/** Something to tell the user that isn't the agent talking; its detail opens. */
export const Notice = memo(function Notice({ item, className }: { item: NoticeItem; className?: string }) {
  const [open, setOpen] = useState(false);
  const detail = item.detail;
  return (
    <div className={cx("at-notice", `at-notice-${item.level}`, className)} data-code={item.code}>
      <button type="button" className="at-notice-head" disabled={!detail} aria-expanded={detail ? open : undefined} onClick={() => setOpen(!open)}>
        {item.level === "info" ? <span className="at-dot" /> : <AlertIcon size={12} />}
        <span className="at-notice-text">{item.text}</span>
        {detail && <Chevron open={open} size={11} />}
      </button>
      {open && detail && <CodeBlock text={detail} tone={item.level === "error" ? "error" : undefined} />}
    </div>
  );
});

import { memo } from "react";
import { cx } from "./ui.js";

/**
 * Text as it streams in, drawn plainly: drawing it as Markdown again for each delta would take
 * longer the longer it got. A paragraph each, so a delta changes (and lays out again) only the last
 * one. The message is drawn as Markdown once its final text comes.
 */
export const StreamingText = memo(function StreamingText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("at-streaming", className)} aria-busy="true">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
});

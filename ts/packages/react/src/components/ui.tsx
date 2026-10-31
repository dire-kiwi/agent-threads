// Pieces the components share: class names, code blocks, collapsible sections, buttons and
// Markdown.

import { memo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useThreadConfig } from "../hooks.js";
import { ChevronIcon } from "../icons.js";

/** The class names that are set, joined. */
export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

export function CodeBlock({ text, tone, className, tall }: { text: string; tone?: "error"; className?: string; tall?: boolean }) {
  return (
    <pre className={cx("at-code", tone === "error" && "at-code-error", tall && "at-code-tall", className)}>
      {text || <span className="at-faint">(empty)</span>}
    </pre>
  );
}

/** A section that opens when its label's clicked. */
export function Collapsible({ label, icon, children, className, defaultOpen = false }: {
  label: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cx("at-collapsible", className)}>
      <button type="button" className="at-collapsible-label" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon} {label}
        <Chevron open={open} size={11} />
      </button>
      {open && <div className="at-collapsible-body">{children}</div>}
    </div>
  );
}

export const Chevron = ({ open, size = 12 }: { open: boolean; size?: number }) => (
  <ChevronIcon size={size} className={cx("at-chevron", open && "at-chevron-open")} />
);

export function Button({ variant, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" }) {
  return <button type="button" {...props} className={cx("at-button", variant && `at-button-${variant}`, className)} />;
}

/** Markdown, drawn by the app's renderMarkdown if it gave one. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const render = useThreadConfig().renderMarkdown;
  return <div className={cx("at-markdown", className)}>{render ? render(text) : <PlainMarkdown text={text} />}</div>;
});

/**
 * Markdown without parsing it: fenced code blocks, paragraphs, and `code`. An app that wants the
 * rest passes renderMarkdown.
 */
function PlainMarkdown({ text }: { text: string }) {
  const parts = text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i} className="at-code">
            {part.replace(/\n$/, "")}
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => <p key={`${i}.${j}`}>{inlineCode(p.trim())}</p>)
        ),
      )}
    </>
  );
}

function inlineCode(text: string): ReactNode {
  const bits = text.split(/`([^`\n]+)`/);
  return bits.length === 1 ? text : bits.map((b, i) => (i % 2 ? <code key={i}>{b}</code> : b));
}

// ---------- numbers ----------

export const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const seconds = (ms: number): string => {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

export const cost = (usd: number): string => `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;

/** `n thing` or `n things`. */
export const plural = (n: number, thing: string): string => `${n} ${thing}${n === 1 ? "" : "s"}`;

// What an app can change about how a thread is drawn: its own renderers for tools (by name, or by
// kind), for Markdown, and for any item.

import type { Item, ThreadRequest, ToolCall, ToolKind } from "@dire-kiwi/agent-threads-protocol";
import type { ComponentType, ReactNode } from "react";

/** A tool call's one-line summary: an icon, a verb or name, and what it's about. */
export interface ToolMeta {
  icon: ReactNode;
  label: string;
  summary: string;
}

export interface ToolRowProps {
  call: ToolCall;
  /** The open permission or question for the call, if there's one. */
  request?: ThreadRequest;
}

export interface ToolBodyProps {
  call: ToolCall;
}

/**
 * How to draw a tool's calls. Each part is optional: what's left out is the built-in renderer's for
 * the call's kind.
 */
export interface ToolRenderer {
  /** Its summary line, or the parts of it to change. `cwd` is the thread's, for showing paths relative to it. */
  meta?: (call: ToolCall, cwd?: string) => Partial<ToolMeta>;
  /** What the row shows when it's opened: the call's input and result. */
  Body?: ComponentType<ToolBodyProps>;
  /** Draws the whole row in place of the summary line and body (e.g. an order card for `lookup_order`). */
  Row?: ComponentType<ToolRowProps>;
  /** Shows its calls by themselves, rather than in a group with the calls around them. */
  alone?: boolean;
}

export interface ThreadConfig {
  /** Renderers for tools by their name (the harness's `name`, e.g. `lookup_order` or `Bash`). */
  tools?: Readonly<Record<string, ToolRenderer>>;
  /** Renderers for tools by kind, in place of the built-in ones. */
  toolKinds?: Readonly<Partial<Record<ToolKind, ToolRenderer>>>;
  /**
   * Draws Markdown: the agent's messages, a compaction's summary and a subagent's report. The
   * default shows paragraphs and code blocks without parsing the rest; pass e.g.
   * `(text) => <ReactMarkdown>{text}</ReactMarkdown>` for the real thing.
   */
  renderMarkdown?: (text: string) => ReactNode;
  /**
   * Draws an item in place of the built-in row for it: return undefined to keep that one. For a
   * tool call, the tool renderers above are usually simpler.
   */
  renderItem?: (item: Item) => ReactNode | undefined;
}

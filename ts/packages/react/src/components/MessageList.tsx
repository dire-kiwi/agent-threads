// A list of a thread's items, a row each: the main thread's, or a subagent's own. Rows are
// memoized, and an event leaves the items (and rows) it doesn't change as they were, so only the
// rows it changes redraw.

import type { AssistantMessage as AssistantMessageItem, Attachment, Item, Reasoning as ReasoningItem, UserMessage as UserMessageItem } from "@dire-kiwi/agent-threads-protocol";
import { memo, useMemo, useRef } from "react";
import { useThreadConfig, useThreadState } from "../hooks.js";
import { BrainIcon, ClockIcon } from "../icons.js";
import { groupRows, NO_ITEMS, rowKey, type Row as RowItem } from "../view.js";
import { CompactionLine, Notice, TurnResult } from "./Lines.js";
import { StreamingText } from "./StreamingText.js";
import { ToolCall, ToolGroup, toolRenderer } from "./ToolCall.js";
import { Collapsible, cx, Markdown } from "./ui.js";

/** The rows of the thread (or, given `parentId`, of that subagent's own thread). */
export const MessageList = memo(function MessageList({ parentId = "", className }: { parentId?: string; className?: string }) {
  const items = useThreadState((s) => s.view.children.get(parentId) ?? NO_ITEMS);
  const config = useThreadConfig();
  const alone = useMemo(() => {
    if (!config.tools && !config.toolKinds) return undefined;
    return (call: Parameters<typeof toolRenderer>[1]) => !!toolRenderer(config, call).alone;
  }, [config]);
  const prev = useRef<readonly RowItem[]>(undefined);
  const rows = useMemo(() => (prev.current = groupRows(items, prev.current, alone)), [items, alone]);
  return (
    <div className={cx("at-message-list", className)}>
      {rows.map((row) => (
        <MessageRow key={rowKey(row)} row={row} />
      ))}
    </div>
  );
});

/** One row: an item, or a group of tool calls. */
export const MessageRow = memo(function MessageRow({ row }: { row: RowItem }) {
  const { renderItem } = useThreadConfig();
  if (row.type === "tool_group") return <ToolGroup group={row} />;
  const custom = renderItem?.(row);
  if (custom !== undefined) return <>{custom}</>;
  return <ItemView item={row} />;
});

/** The built-in row for an item. */
export function ItemView({ item }: { item: Item }) {
  switch (item.type) {
    case "user_message":
      return <UserMessage item={item} />;
    case "assistant_message":
      return <AssistantMessage item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "tool_call":
      return <ToolCall call={item} />;
    case "compaction":
      return <CompactionLine item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "turn_result":
      return <TurnResult item={item} />;
    default:
      return null;
  }
}

/** A message to the agent: steered ones joined a running turn, queued ones are waiting for the agent to take them in. */
export function UserMessage({ item, className }: { item: UserMessageItem; className?: string }) {
  return (
    <div className={cx("at-user", item.queued && "at-user-queued", className)}>
      <div className="at-user-bubble" title={item.steered ? "Sent while the agent was working; it read it here" : undefined}>
        {item.text}
        {item.attachments?.length ? <Attachments list={item.attachments} /> : null}
      </div>
      {(item.queued || item.steered) && (
        <div className="at-user-note">
          {item.queued ? (
            <>
              <ClockIcon size={11} /> Waiting for the agent to read it
            </>
          ) : (
            "Sent while it worked"
          )}
        </div>
      )}
    </div>
  );
}

function Attachments({ list }: { list: Attachment[] }) {
  return (
    <div className="at-attachments">
      {list.map((a, i) =>
        a.kind === "image" && a.data ? (
          <img key={i} className="at-attachment-image" alt={a.name ?? "image"} src={`data:${a.media_type ?? "image/png"};base64,${a.data}`} />
        ) : (
          <span key={i} className="at-attachment">
            {a.name ?? a.path?.split("/").pop() ?? a.kind}
          </span>
        ),
      )}
    </div>
  );
}

/** The agent's reply: plain text while it streams in, then Markdown. */
export function AssistantMessage({ item, className }: { item: AssistantMessageItem; className?: string }) {
  const streaming = useThreadState((s) => s.streaming.has(item.id));
  if (streaming) return <StreamingText text={item.text} className={cx("at-assistant", className)} />;
  return <Markdown text={item.text} className={cx("at-assistant", className)} />;
}

/** The agent's thinking, folded away. */
export function Reasoning({ item, className }: { item: ReasoningItem; className?: string }) {
  const streaming = useThreadState((s) => s.streaming.has(item.id));
  return (
    <Collapsible label={streaming ? "Thinking…" : "Thinking"} icon={<BrainIcon />} className={cx("at-reasoning", className)}>
      <div className="at-pre-wrap">{item.text}</div>
    </Collapsible>
  );
}

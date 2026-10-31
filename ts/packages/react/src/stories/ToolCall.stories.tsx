import type { Story, StoryDefault } from "@ladle/react";
import type { ToolCall as ToolCallItem, ToolKind } from "@dire-kiwi/agent-threads-protocol";
import { useMemo } from "react";
import { ToolCall, ToolGroup } from "../components/ToolCall.js";
import type { ToolRowProps } from "../config.js";
import { ThreadProvider } from "../hooks.js";
import { allItems, FixtureThread, snapshotOf, staticSource } from "./fixtures.js";

export default { title: "ToolCall" } satisfies StoryDefault;

// Kinds the fixtures don't have a call of: made up, in the shapes the backends give them.
const made: ToolCallItem[] = [
  {
    id: "todo1",
    type: "tool_call",
    name: "TodoWrite",
    kind: "todo",
    input: {},
    status: "completed",
    todos: [
      { text: "Read the failing test", status: "completed" },
      { text: "Fix the date parsing", status: "in_progress" },
      { text: "Run the suite again", status: "pending" },
    ],
  },
  { id: "web1", type: "tool_call", name: "WebFetch", kind: "web", input: { url: "https://example.com/docs" }, url: "https://example.com/docs", status: "completed", result: { content: "Example Domain\n\nThis domain is for use in documentation examples." } },
  { id: "web2", type: "tool_call", name: "WebSearch", kind: "web", input: { query: "vitest jsdom environment" }, query: "vitest jsdom environment", status: "running" },
  { id: "grep1", type: "tool_call", name: "Grep", kind: "search", input: { pattern: "applyEvent", path: "/work/src" }, query: "applyEvent", path: "/work/src", status: "completed", result: { content: "src/store.ts\nsrc/reducer.ts" } },
  { id: "glob1", type: "tool_call", name: "Glob", kind: "search", input: { pattern: "**/*.test.ts" }, query: "**/*.test.ts", status: "completed", result: { content: "src/view.test.ts\nsrc/store.test.ts" } },
  { id: "fail1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "npm test" }, command: "npm test", status: "failed", result: { content: "1 test failed", exit_code: 1, truncated: true } },
  { id: "deny1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "rm -rf build" }, command: "rm -rf build", status: "denied" },
  { id: "cancel1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "sleep 30" }, command: "sleep 30", status: "cancelled" },
];

const calls = [...allItems.flatMap(({ item }) => (item.type === "tool_call" && item.kind !== "subagent" ? [item] : [])), ...made];
const kinds: ToolKind[] = ["shell", "read", "edit", "search", "web", "mcp", "app", "todo", "other"];

/** Every tool call in the fixtures, and some made up, by kind (click one to open it). */
export const ByKind: Story = () => {
  const source = useMemo(() => staticSource({ ...snapshotOf("claude/tool-calls"), items: calls }), []);
  return (
    <ThreadProvider source={source} onCommand={() => {}}>
      <div className="at-root" style={{ maxWidth: "48rem", display: "flex", flexDirection: "column", gap: 16 }}>
        {kinds.map((kind) => {
          const list = calls.filter((c) => c.kind === kind);
          return list.length ? (
            <div key={kind}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{kind}</div>
              <ToolGroup group={{ type: "tool_group", key: kind, calls: list }} />
            </div>
          ) : null;
        })}
      </div>
    </ThreadProvider>
  );
};

/** A call that's waiting for permission. */
export const NeedsApproval: Story = () => {
  const snapshot = snapshotOf("claude/permission-allow", (e) => e.type === "request.opened");
  const call = snapshot.items.find((i): i is ToolCallItem => i.type === "tool_call" && i.id === snapshot.requests[0]?.tool_call_id)!;
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <ToolCall call={call} />
      </div>
    </FixtureThread>
  );
};

function OrderCard({ call }: ToolRowProps) {
  const input = call.input as { order_id?: string };
  return (
    <div style={{ padding: 12, border: "1px solid var(--at-line)", borderRadius: 8 }}>
      <strong>Order #{input.order_id}</strong>
      <div style={{ opacity: 0.7 }}>{call.result?.content ?? "Looking it up…"}</div>
    </div>
  );
}
const tools = {
  lookup_order: { Row: OrderCard },
  Bash: { meta: (call: ToolCallItem) => ({ label: "Shell", summary: `${call.command ?? ""}  (from the app's renderer)` }) },
};

/** An app's renderers: lookup_order as an order card, and Bash with its own summary line. */
export const AppRenderers: Story = () => {
  const snapshot = snapshotOf("claude/app-tool");
  const shell = calls.find((c) => c.kind === "shell")!;
  const order = snapshot.items.find((i): i is ToolCallItem => i.type === "tool_call" && i.name === "lookup_order")!;
  return (
    <FixtureThread snapshot={snapshot} tools={tools}>
      <div className="at-root" style={{ maxWidth: "48rem", display: "flex", flexDirection: "column", gap: 8 }}>
        <ToolCall call={order} />
        <ToolCall call={shell} />
      </div>
    </FixtureThread>
  );
};

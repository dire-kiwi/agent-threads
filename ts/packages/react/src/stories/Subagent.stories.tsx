import type { Story, StoryDefault } from "@ladle/react";
import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { Subagent } from "../components/Subagent.js";
import { FixtureThread, snapshotOf } from "./fixtures.js";

export default { title: "Subagent" } satisfies StoryDefault;

const subagentOf = (snapshot: ReturnType<typeof snapshotOf>) => snapshot.items.find((i): i is ToolCall => i.type === "tool_call" && i.kind === "subagent")!;

/** A finished subagent (open it to see what it did, and its report). */
export const Finished: Story<{ fixture: string }> = ({ fixture }) => {
  const snapshot = snapshotOf(fixture);
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <Subagent call={subagentOf(snapshot)} />
      </div>
    </FixtureThread>
  );
};
Finished.argTypes = { fixture: { options: ["claude/subagent", "codex/subagent"], control: { type: "radio" }, defaultValue: "claude/subagent" } };

/** One that's still working: its latest step shows on its row. */
export const Working: Story<{ fixture: string }> = ({ fixture }) => {
  const snapshot = snapshotOf(fixture, (e) => e.type === "item.added" && !!e.item.parent_id && e.item.type === "tool_call");
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <Subagent call={subagentOf(snapshot)} />
      </div>
    </FixtureThread>
  );
};
Working.argTypes = Finished.argTypes;

/** One waiting on a permission request it opened. */
export const NeedsYou: Story = () => {
  const base = snapshotOf("claude/subagent", (e) => e.type === "item.added" && !!e.item.parent_id && e.item.type === "tool_call");
  const sub = subagentOf(base);
  const snapshot = {
    ...base,
    requests: [{ id: "p1", type: "permission" as const, name: "Bash", kind: "shell" as const, input: { command: "ls" }, parent_id: sub.id }],
  };
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <Subagent call={sub} />
      </div>
    </FixtureThread>
  );
};

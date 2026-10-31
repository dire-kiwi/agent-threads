import type { Story, StoryDefault } from "@ladle/react";
import { AgentsPill } from "../components/AgentsPill.js";
import { MessageList } from "../components/MessageList.js";
import { FixtureThread } from "./fixtures.js";

export default { title: "AgentsPill" } satisfies StoryDefault;

/** The thread's subagents: pick one to show its row in the thread. */
export const Subagents: Story<{ fixture: string }> = ({ fixture }) => (
  <FixtureThread name={fixture}>
    <div className="at-root" style={{ maxWidth: "48rem", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ alignSelf: "flex-end" }}>
        <AgentsPill />
      </div>
      <MessageList />
    </div>
  </FixtureThread>
);
Subagents.argTypes = { fixture: { options: ["claude/subagent", "codex/subagent"], control: { type: "radio" }, defaultValue: "claude/subagent" } };

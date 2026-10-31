import type { Story, StoryDefault } from "@ladle/react";
import { MessageList } from "../components/MessageList.js";
import { fixtureNames, FixtureThread } from "./fixtures.js";

export default { title: "MessageList" } satisfies StoryDefault;

/** The rows of a fixture's thread, without the composer or the thread's frame. */
export const Rows: Story<{ fixture: string }> = ({ fixture }) => (
  <FixtureThread name={fixture}>
    <div className="at-root" style={{ maxWidth: "48rem" }}>
      <MessageList />
    </div>
  </FixtureThread>
);
Rows.argTypes = { fixture: { options: fixtureNames, control: { type: "select" }, defaultValue: "codex/tool-calls" } };

/** A subagent's own rows, as a thread of their own (MessageList's parentId). */
export const SubagentsOwn: Story = () => (
  <FixtureThread name="codex/subagent">
    <div className="at-root" style={{ maxWidth: "48rem" }}>
      <MessageList parentId="exec-f3727a2b-07fc-453c-bd5e-9233c6996062" />
    </div>
  </FixtureThread>
);

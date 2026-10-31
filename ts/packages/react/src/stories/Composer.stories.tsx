import type { Story, StoryDefault } from "@ladle/react";
import { Composer } from "../components/Composer.js";
import { FixtureThread, snapshotOf } from "./fixtures.js";

export default { title: "Composer" } satisfies StoryDefault;

/** With no turn running: a message starts one. */
export const Idle: Story = () => (
  <FixtureThread name="codex/plain-reply">
    <div className="at-root">
      <Composer />
    </div>
  </FixtureThread>
);

/** With a turn running: a message steers it, and the stop button interrupts it. */
export const Running: Story = () => (
  <FixtureThread snapshot={snapshotOf("claude/steer", (e) => e.type === "thread.updated" && e.thread.status === "running")}>
    <div className="at-root">
      <Composer />
    </div>
  </FixtureThread>
);

/** With the app's own controls in its toolbar. */
export const WithControls: Story = () => (
  <FixtureThread name="claude/plain-reply">
    <div className="at-root">
      <Composer placeholder="Ask about your order…">
        <select className="at-button" defaultValue="default" aria-label="Permission mode">
          <option value="default">Ask</option>
          <option value="accept_edits">Accept edits</option>
          <option value="plan">Plan</option>
        </select>
      </Composer>
    </div>
  </FixtureThread>
);

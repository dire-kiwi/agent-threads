import type { Story, StoryDefault } from "@ladle/react";
import { useMemo, type CSSProperties } from "react";
import { AgentsPill } from "../components/AgentsPill.js";
import { Thread } from "../components/Thread.js";
import type { ToolRowProps } from "../config.js";
import { ThreadProvider } from "../hooks.js";
import { fixtureNames, FixtureThread, staticSource, snapshotOf, startOf, usePlayer } from "./fixtures.js";

export default { title: "Thread" } satisfies StoryDefault;

const frame: CSSProperties = { height: "calc(100vh - 2rem)", border: "1px solid var(--at-line)", borderRadius: 8, overflow: "hidden" };

type FixtureArgs = { fixture: string };
const fixtureArg = { fixture: { options: fixtureNames, control: { type: "select" as const }, defaultValue: "claude/subagent" } };

/** A fixture replayed as its backend sent it: answer its requests to go on. */
export const Replay: Story<FixtureArgs & { speed: number }> = ({ fixture, speed }) => {
  const player = usePlayer(fixture, speed);
  return (
    <ThreadProvider source={player.source} onCommand={player.onCommand}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <button type="button" className="at-button" onClick={player.restart}>
          {player.done ? "Play again" : "Restart"}
        </button>
        <AgentsPill />
      </div>
      <div style={frame}>
        <Thread />
      </div>
    </ThreadProvider>
  );
};
Replay.argTypes = { ...fixtureArg, speed: { options: [0.5, 1, 2, 4], control: { type: "radio" }, defaultValue: 1 } };

/** A fixture's thread once all its events are in. */
export const Finished: Story<FixtureArgs> = ({ fixture }) => (
  <FixtureThread name={fixture}>
    <div style={frame}>
      <Thread />
    </div>
  </FixtureThread>
);
Finished.argTypes = fixtureArg;

/** A thread with nothing in it yet. */
export const Empty: Story = () => {
  const source = useMemo(() => staticSource(startOf("claude/plain-reply")), []);
  return (
    <div style={frame}>
      <Thread source={source} onCommand={() => {}} empty="Ask the agent anything." />
    </div>
  );
};

function OrderCard({ call }: ToolRowProps) {
  const input = call.input as { order_id?: string };
  return (
    <div style={{ padding: 12, border: "1px solid var(--at-line)", borderRadius: 8, background: "var(--at-panel)" }}>
      <strong>Order #{input.order_id}</strong> · {call.status === "completed" ? call.result?.content : "looking it up…"}
    </div>
  );
}
const tools = { lookup_order: { Row: OrderCard, alone: true } };
const renderMarkdown = (text: string) => <div style={{ fontStyle: "italic" }}>{text}</div>;

/** The extension points: lookup_order drawn as an order card, and the app's own Markdown renderer. */
export const AppRenderers: Story = () => {
  const source = useMemo(() => staticSource(snapshotOf("claude/app-tool")), []);
  return (
    <div style={frame}>
      <Thread source={source} onCommand={() => {}} tools={tools} renderMarkdown={renderMarkdown} />
    </div>
  );
};

/** The theme is CSS variables: here, a few changed on the thread. */
export const CustomTheme: Story = () => {
  const source = useMemo(() => staticSource(snapshotOf("codex/tool-calls")), []);
  const vars = { "--at-accent": "#0d9488", "--at-accent-strong": "#0f766e", "--at-user-bg": "#ccfbf1", "--at-user-border": "#99f6e4", "--at-radius": "2px", "--at-font": "Georgia, serif" } as CSSProperties;
  return (
    <div style={{ ...frame, ...vars }}>
      <Thread source={source} onCommand={() => {}} />
    </div>
  );
};

import type { Story, StoryDefault } from "@ladle/react";
import { itemPage, snapshotWindow, type Item, type Snapshot, type ThreadRequest } from "@dire-kiwi/agent-threads-protocol";
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

/**
 * A long thread (600 items) that opens at a window of its latest 40 and loads 40 at a time, a bit
 * slowly, as it's scrolled up: what's on screen stays put, and tool groups keep what's opened in
 * them. A subagent started early on is still going, and asks for a permission: revealing it (from
 * the request, or the agents pill) loads back to where it started.
 */
export const LongThread: Story<{ delay: number }> = ({ delay }) => {
  const source = useMemo(() => {
    const whole = longThread();
    return {
      snapshot: snapshotWindow(whole, 40),
      subscribe: () => () => {},
      loadEarlier: (before: number) => new Promise<ReturnType<typeof itemPage>>((r) => setTimeout(() => r(itemPage(whole, before, 40)), delay)),
    };
  }, [delay]);
  return (
    <ThreadProvider source={source} onCommand={() => {}}>
      <div style={{ marginBottom: 8 }}>
        <AgentsPill />
      </div>
      <div style={frame}>
        <Thread />
      </div>
    </ThreadProvider>
  );
};
LongThread.argTypes = { delay: { options: [0, 400, 1500], control: { type: "radio" }, defaultValue: 400 } };

function longThread(): Snapshot {
  const thread = { id: "long", harness: "claude", status: "waiting" as const, created_at: "2026-11-01T00:00:00Z" };
  const items: Item[] = [];
  const requests: ThreadRequest[] = [];
  const call = (id: string, command: string, parent_id?: string): Item => ({
    id, type: "tool_call", name: "Bash", kind: "shell", input: { command }, command, status: "completed",
    result: { content: `ran ${command}` }, turn_id: `t${Math.floor(items.length / 30)}`, ...(parent_id ? { parent_id } : {}),
  });
  for (let n = 0; items.length < 600; n++) {
    const turn = `t${Math.floor(items.length / 30)}`;
    if (n === 2) items.push({ id: "agent", type: "tool_call", name: "Agent", kind: "subagent", input: { description: "Survey the codebase", prompt: "Look through every package and list what each does." }, status: "running", title: "Survey the codebase", turn_id: turn });
    items.push({ id: `u${n}`, type: "user_message", text: `Message ${n}: carry on with the next part.`, turn_id: turn });
    items.push({ id: `a${n}`, type: "assistant_message", text: `Reply ${n}. Looking at it now, step by step.`, turn_id: turn });
    for (let k = 0; k < 1 + (n % 4); k++) items.push(call(`c${n}-${k}`, `npm test -- part-${n}-${k}`));
    if (n % 5 === 0) items.push({ id: `s${n}`, type: "assistant_message", text: `The subagent's note ${n}.`, parent_id: "agent", turn_id: turn });
    if (n % 7 === 3) {
      const id = `c${n}-0`;
      requests.push({ id: `p${n}`, type: "permission", name: "Bash", kind: "shell", input: { command: `npm test -- part-${n}-0` }, tool_call_id: id, turn_id: turn, title: `npm test -- part-${n}-0`, resolution: n % 3 ? { outcome: "allow" } : { outcome: "deny", message: "Not that part." } });
    }
  }
  items.push(call("asking", "rm -rf build", "agent"));
  requests.push({ id: "open", type: "permission", name: "Bash", kind: "shell", input: { command: "rm -rf build" }, tool_call_id: "asking", parent_id: "agent", title: "rm -rf build" });
  return { thread, items, requests, seq: items.length + requests.length };
}

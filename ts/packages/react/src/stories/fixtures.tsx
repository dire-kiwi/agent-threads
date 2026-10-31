// The fixtures' event streams (spec/fixtures/<harness>/<scenario>/expected.jsonl) for the stories:
// a thread at any point in a fixture, and a player that replays one as a backend would, pausing at
// each request until it's answered.

import { applyEvents, initialState, type Command, type Item, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { action } from "@ladle/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThreadConfig } from "../config.js";
import { ThreadProvider } from "../hooks.js";
import type { ThreadSource } from "../store.js";

const raw = import.meta.glob("../../../../../spec/fixtures/*/*/expected.jsonl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Each fixture's events, by "<harness>/<scenario>". Its working directory is /work, as in the recordings. */
export const fixtures: Record<string, ThreadEvent[]> = Object.fromEntries(
  Object.entries(raw)
    .map(([path, text]): [string, ThreadEvent[]] => [
      path.replace(/^.*fixtures\/(.*)\/expected\.jsonl$/, "$1"),
      text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l.replaceAll("{{cwd}}", "/work")) as ThreadEvent),
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);

export const fixtureNames = Object.keys(fixtures);

/** The thread before any of a fixture's events. */
export function startOf(name: string): Snapshot {
  const first = fixtures[name]![0]!;
  if (first.type !== "thread.updated") throw new Error(`${name} doesn't start with thread.updated`);
  return initialState(first.thread);
}

/** A fixture's thread after its events up to the first that `until` matches (all of them without it). */
export function snapshotOf(name: string, until?: (e: ThreadEvent) => boolean): Snapshot {
  const events = fixtures[name]!;
  const at = until ? events.findIndex(until) + 1 : events.length;
  return applyEvents(startOf(name), events.slice(0, at || events.length));
}

/** Every item of every fixture, with the fixture it's from. */
export const allItems: { fixture: string; item: Item }[] = fixtureNames.flatMap((fixture) => snapshotOf(fixture).items.map((item) => ({ fixture, item })));

/** A source that stays as it is. */
export const staticSource = (snapshot: Snapshot): ThreadSource => ({ snapshot, subscribe: () => () => {} });

const logCommand = action("onCommand");

/** Components inside it draw a fixture's thread at a point in it; their commands go to the actions panel. */
export function FixtureThread({ name, until, snapshot, children, ...config }: { name?: string; until?: (e: ThreadEvent) => boolean; snapshot?: Snapshot; children: ReactNode } & ThreadConfig) {
  const source = useMemo(() => staticSource(snapshot ?? snapshotOf(name!, until)), [name, snapshot]);
  return (
    <ThreadProvider source={source} onCommand={logCommand} {...config}>
      {children}
    </ThreadProvider>
  );
}

/**
 * A fixture's events, with the replies it has whole broken into deltas (as a backend with partial
 * output sends them), so a replay shows them streaming in.
 */
export function withDeltas(events: ThreadEvent[]): ThreadEvent[] {
  const out: ThreadEvent[] = [];
  const streamed = new Map<string, string>();
  for (const e of events) {
    if (e.type === "item.added" && e.item.type === "assistant_message") streamed.set(e.item.id, e.item.text);
    if (e.type === "delta") streamed.set(e.item_id, (streamed.get(e.item_id) ?? "") + e.text);
    const text = e.type === "item.updated" ? e.patch.text : undefined;
    if (e.type === "item.updated" && typeof text === "string" && streamed.has(e.item_id)) {
      const sofar = streamed.get(e.item_id)!;
      if (text.startsWith(sofar))
        for (const chunk of text.slice(sofar.length).match(/\S+\s*|\s+/g) ?? [])
          out.push({ type: "delta", thread_id: e.thread_id, seq: e.seq - 1, item_id: e.item_id, kind: "text", text: chunk });
      streamed.delete(e.item_id);
    }
    out.push(e);
  }
  return out;
}

/**
 * Replays a fixture as a backend would: its events one by one (deltas quicker), holding each
 * request's resolution until it's answered with a respond command. Other commands go to the
 * actions panel.
 */
export function usePlayer(name: string, speed = 1) {
  const [run, setRun] = useState(0);
  const events = useMemo(() => withDeltas(fixtures[name]!), [name]);
  const listeners = useRef(new Set<(e: ThreadEvent) => void>());
  const waiting = useRef<string | null>(null);
  const resume = useRef<() => void>(() => {});
  const [done, setDone] = useState(false);
  // A new source for each run, starting from the thread before its events.
  const source = useMemo<ThreadSource>(
    () => ({
      snapshot: startOf(name),
      subscribe(fn) {
        listeners.current.add(fn);
        return () => void listeners.current.delete(fn);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, run],
  );
  useEffect(() => {
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDone(false);
    const step = () => {
      const e = events[i];
      if (!e) return setDone(true);
      // A request's resolution waits for the user's answer.
      if (e.type === "request.resolved" && waiting.current !== `answered:${e.request_id}`) {
        waiting.current = e.request_id;
        resume.current = () => {
          waiting.current = `answered:${e.request_id}`;
          timer = setTimeout(step, 300 / speed);
        };
        return;
      }
      i++;
      for (const l of listeners.current) l(e);
      timer = setTimeout(step, (e.type === "delta" ? 40 : 350) / speed);
    };
    timer = setTimeout(step, 300 / speed);
    return () => clearTimeout(timer);
  }, [source, events, speed]);
  const onCommand = (c: Command) => {
    logCommand(c);
    if (c.type === "respond" && c.request_id === waiting.current) resume.current();
  };
  return { source, onCommand, done, restart: () => setRun((n) => n + 1) };
}

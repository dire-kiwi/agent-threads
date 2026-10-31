// The headless layer: useThread for a thread's state, and ThreadProvider for the components, which
// gives them the state, the app's onCommand and the app's renderers. The SDK has no network layer:
// the app's transport brings the events (ThreadSource) and takes the commands (onCommand).

import type { Attachment, Command, PermissionMode, Resolution } from "@dire-kiwi/agent-threads-protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ThreadStore, type ThreadSource, type ThreadState } from "./store.js";
import type { ThreadConfig } from "./config.js";
import { lineage } from "./view.js";

/**
 * The store for `source`, connected to it while the component is mounted. A new source (e.g. after
 * a reconnect, with a fresh snapshot) makes a new store.
 */
export function useThreadStore(source: ThreadSource): ThreadStore {
  // In state rather than a memo, which React may drop (and the events applied since with it).
  const [kept, keep] = useState(() => new ThreadStore(source));
  let store = kept;
  if (store.source !== source) {
    store = new ThreadStore(source);
    keep(store);
  }
  useEffect(() => store.connect(), [store]);
  return store;
}

/**
 * A thread's state, from `source`: its snapshot with the events since applied by applyEvent. Gaps
 * in seq ask the source for a resync. The component redraws for every event; inside a
 * ThreadProvider, useThreadState picks out just what a component needs.
 */
export function useThread(source: ThreadSource): ThreadState {
  const store = useThreadStore(source);
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** What a component sends commands with: the app carries them to the backend, and may return a promise to say how it went. */
export type CommandHandler = (command: Command) => void | Promise<unknown>;

interface ThreadContext {
  store: ThreadStore;
  command: CommandHandler;
  focus: Focus;
}

const Ctx = createContext<ThreadContext | null>(null);
const ConfigCtx = createContext<ThreadConfig>({});

export interface ThreadProviderProps extends ThreadConfig {
  /** Where the thread's events come from. */
  source: ThreadSource;
  /** Called with each command (send, interrupt, respond, set_options) for the app to send to the backend. */
  onCommand: CommandHandler;
  children?: ReactNode;
}

/**
 * Gives the components inside it a thread: its state from `source`, `onCommand` for the commands
 * they send, and the app's renderers (see ThreadConfig). Pass renderers that stay the same (made
 * once, or memoized): new ones redraw every row.
 */
export function ThreadProvider({ source, onCommand, children, tools, toolKinds, renderMarkdown, renderItem }: ThreadProviderProps) {
  const store = useThreadStore(source);
  const latest = useRef(onCommand);
  latest.current = onCommand;
  const [focus] = useState(() => new Focus());
  const ctx = useMemo<ThreadContext>(() => ({ store, command: (c) => latest.current(c), focus }), [store, focus]);
  const config = useMemo<ThreadConfig>(() => ({ tools, toolKinds, renderMarkdown, renderItem }), [tools, toolKinds, renderMarkdown, renderItem]);
  return (
    <Ctx.Provider value={ctx}>
      <ConfigCtx.Provider value={config}>{children}</ConfigCtx.Provider>
    </Ctx.Provider>
  );
}

function useCtx(): ThreadContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("agent-threads: this component needs to be inside a <ThreadProvider> (or a <Thread> given a source)");
  return ctx;
}

/** Whether there's a ThreadProvider around. */
export const useHasThread = (): boolean => useContext(Ctx) !== null;

/**
 * Part of the thread's state, inside a ThreadProvider: the component redraws only when it changes.
 * `pick` mustn't make a new object each time (picking a part of the state, or a Map's get, is fine).
 */
export function useThreadState<T>(pick: (state: ThreadState) => T): T;
export function useThreadState(): ThreadState;
export function useThreadState<T>(pick?: (state: ThreadState) => T): T | ThreadState {
  const { store } = useCtx();
  const get = () => (pick ? pick(store.getState()) : store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

/** The app's renderers (see ThreadConfig). */
export const useThreadConfig = (): ThreadConfig => useContext(ConfigCtx);

// ---------- commands ----------

/** Sends a raw command for the thread (its thread_id filled in). */
export function useCommand(): (command: DistributiveOmit<Command, "thread_id">) => void | Promise<unknown> {
  const { store, command } = useCtx();
  return useCallback((c) => command({ ...c, thread_id: store.getState().snapshot.thread.id } as Command), [store, command]);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SendOptions {
  attachments?: Attachment[];
  /** Copied to the user_message the backend makes of it. Made up if left out. */
  client_id?: string;
}

/** Sends the agent a message: it starts a turn, or steers the running one. */
export function useSend(): (text: string, options?: SendOptions) => void | Promise<unknown> {
  const send = useCommand();
  return useCallback(
    (text, options) =>
      send({ type: "send", text, ...(options?.attachments?.length ? { attachments: options.attachments } : {}), client_id: options?.client_id ?? clientId() }),
    [send],
  );
}

/** Stops the running turn. */
export function useInterrupt(): () => void | Promise<unknown> {
  const send = useCommand();
  return useCallback(() => send({ type: "interrupt" }), [send]);
}

/** Answers an open request (a permission or a question). */
export function useRespond(): (requestId: string, resolution: Resolution) => void | Promise<unknown> {
  const send = useCommand();
  return useCallback((request_id, resolution) => send({ type: "respond", request_id, resolution }), [send]);
}

export interface ThreadOptions {
  model?: string;
  effort?: string;
  permission_mode?: PermissionMode;
}

/** Changes the thread's model, effort or permission mode; the ones left out stay as they are. */
export function useSetOptions(): (options: ThreadOptions) => void | Promise<unknown> {
  const send = useCommand();
  return useCallback((options) => send({ type: "set_options", ...options }), [send]);
}

let sent = 0;
function clientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `c${Date.now().toString(36)}${(++sent).toString(36)}`;
}

// ---------- revealing a subagent ----------

/**
 * Asks the thread to show a subagent's row: the rows around it open, and it scrolls into view. The
 * request is pending until that row has shown itself, so rows that mount on the way (as their
 * parents open) still act on it, and ones that mount after it don't.
 */
class Focus {
  target: { id: string; n: number } | null = null;
  handled = 0;
  private listeners = new Set<() => void>();
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  pending = () => (this.target && this.target.n > this.handled ? this.target : null);
  reveal(id: string) {
    this.target = { id, n: (this.target?.n ?? 0) + 1 };
    for (const l of this.listeners) l();
  }
  handle(n: number) {
    this.handled = Math.max(this.handled, n);
    for (const l of this.listeners) l();
  }
}

/** Shows a subagent's row in the thread (see Focus). */
export function useReveal(): (id: string) => void {
  const { focus } = useCtx();
  return useCallback((id) => focus.reveal(id), [focus]);
}

/**
 * For a row that holds subagent `id`, or can hold the one being revealed: `open` if the subagent
 * being revealed is in it (or is it), `self` if it's the one, and `done` to say it's shown.
 */
export function useRevealed(ids: readonly string[]): { open: boolean; self: boolean; done: () => void } | null {
  const { focus, store } = useCtx();
  const target = useSyncExternalStore(focus.subscribe, focus.pending, focus.pending);
  return useMemo(() => {
    if (!target) return null;
    const path = lineage(store.getState().view.subagents, target.id);
    if (!ids.some((id) => path.includes(id))) return null;
    return { open: true, self: ids.length === 1 && ids[0] === target.id, done: () => focus.handle(target.n) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ids.join(" ")]);
}

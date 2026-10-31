// AgentThreads: the backend an app runs. It creates threads, takes commands, runs each thread's
// harness, and sends every thread's events to its subscribers, which the app wires to its own
// transport.

import {
  applyEvents,
  initialState,
  type Attachment,
  type Command,
  type PermissionMode,
  type Resolution,
  type Snapshot,
  type Thread,
  type ThreadEvent,
} from "@dire-kiwi/agent-threads-protocol";
import { claudeCode } from "./claude/driver.js";
import type { Harness, McpServer, Skill, ThreadConfig } from "./harness.js";
import { newId } from "./ids.js";
import type { PermissionPolicy } from "./permissions.js";
import { direct, type Spawner } from "./spawner.js";
import type { Store } from "./store.js";
import { MemoryStore } from "./stores/memory.js";
import { ThreadRuntime } from "./thread.js";
import type { Tool } from "./tools.js";

/** Tools, MCP servers, skills and the permission policy: for every thread, or for one. */
export interface Capabilities {
  tools?: Tool[];
  mcpServers?: { [name: string]: McpServer };
  skills?: Skill[];
  /** Whether the agent may call a tool: allow, deny or ask the user. The default asks. */
  permissions?: PermissionPolicy;
  /** Added to the harness's own system prompt. */
  systemPrompt?: string;
}

export interface AgentThreadsOptions extends Capabilities {
  /** Where threads are kept: the app's, which it closes after this. A MemoryStore by default. */
  store?: Store;
  /** The harnesses threads can run on, by name. Claude Code (`claude`) by default. */
  harnesses?: { [name: string]: Harness };
  /** How harness processes are started. Direct child processes by default. */
  spawner?: Spawner;
  /** Called with errors that aren't any command's: a store that fails, a subscriber that throws. */
  onError?: (error: unknown) => void;
}

export interface CreateOptions extends Capabilities {
  /** The harness to run on; the first configured one by default. */
  harness?: string;
  model?: string;
  effort?: string;
  permission_mode?: PermissionMode;
  /** The working directory; the process's by default. */
  cwd?: string;
  title?: string;
  /** The app's own data about the thread (e.g. the user it's for); tools and the policy get it. */
  metadata?: { [k: string]: unknown };
  /** The thread's id; a new one by default. */
  id?: string;
}

/** A command that can't be carried out: an unknown thread, or a malformed command. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export class AgentThreads {
  readonly store: Store;
  readonly harnesses: { [name: string]: Harness };
  readonly spawner: Spawner;
  #options: AgentThreadsOptions;
  #threads = new Map<string, ThreadRuntime>();
  #loading = new Map<string, Promise<ThreadRuntime>>();
  #configs = new Map<string, Capabilities>();
  #subscribers = new Set<(event: ThreadEvent) => void>();
  #closed = false;

  constructor(options: AgentThreadsOptions = {}) {
    this.#options = options;
    this.store = options.store ?? new MemoryStore();
    this.harnesses = options.harnesses ?? { claude: claudeCode() };
    this.spawner = options.spawner ?? direct();
  }

  // ---------- threads ----------

  async create(options: CreateOptions = {}): Promise<Thread> {
    this.#open();
    const harness = options.harness ?? Object.keys(this.harnesses)[0];
    if (!harness || !this.harnesses[harness]) throw new CommandError(`there's no harness ${JSON.stringify(harness)}`);
    const thread: Thread = {
      id: options.id ?? newId("th"),
      harness,
      status: "idle",
      ...(options.title ? { title: options.title } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      permission_mode: options.permission_mode ?? "default",
      cwd: options.cwd ?? process.cwd(),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      created_at: new Date().toISOString(),
    };
    const { tools, mcpServers, skills, permissions, systemPrompt } = options;
    this.#configs.set(thread.id, { tools, mcpServers, skills, permissions, systemPrompt });
    await this.store.createThread(thread);
    const rt = this.#runtime(initialState(thread));
    rt.emit({ type: "thread.updated", thread });
    await rt.saved();
    return thread;
  }

  /**
   * Sets a thread's own tools, MCP servers, skills, policy or system prompt, which aren't stored:
   * e.g. for a thread created before the app restarted. They apply from its next turn.
   */
  async configure(threadId: string, capabilities: Capabilities): Promise<void> {
    this.#configs.set(threadId, { ...this.#configs.get(threadId), ...capabilities });
    const rt = this.#threads.get(threadId);
    if (rt) {
      rt.config = this.#config(threadId);
      rt.policy = this.#policy(threadId);
      rt.session?.optionsChanged();
    }
  }

  /** The thread, or null. */
  async get(threadId: string): Promise<Thread | null> {
    return this.#threads.get(threadId)?.thread ?? (await this.store.getThread(threadId));
  }

  async list(): Promise<Thread[]> {
    const threads = await this.store.listThreads();
    return threads.map((t) => this.#threads.get(t.id)?.thread ?? t);
  }

  /** Deletes a thread, stopping its harness first. Whether there was one. */
  async delete(threadId: string): Promise<boolean> {
    const rt = this.#threads.get(threadId);
    if (rt) {
      await rt.session?.close();
      rt.dispose();
      this.#threads.delete(threadId);
    }
    this.#configs.delete(threadId);
    return this.store.deleteThread(threadId);
  }

  /** The thread's state now, including text streamed so far. */
  async snapshot(threadId: string): Promise<Snapshot> {
    return structuredClone((await this.#load(threadId)).snapshot);
  }

  /** The thread's saved events after `seq`, for a client catching up. */
  async eventsSince(threadId: string, seq: number, limit?: number): Promise<ThreadEvent[]> {
    const rt = this.#threads.get(threadId);
    if (rt) await rt.saved();
    else if (!(await this.store.getThread(threadId))) throw new CommandError(`there's no thread ${threadId}`);
    return this.store.readEvents(threadId, { after: seq, ...(limit !== undefined ? { limit } : {}) });
  }

  /** Calls `fn` with every thread's events, deltas included. Returns a function that stops it. */
  subscribe(fn: (event: ThreadEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  // ---------- commands ----------

  /** Carries out a command from a client. Throws a CommandError for one it can't. */
  async handle(command: Command): Promise<void> {
    if (!command || typeof command !== "object") throw new CommandError("a command is an object");
    if (typeof command.thread_id !== "string") throw new CommandError("a command needs a thread_id");
    switch (command.type) {
      case "send":
        if (typeof command.text !== "string") throw new CommandError("send needs text");
        return this.send(command.thread_id, command.text, {
          ...(command.attachments ? { attachments: command.attachments } : {}),
          ...(command.client_id ? { client_id: command.client_id } : {}),
        });
      case "interrupt":
        return this.interrupt(command.thread_id);
      case "respond":
        if (typeof command.request_id !== "string" || !command.resolution) throw new CommandError("respond needs a request_id and a resolution");
        return this.respond(command.thread_id, command.request_id, command.resolution);
      case "set_options": {
        const { type: _t, thread_id, ...options } = command;
        return this.setOptions(thread_id, options);
      }
      default:
        throw new CommandError(`there's no command ${JSON.stringify((command as { type?: unknown }).type)}`);
    }
  }

  /** Sends the agent a message: starts a turn, or steers the running one. */
  async send(threadId: string, text: string, options: { attachments?: Attachment[]; client_id?: string } = {}): Promise<void> {
    this.#open();
    const rt = await this.#load(threadId);
    rt.send({ text, ...options });
  }

  /** Stops the running turn, if there is one. */
  async interrupt(threadId: string): Promise<void> {
    (await this.#load(threadId)).interrupt();
  }

  /** Answers an open request; does nothing if it isn't open. */
  async respond(threadId: string, requestId: string, resolution: Resolution): Promise<void> {
    (await this.#load(threadId)).respond(requestId, resolution);
  }

  /** Changes the thread's model, effort or permission mode, from its next turn. */
  async setOptions(threadId: string, options: { model?: string; effort?: string; permission_mode?: PermissionMode }): Promise<void> {
    const rt = await this.#load(threadId);
    const patch: Partial<Thread> = {};
    if (options.model !== undefined) patch.model = options.model || undefined;
    if (options.effort !== undefined) patch.effort = options.effort || undefined;
    if (options.permission_mode !== undefined) patch.permission_mode = options.permission_mode;
    const before = JSON.stringify(rt.thread);
    rt.setThread(patch);
    if (JSON.stringify(rt.thread) !== before) rt.session?.optionsChanged();
  }

  /**
   * Stops every harness process and saves everything. The instance can't be used after; the
   * store can (the app closes it).
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#loading.values()]);
    const threads = [...this.#threads.values()];
    await Promise.all(
      threads.map(async (rt) => {
        // A turn cut short by shutting down ends as an interrupted one.
        rt.closing = true;
        if (rt.turn) rt.turn.interrupted = true;
        try {
          await rt.session?.close();
        } catch (e) {
          this.#error(e);
        }
        if (rt.turn) rt.endTurn({ ok: false });
        await rt.saveSnapshot();
        rt.dispose();
      }),
    );
  }

  // ---------- internals ----------

  #open(): void {
    if (this.#closed) throw new CommandError("this AgentThreads is closed");
  }

  #config(threadId: string): ThreadConfig {
    const own = this.#configs.get(threadId) ?? {};
    const all = this.#options;
    const tools = new Map<string, Tool>();
    for (const t of [...(all.tools ?? []), ...(own.tools ?? [])]) tools.set(t.name, t);
    const systemPrompt = [all.systemPrompt, own.systemPrompt].filter(Boolean).join("\n\n");
    return {
      tools: [...tools.values()],
      mcpServers: { ...all.mcpServers, ...own.mcpServers },
      skills: [...(all.skills ?? []), ...(own.skills ?? [])],
      ...(systemPrompt ? { systemPrompt } : {}),
    };
  }

  #policy(threadId: string): PermissionPolicy {
    return this.#configs.get(threadId)?.permissions ?? this.#options.permissions ?? "ask";
  }

  #runtime(state: Snapshot): ThreadRuntime {
    const id = state.thread.id;
    const host = {
      store: this.store,
      spawner: this.spawner,
      publish: (e: ThreadEvent) => this.#publish(e),
      error: (e: unknown) => this.#error(e),
    };
    const rt = new ThreadRuntime(host, state, this.#config(id), this.#policy(id));
    const harness = this.harnesses[state.thread.harness];
    if (!harness) throw new CommandError(`thread ${id} runs on ${state.thread.harness}, which isn't configured`);
    rt.session = harness.open(rt);
    this.#threads.set(id, rt);
    return rt;
  }

  /** The live thread, loaded from the store if it isn't yet. */
  #load(threadId: string): Promise<ThreadRuntime> {
    const live = this.#threads.get(threadId);
    if (live) return Promise.resolve(live);
    let loading = this.#loading.get(threadId);
    if (!loading) {
      loading = this.#fromStore(threadId).finally(() => this.#loading.delete(threadId));
      this.#loading.set(threadId, loading);
    }
    return loading;
  }

  async #fromStore(threadId: string): Promise<ThreadRuntime> {
    const thread = await this.store.getThread(threadId);
    if (!thread) throw new CommandError(`there's no thread ${threadId}`);
    const snap = await this.store.loadSnapshot(threadId);
    const events = await this.store.readEvents(threadId, { after: snap?.seq ?? 0 });
    let state = applyEvents(snap ?? initialState(thread), events);
    if (state.seq === 0) state = initialState(thread);
    const rt = this.#runtime(state);
    // The process that ran its turn went with the backend before this one.
    const s = rt.thread.status;
    if (s === "running" || s === "waiting" || rt.thread.run) recoverLost(rt);
    return rt;
  }

  #publish(event: ThreadEvent): void {
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch (e) {
        this.#error(e);
      }
    }
  }

  #error(error: unknown): void {
    if (this.#options.onError) this.#options.onError(error);
    else console.error("agent-threads:", error);
  }
}

/** Ends a turn whose process was lost when the backend stopped. */
function recoverLost(rt: ThreadRuntime): void {
  const s = rt.thread.status;
  if (s === "running" || s === "waiting") {
    const items = rt.snapshot.items;
    const turnId = [...items].reverse().find((i) => i.turn_id)?.turn_id ?? newId("turn");
    rt.turn = { id: turnId, interrupted: false };
    for (const r of rt.snapshot.requests) {
      rt.emit({ type: "request.resolved", request_id: r.id, resolution: { outcome: "cancel" } });
    }
    rt.endTurn({ ok: false, error: "The backend stopped while this turn was running." });
  }
  rt.setThread({ run: undefined });
}

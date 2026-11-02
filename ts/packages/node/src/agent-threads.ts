// AgentThreads: the backend an app runs. It creates threads, takes commands, runs each thread's
// harness, and sends every thread's events to its subscribers, which the app wires to its own
// transport.

import {
  applyEvent,
  applyEvents,
  initialState,
  itemPage,
  openRequests,
  snapshotWindow,
  validate,
  type Attachment,
  type Command,
  type Item,
  type ItemPage,
  type PermissionMode,
  type Resolution,
  type Snapshot,
  type Thread,
  type ThreadEvent,
} from "@dire-kiwi/agent-threads-protocol";
import { claudeCode } from "./claude/driver.js";
import { codex } from "./codex/driver.js";
import { CommandError } from "./errors.js";
import type { Harness, HarnessMessage, LaunchOptions, McpServer, Skill, ThreadConfig } from "./harness.js";
import { newId } from "./ids.js";
import { splitStored, storedThread } from "./launch.js";
import type { PermissionPolicy } from "./permissions.js";
import { RewindError } from "./sessions.js";
import { direct, type Spawner } from "./spawner.js";
import type { RunRecord, Store } from "./store.js";
import { MemoryStore } from "./stores/memory.js";
import { ThreadRuntime, type Turn } from "./thread.js";
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
  /** The harnesses threads can run on, by name. Claude Code (`claude`) and Codex (`codex`) by default. */
  harnesses?: { [name: string]: Harness };
  /**
   * How harness processes are started: direct child processes by default, which end with the
   * backend. With `shim(path)` they outlive it: call recover() when the app starts, to re-attach.
   */
  spawner?: Spawner;
  /** Called with errors that aren't any command's: a store that fails, a subscriber that throws. */
  onError?: (error: unknown) => void;
  /**
   * Fill in `raw` on events, items and requests: the harness message each came from. Off by
   * default; it's saved with the events, so they take more room.
   */
  raw?: boolean;
  /**
   * Called with every line a thread's harness process writes, once its driver has dealt with it:
   * for what the protocol leaves out (Claude Code's system messages and rate limit events, Codex's
   * token usage...). It runs as the output is read, so it should be quick.
   */
  onHarnessMessage?: (message: HarnessMessage) => void;
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
  /**
   * The harness's own session to adopt (Claude Code's session id, Codex's thread id): the thread's
   * first turn resumes it. Its messages so far aren't made into items.
   */
  session_id?: string;
  /**
   * How its harness process is started (args, environment, directories, config directory), on top
   * of the harness's options. They're stored with the thread, but not sent to clients.
   */
  launch?: LaunchOptions;
}

/** A thread's options, for setOptions(). */
export interface ThreadOptions {
  /** "" clears it. */
  model?: string;
  /** "" clears it. */
  effort?: string;
  permission_mode?: PermissionMode;
  /**
   * Replaces how the thread's harness process is started, in full. Only the app sets it: the
   * `set_options` command doesn't.
   */
  launch?: LaunchOptions;
}

/** What recover() did. */
export interface Recovered {
  /** Threads whose runs it re-attached to (including runs that ended while the backend was down). */
  reattached: string[];
  /** Threads whose runs it couldn't re-attach to, and stopped: their turns ended. */
  lost: string[];
}

export { CommandError, ControlError } from "./errors.js";

/** How often the shim spawner's finished runs are pruned. */
const PRUNE_EVERY_MS = 3600_000;


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
  #stopping: Promise<void> | undefined;
  #pruner: NodeJS.Timeout | undefined;

  constructor(options: AgentThreadsOptions = {}) {
    this.#options = options;
    this.store = options.store ?? new MemoryStore();
    this.harnesses = options.harnesses ?? { claude: claudeCode(), codex: codex() };
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
      ...(options.session_id ? { session_id: options.session_id } : {}),
      permission_mode: options.permission_mode ?? "default",
      cwd: options.cwd ?? process.cwd(),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      created_at: new Date().toISOString(),
    };
    const { tools, mcpServers, skills, permissions, systemPrompt } = options;
    this.#configs.set(thread.id, { tools, mcpServers, skills, permissions, systemPrompt });
    const launch = options.launch ?? {};
    await this.store.createThread(storedThread(thread, launch));
    const rt = this.#runtime(initialState(thread), launch);
    rt.emit({ type: "thread.updated", thread });
    await rt.saved();
    return thread;
  }

  /**
   * Sets a thread's own tools, MCP servers, skills, policy or system prompt, which aren't stored:
   * e.g. for a thread created before the app restarted. The policy and the tools' code change at
   * once, even for a running turn; what the harness is told when its process starts (which tools
   * there are, MCP servers, skills, the system prompt) changes from its next turn.
   */
  async configure(threadId: string, capabilities: Capabilities): Promise<void> {
    this.#open();
    this.#configs.set(threadId, { ...this.#configs.get(threadId), ...capabilities });
    const rt = this.#threads.get(threadId);
    if (rt) {
      rt.config = this.#config(threadId);
      rt.policy = this.#policy(threadId);
      rt.session?.configChanged();
      // A run that outlives the backend is saved knowing it, without an event to save it with.
      rt.persist().catch(() => {}); // A store that fails has said so.
    }
  }

  /** The thread, or null. */
  async get(threadId: string): Promise<Thread | null> {
    const live = this.#threads.get(threadId)?.thread;
    if (live) return live;
    const stored = await this.store.getThread(threadId);
    return stored && splitStored(stored).thread;
  }

  async list(): Promise<Thread[]> {
    const threads = await this.store.listThreads();
    return threads.map((t) => this.#threads.get(t.id)?.thread ?? splitStored(t).thread);
  }

  /** Deletes a thread, stopping its harness first. Whether there was one. */
  async delete(threadId: string): Promise<boolean> {
    this.#open();
    const rt = this.#threads.get(threadId);
    if (rt) {
      await rt.session?.close();
      rt.dispose();
      this.#threads.delete(threadId);
    }
    this.#configs.delete(threadId);
    return this.store.deleteThread(threadId);
  }

  /**
   * The thread's state now, including text streamed so far. With a `limit`, a window of it: its
   * last `limit` items and what they need from before them, for a client that loads earlier ones
   * with itemsBefore (spec/PROTOCOL.md, "Windows").
   */
  async snapshot(threadId: string, options?: { limit?: number }): Promise<Snapshot> {
    this.#open();
    return structuredClone(snapshotWindow((await this.#load(threadId)).snapshot, options?.limit));
  }

  /**
   * The thread's items before index `before` (a window's `start`), at most `limit` of them, with
   * the subagent calls they belong to and the requests they have: a page for a client that has a
   * window to load earlier items into.
   */
  async itemsBefore(threadId: string, before: number, limit: number): Promise<ItemPage> {
    this.#open();
    return structuredClone(itemPage((await this.#load(threadId)).snapshot, before, limit));
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

  /**
   * Picks up the runs that were going when the backend last stopped (with the shim spawner, whose
   * runs outlive it): it re-attaches to those still running, and follows those that ended while it
   * was down to their end, so their threads carry on. Runs it can't re-attach to are stopped, and
   * their turns end. Call it when the app starts, before taking commands; a thread a command loads
   * first is re-attached then. It also prunes old runs' directories, now and every hour after.
   */
  async recover(): Promise<Recovered> {
    this.#open();
    const out: Recovered = { reattached: [], lost: [] };
    for (const run of await this.store.activeRuns()) {
      let rt: ThreadRuntime;
      try {
        rt = await this.#load(run.thread_id);
      } catch (e) {
        this.#error(e);
        continue;
      }
      if (rt.thread.run?.id === run.id) {
        if (rt.thread.run.reattached_at) out.reattached.push(run.thread_id);
        continue;
      }
      if (rt.lostRun === run.id) out.lost.push(run.thread_id);
      // Not the thread's run (any more): nothing follows it.
      const now = await this.store.getRun(run.id);
      if (now && now.ended_at == null) await this.#abandon(now);
    }
    this.#prune();
    return out;
  }

  #prune(): void {
    const spawner = this.spawner;
    if (!spawner.prune || this.#pruner) return;
    const prune = () => void spawner.prune!(this.store).catch((e) => this.#error(e));
    prune();
    this.#pruner = setInterval(prune, PRUNE_EVERY_MS);
    this.#pruner.unref();
  }

  /** Stops a run nothing follows, and records that the backend is done with it. */
  async #abandon(run: RunRecord): Promise<void> {
    this.spawner.stop?.(run);
    try {
      await this.store.putRun({ ...run, ended_at: new Date().toISOString() });
    } catch (e) {
      this.#error(e);
    }
  }

  /**
   * Sends the thread's running harness process a request of the app's own, and resolves with its
   * answer: for Claude Code a control request's `request` (e.g. `{subtype: "get_context_usage"}`),
   * answered with the control response's `response`; for Codex `{method, params?}`, answered with the
   * JSON-RPC result. Rejects with a CommandError if the thread has no running process or its harness
   * takes no requests, and with a ControlError if the harness refuses it, or its process exits (or
   * the backend closes) before it answers. It mustn't be used for what the driver does itself
   * (starting turns, answering the harness's requests...).
   */
  async control(threadId: string, request: unknown): Promise<unknown> {
    this.#open();
    const rt = await this.#load(threadId);
    this.#open();
    const session = rt.session;
    if (!session?.control) throw new CommandError(`thread ${threadId} runs on ${rt.thread.harness}, which doesn't take control requests`);
    return session.control(request);
  }

  // ---------- commands ----------

  /** Carries out a command from a client. Throws a CommandError for one it can't. */
  async handle(command: Command): Promise<void> {
    // Checked against the protocol's schema before anything is touched.
    const problems = validate(command, "Command");
    if (problems.length) throw new CommandError(`that isn't a valid command: ${problems.slice(0, 5).join("; ")}`);
    switch (command.type) {
      case "send":
        return this.send(command.thread_id, command.text, {
          ...(command.attachments ? { attachments: command.attachments } : {}),
          ...(command.client_id !== undefined ? { client_id: command.client_id } : {}),
        });
      case "interrupt":
        return this.interrupt(command.thread_id);
      case "respond":
        return this.respond(command.thread_id, command.request_id, command.resolution);
      case "set_options": {
        // Only the thread's options a client may change: not its launch options.
        const { thread_id, model, effort, permission_mode } = command;
        return this.setOptions(thread_id, {
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(permission_mode !== undefined ? { permission_mode } : {}),
        });
      }
      case "rewind":
        return this.rewind(command.thread_id, command.turn_id);
      case "new_session":
        return this.newSession(command.thread_id);
      case "compact":
        return this.compact(command.thread_id);
    }
  }

  /** Sends the agent a message: starts a turn, or steers the running one. */
  async send(threadId: string, text: string, options: { attachments?: Attachment[]; client_id?: string } = {}): Promise<void> {
    const rt = await this.#ready({ type: "send", thread_id: threadId, text, ...options });
    rt.send({ text, ...options });
  }

  /** Stops the running turn, if there is one. */
  async interrupt(threadId: string): Promise<void> {
    (await this.#ready({ type: "interrupt", thread_id: threadId })).interrupt();
  }

  /** Answers an open request; does nothing if it isn't open. */
  async respond(threadId: string, requestId: string, resolution: Resolution): Promise<void> {
    (await this.#ready({ type: "respond", thread_id: threadId, request_id: requestId, resolution })).respond(requestId, resolution);
  }

  /**
   * Changes the thread's model, effort, permission mode or launch options: the model and permission
   * mode straight away where the harness takes them in its running process, and otherwise from the
   * next turn.
   */
  async setOptions(threadId: string, options: ThreadOptions): Promise<void> {
    const { launch, ...rest } = options;
    const rt = await this.#ready({ type: "set_options", thread_id: threadId, ...rest });
    const patch: Partial<Thread> = {};
    if (options.model !== undefined) patch.model = options.model || undefined;
    if (options.effort !== undefined) patch.effort = options.effort || undefined;
    if (options.permission_mode !== undefined) patch.permission_mode = options.permission_mode;
    const before = JSON.stringify(rt.thread);
    rt.setThread(patch);
    if (JSON.stringify(rt.thread) !== before) rt.session?.optionsChanged();
    if (launch) rt.setLaunch(launch);
  }

  /**
   * Takes the conversation back to before the turn `turnId`: the harness forgets it and every turn
   * after it (from the next turn, which resumes the session there), and their items are removed.
   * Refused while a turn is running, for a turn the thread hasn't, and where the harness can't go
   * back (a Claude Code session the thread adopted, to before its first turn in it).
   */
  async rewind(threadId: string, turnId: string): Promise<void> {
    const rt = await this.#ready({ type: "rewind", thread_id: threadId, turn_id: turnId });
    idle(rt, "rewound");
    try {
      rt.rewind(turnId);
    } catch (e) {
      if (e instanceof RewindError) throw new CommandError(`the thread can't be rewound to before that turn: ${e.message}`);
      throw e;
    }
  }

  /** The next turn starts a new conversation with the harness; the thread's items stay. */
  async newSession(threadId: string): Promise<void> {
    const rt = await this.#ready({ type: "new_session", thread_id: threadId });
    idle(rt, "given a new session");
    rt.newSession();
  }

  /**
   * Compacts the harness's context now, in a turn of its own. Refused while a turn is running, and
   * when the thread has no session yet.
   */
  async compact(threadId: string): Promise<void> {
    const rt = await this.#ready({ type: "compact", thread_id: threadId });
    idle(rt, "compacted");
    if (!rt.thread.session_id) throw new CommandError("the thread has no conversation to compact yet");
    if (!rt.session?.compact) throw new CommandError(`${rt.thread.harness} threads can't be compacted`);
    rt.compact();
  }

  /**
   * Stops every harness process and saves everything. With the shim spawner, runs are left going
   * instead (their turns too), for recover() to re-attach to when the app starts again, unless
   * `stop` is set; a driver that can't re-attach has its runs stopped. It rejects if some thread's events can't be saved
   * (the store is failing): they're kept, and calling close() again tries again. After it,
   * commands, snapshots and changes to threads are refused with a CommandError; get, list and
   * eventsSince still read the store, which is the app's to close.
   */
  close({ stop = false }: { stop?: boolean } = {}): Promise<void> {
    this.#stopping ??= this.#stopAll(stop);
    return this.#stopping.then(() => this.#saveAll());
  }

  /** Stops every thread's harness, once. */
  async #stopAll(stop: boolean): Promise<void> {
    this.#closed = true;
    clearInterval(this.#pruner);
    await Promise.allSettled([...this.#loading.values()]);
    await Promise.all(
      [...this.#threads.values()].map(async (rt) => {
        // Left going, saved as it is now, to be re-attached to (#saveAll reports a failure).
        if (!stop && this.spawner.durable && rt.session?.detach?.()) return void (await rt.persist().catch(() => {}));
        // A turn cut short by shutting down ends as an interrupted one.
        rt.closing = true;
        if (rt.turn) rt.turn.interrupted = true;
        try {
          await rt.session?.close();
        } catch (e) {
          this.#error(e);
        }
        if (rt.turn) rt.endTurn({ ok: false }, { carry: false });
      }),
    );
  }

  /** Saves every thread's events and a snapshot; rejects with the failures if any can't be saved. */
  async #saveAll(): Promise<void> {
    const failed: unknown[] = [];
    await Promise.all(
      [...this.#threads.values()].map(async (rt) => {
        if (rt.closed) return;
        try {
          await rt.saved();
        } catch (e) {
          failed.push(e);
          return;
        }
        await rt.saveSnapshot();
        rt.dispose();
      }),
    );
    if (failed.length) throw new AggregateError(failed, `${failed.length} thread(s) have events the store hasn't saved; close() again to retry`);
  }

  // ---------- internals ----------

  #open(): void {
    if (this.#closed) throw new CommandError("this AgentThreads is closed");
  }

  /**
   * The live thread a command is for, once the command is known to be valid and the instance
   * open: a command that isn't changes nothing.
   */
  async #ready(command: Command): Promise<ThreadRuntime> {
    this.#open();
    const problems = validate(command, "Command");
    if (problems.length) throw new CommandError(`that isn't a valid command: ${problems.slice(0, 5).join("; ")}`);
    const rt = await this.#load(command.thread_id);
    this.#open();
    return rt;
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

  #runtime(state: Snapshot, launch: LaunchOptions): ThreadRuntime {
    const id = state.thread.id;
    const onMessage = this.#options.onHarnessMessage;
    const host = {
      store: this.store,
      spawner: this.spawner,
      raw: !!this.#options.raw,
      publish: (e: ThreadEvent) => this.#publish(e),
      harnessMessage: (m: HarnessMessage) => {
        if (!onMessage) return;
        try {
          onMessage(m);
        } catch (e) {
          this.#error(e);
        }
      },
      error: (e: unknown) => this.#error(e),
    };
    const rt = new ThreadRuntime(host, state, this.#config(id), launch, this.#policy(id));
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
    const stored = await this.store.getThread(threadId);
    if (!stored) throw new CommandError(`there's no thread ${threadId}`);
    const { thread, launch } = splitStored(stored);
    const snap = await this.store.loadSnapshot(threadId);
    const events = await this.store.readEvents(threadId, { after: snap?.seq ?? 0 });
    let state = applyEvents(snap ?? initialState(thread), events);
    if (state.seq === 0) state = initialState(thread);
    const rt = this.#runtime(state, launch);
    // The turn that was running, if one was (a compaction may have no items yet), and the session it
    // started in: what a turn rebuilt here is.
    const running = rt.thread.status === "running" || rt.thread.status === "waiting";
    const open = running ? (runningTurn(snap ?? initialState(thread), events) ?? (await this.#runningTurn(thread))) : undefined;
    const lost: LostTurn = open ?? (rt.thread.session_id ? { session: rt.thread.session_id } : {});
    if (await this.#reattach(rt, lost)) return rt;
    // The process that ran its turn went with the backend before this one, or can't be followed.
    if (running || rt.thread.run) {
      if (rt.thread.run) rt.lostRun = rt.thread.run.id;
      recoverLost(rt, lost);
    }
    return rt;
  }

  /** The turn that was running, from all the thread's events (see runningTurn). */
  async #runningTurn(thread: Thread): Promise<LostTurn | undefined> {
    return runningTurn(initialState(thread), await this.store.readEvents(thread.id, { after: 0 }));
  }

  /**
   * Re-attaches a thread just loaded to its run, if it has one that outlived the backend before:
   * its turn and open requests are as they were when the run was last saved, and the session
   * carries on reading the run from there. Whether it did; if it couldn't, the run is stopped.
   */
  async #reattach(rt: ThreadRuntime, lost: LostTurn): Promise<boolean> {
    const run = rt.thread.run;
    if (!run || run.spawner === "direct") return false;
    const record = await this.store.getRun(run.id);
    if (!record || record.ended_at != null) return false;
    const data = (record.data ?? {}) as { turn?: Turn | null };
    const s = rt.thread.status;
    if (s === "running" || s === "waiting") {
      // A run saved with no turn running (null) had none: it may be waiting only on a background
      // subagent's request. A run saved before runs had their turn has the one the events have open.
      rt.turn = data.turn ? { ...data.turn } : "turn" in data ? null : { id: lost.id ?? latestTurn(rt) ?? newId("turn"), interrupted: false, ...(lost.session ? { session: lost.session } : {}) };
    }
    rt.adoptRun(record);
    const session = rt.session;
    if (!this.spawner.attach || record.spawner !== this.spawner.name || !session?.reattach?.(record)) {
      rt.turn = null;
      await this.#abandon(record);
      return false;
    }
    // Requests the session didn't take up again can't be answered.
    const open = new Set(rt.openRequests.map((r) => r.id));
    for (const r of openRequests(rt.snapshot)) if (!open.has(r.id)) rt.emit({ type: "request.resolved", request_id: r.id, resolution: { outcome: "cancel" } });
    // With none left (one answered before the restart is closed, say), the turn runs on, or the
    // thread is idle if none was running.
    if (!open.size && rt.thread.status === "waiting") rt.setThread({ status: rt.turn ? "running" : "idle" });
    rt.setThread({ run: { ...run, reattached_at: new Date().toISOString() } });
    if (rt.turn) {
      rt.addItem({
        id: newId("n"),
        type: "notice",
        level: "info",
        code: "run.reattached",
        text: "The backend restarted while this turn was running, and picked it up again.",
      });
    }
    return true;
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

/** Refuses a command that needs the thread idle: one that's running a turn. */
function idle(rt: ThreadRuntime, what: string): void {
  if (rt.turn) throw new CommandError(`a turn is running: the thread can't be ${what} until it ends (interrupt it first)`);
}

/** A turn that was running when the thread was loaded: its id, and the session it started in. */
interface LostTurn {
  id?: string;
  session?: string;
}

/**
 * The turn that's still running in `events` folded onto `from` (the last turn.started with no
 * turn.completed after it), with the thread's session_id when it started (a session the turn
 * starts is set after its turn.started); undefined if there's none in them.
 */
function runningTurn(from: Snapshot, events: ThreadEvent[]): LostTurn | undefined {
  let state = from;
  let open: LostTurn | undefined;
  for (const e of events) {
    if (e.type === "turn.started") open = { id: e.turn_id, ...(state.thread.session_id ? { session: state.thread.session_id } : {}) };
    else if (e.type === "turn.completed" && e.turn_id === open?.id) open = undefined;
    state = applyEvent(state, e);
  }
  return open;
}

/** The id of the thread's latest turn, from its items, for a lost turn whose id isn't known. */
function latestTurn(rt: ThreadRuntime): string | undefined {
  return [...rt.snapshot.items].reverse().find((i) => i.turn_id)?.turn_id;
}

/**
 * The turn a thread's items say is still running: its last, if it has no turn_result. (A thread
 * waiting with none running is waiting on a background subagent's request.)
 */
function openTurn(items: readonly Item[]): string | undefined {
  const last = [...items].reverse().find((i) => i.turn_id)?.turn_id;
  return last && !items.some((i) => i.type === "turn_result" && i.turn_id === last) ? last : undefined;
}

/**
 * Ends a turn whose process was lost when the backend stopped (`lost`, the one its events have
 * open, which a compaction with no items yet is too; or the one its items have open), and stops the
 * subagents that went with it (a background one may be running with no turn).
 */
function recoverLost(rt: ThreadRuntime, lost: LostTurn): void {
  const s = rt.thread.status;
  const items = rt.snapshot.items;
  const open = lost.id ?? openTurn(items);
  const turn = s === "running" || (s === "waiting" && open !== undefined);
  if (turn) rt.turn = { id: open ?? newId("turn"), interrupted: false, ...(lost.session ? { session: lost.session } : {}) };
  rt.stopSubagents(items.filter((i) => i.type === "tool_call" && i.subagent?.status === "running").map((i) => i.id));
  // Its open requests can't be answered now.
  for (const r of openRequests(rt.snapshot)) {
    rt.emit({ type: "request.resolved", request_id: r.id, resolution: { outcome: "cancel" } });
  }
  if (turn) {
    rt.addItem({
      id: newId("n"),
      type: "notice",
      level: "warning",
      code: "run.lost",
      text: "The backend stopped while this turn was running, and couldn't pick its run up again.",
    });
    // Not carried over: loading a thread starts no process. Its queued messages go with the next.
    rt.endTurn({ ok: false, error: "The backend stopped while this turn was running." }, { carry: false });
  } else if (rt.thread.status === "waiting") rt.setThread({ status: "idle" });
  rt.setThread({ run: undefined });
}

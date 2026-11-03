// The Claude Code driver: runs `claude -p` in stream-json mode, one process per thread (started at
// its first message, kept between turns), and translates what it says into the thread's events by
// the rules in spec/fixtures/README.md. Permissions come in as `can_use_tool` control requests, the
// app's tools are an in-process MCP server answered over `mcp_message`, and steered messages go in
// over stdin and join the turn when Claude echoes them back.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Resolution, TurnSession, Usage } from "@dire-kiwi/agent-threads-protocol";
import { messageParts, pathText } from "../attachments.js";
import { CommandError, ControlError } from "../errors.js";
import { inBackground, parseLine, runningInBackground, type Harness, type HarnessSession, type Message, type RunCheckpoint, type Skill, type ThreadContext } from "../harness.js";
import { newId } from "../ids.js";
import { applyLaunchEnv, launchedNow, launchedOf, withEnv, type Launched } from "../launch.js";
import { modeAfterPlan, permissionKey, type PermissionDecision } from "../permissions.js";
import { resumeAtPoint, type RewindPoint } from "../sessions.js";
import { writeSkills } from "../skills.js";
import type { ExitStatus, HarnessProcess, ProcessHandlers } from "../spawner.js";
import type { RunRecord } from "../store.js";
import { runTool } from "../tools.js";
import {
  APP_SERVER,
  claudeMode,
  claudePermissionMode,
  claudeRateLimits,
  claudeTool,
  claudeUsage,
  editChange,
  hookNotice,
  questions,
  resultText,
  retryText,
  slim,
  subagentResult,
  subagentStarted,
  subagentTask,
  sumUsage,
  title,
} from "./translate.js";

export interface ClaudeCodeOptions {
  /** The `claude` binary. */
  bin?: string;
  /** Arguments before Claude's own: e.g. the script, when `bin` is `node`. */
  binArgs?: string[];
  /** More arguments, after the driver's. */
  args?: string[];
  /** Added to the backend's environment. */
  env?: { [k: string]: string | undefined };
  /** Claude Code's config directory (CLAUDE_CONFIG_DIR), for a login of the app's own. */
  configDir?: string;
  /**
   * Let threads see the user's own Claude Code settings, MCP servers and skills. Off by default:
   * a thread sees only the app's.
   */
  userSettings?: boolean;
  /** How long an interrupted turn has to end before the process is stopped. 10s by default. */
  stopGraceMs?: number;
  /**
   * How long Claude has, after a turn ends, to take in steered messages it hasn't yet; then the
   * process is restarted with them. 30s by default.
   */
  steerGraceMs?: number;
  /** How long a process has to exit after its input is closed before it's sent SIGTERM. 5s by default. */
  closeGraceMs?: number;
}

/** The Claude Code harness. */
export function claudeCode(options: ClaudeCodeOptions = {}): Harness {
  return {
    name: "claude",
    open: (ctx) => new ClaudeSession(ctx, options),
  };
}

type Json = { [k: string]: any };

/** A request of Claude's not yet answered: the turn it came in, and the request. */
interface OpenRequest {
  turn: string | undefined;
  request: Json;
}

/**
 * What a run's checkpoint holds (see HarnessSession.checkpoint): what's needed to carry on reading
 * its output, as of the offset saved with it.
 */
interface RunState {
  v: 1;
  ready: boolean;
  waiting: string[];
  /** Our control requests not yet answered: their subtypes, by id. */
  pending: [string, string][];
  next: number;
  msgOfParent: [string | null, string][];
  blockCount: [string, number][];
  streamed: string[];
  summaryNext: string | null;
  asked: [string, string][];
  open: [string, OpenRequest][];
  sent: { ids: string[]; echo: string }[];
  /** Its subagents' task ids, and their calls' ids. */
  tasks?: [string, string][];
  /** The calls whose subagents it ran. */
  agents?: string[];
  /** The turn Claude started by itself, and the usage of its turns held for the user's. */
  autoTurn?: string;
  heldUsage?: Usage;
  pluginDir?: string;
  /** The running turn's mark: the main conversation's last message in it. */
  at?: string;
  /** The message it was started to resume its session at (the thread's resume_at then). */
  resumeAt?: string;
  /** The thread's options it has: those it was started with, and the model and permission mode since. */
  launched?: Launched;
  /** The thread's options or config have changed since, so the next turn starts a new process. */
  stale?: boolean;
  /** When the session's timers for it go off (ms since the epoch). */
  steerAt?: number;
  stopAt?: number;
  /**
   * Turns of its own Claude owes, to report background subagents that ended, and when it's given
   * up waiting for them (ms since the epoch).
   */
  owed?: number;
  owedAt?: number;
}

/** One `claude` process, and what's needed to read it. */
class Run {
  readonly id: string;
  proc: HarnessProcess | undefined;
  /** Claude answered `initialize`, so messages can go in. */
  ready = false;
  waiting: string[] = [];
  /** Our control requests (and the app's), by id: they're given the control response, or null if there's none. */
  pending = new Map<string, { subtype: string; resolve: (response: Json | null) => void }>();
  #nextRequest = 1;
  exited = false;
  /** Stopped on purpose (to restart), so its end doesn't end the turn. */
  retired = false;
  readonly done: Promise<void>;
  finish!: () => void;
  stderr: string[] = [];
  readonly abort = new AbortController();
  // What's needed to translate its output.
  msgOfParent = new Map<string | undefined, string>(); // parent_tool_use_id -> the streamed message's id
  blockCount = new Map<string, number>(); // message id -> blocks seen in assistant messages
  streamed = new Set<string>(); // items that got deltas
  summaryNext: string | null = null; // a compaction waiting for its summary
  asked = new Map<string, string>(); // Claude's request id -> our request's
  /** Claude's requests not yet answered, with the turn each came in. */
  open = new Map<string, OpenRequest>();
  /** The messages sent, oldest first, by what Claude echoes when it takes one in. */
  sent: { ids: string[]; echo: string }[] = [];
  /** Its subagents' task ids (which some task_* messages name them by) -> their calls' ids. */
  tasks = new Map<string, string>();
  /** The calls whose subagents it ran, which are stopped when it ends. */
  agents = new Set<string>();
  /** The turn it started by itself (beginTurn), if it has. */
  autoTurn: string | undefined;
  /** The usage of turns Claude made by itself while one of the user's waited, for that turn's. */
  heldUsage: Usage | undefined;
  /** The generated plugin with the thread's skills, for this run only. */
  pluginDir: string | undefined;
  /** The running turn's mark: the uuid of the main conversation's last message in it. */
  at: string | undefined;
  /** The message it was started to resume its session at (--resume-session-at). */
  resumeAt: string | undefined;
  launched: Launched | undefined;

  /** Left running when the backend shut down: nothing more is read or written. */
  detached = false;

  constructor(id = newId("run")) {
    this.id = id;
    this.done = new Promise((r) => (this.finish = r));
  }

  write(msg: Json): void {
    if (!this.exited && !this.detached) this.proc?.write(JSON.stringify(msg));
  }

  /** Writes a user message (that's the item `id`), once Claude is ready for one. */
  send(ids: string[], msg: Json): void {
    this.sent.push({ ids, echo: echoKey(msg.message.content) });
    if (this.ready) this.write(msg);
    else this.waiting.push(JSON.stringify(msg));
  }

  /**
   * Sends a control request of ours (`queue`: once Claude is ready): its answer's body, or null if
   * Claude refused it (or exited).
   */
  control(request: Json, queue = false): Promise<Json | null> {
    return this.request(request, queue).then(body);
  }

  /** Sends a control request: its control response (`subtype`, `response`, `error`), or null if it exited first. */
  request(request: Json, queue = false): Promise<Json | null> {
    const request_id = `req_${this.#nextRequest++}`;
    const p = new Promise<Json | null>((resolve) => this.pending.set(request_id, { subtype: String(request.subtype), resolve }));
    const msg = { type: "control_request", request_id, request };
    if (queue && !this.ready) {
      // Ahead of the messages waiting (after the requests already queued), so they run with it.
      const at = this.waiting.findIndex((l) => JSON.parse(l).type !== "control_request");
      this.waiting.splice(at < 0 ? this.waiting.length : at, 0, JSON.stringify(msg));
    } else this.write(msg);
    return p;
  }

  state(): Omit<RunState, "steerAt" | "stopAt" | "owed" | "owedAt"> {
    return {
      v: 1,
      ready: this.ready,
      waiting: this.waiting,
      pending: [...this.pending].map(([id, p]) => [id, p.subtype]),
      next: this.#nextRequest,
      msgOfParent: [...this.msgOfParent].map(([k, v]) => [k ?? null, v]),
      blockCount: [...this.blockCount],
      streamed: [...this.streamed],
      summaryNext: this.summaryNext,
      asked: [...this.asked],
      open: [...this.open],
      sent: this.sent,
      ...(this.tasks.size ? { tasks: [...this.tasks] } : {}),
      ...(this.agents.size ? { agents: [...this.agents] } : {}),
      ...(this.autoTurn ? { autoTurn: this.autoTurn } : {}),
      ...(this.heldUsage ? { heldUsage: this.heldUsage } : {}),
      ...(this.pluginDir ? { pluginDir: this.pluginDir } : {}),
      ...(this.at ? { at: this.at } : {}),
      ...(this.resumeAt ? { resumeAt: this.resumeAt } : {}),
      ...(this.launched ? { launched: this.launched } : {}),
    };
  }

  /** Takes up a checkpoint's state; our requests' answers go to `answered`. */
  restore(st: RunState, answered: (subtype: string) => (response: Json | null) => void): void {
    this.ready = st.ready;
    this.waiting = [...st.waiting];
    for (const [id, subtype] of st.pending) this.pending.set(id, { subtype, resolve: answered(subtype) });
    this.#nextRequest = st.next;
    this.msgOfParent = new Map(st.msgOfParent.map(([k, v]) => [k ?? undefined, v]));
    this.blockCount = new Map(st.blockCount);
    this.streamed = new Set(st.streamed);
    this.summaryNext = st.summaryNext;
    this.asked = new Map(st.asked);
    this.open = new Map(st.open);
    this.sent = st.sent.map((x) => ({ ids: [...x.ids], echo: x.echo }));
    this.tasks = new Map(st.tasks ?? []);
    this.agents = new Set(st.agents ?? []);
    this.autoTurn = st.autoTurn;
    this.heldUsage = st.heldUsage;
    if (st.pluginDir) this.pluginDir = st.pluginDir;
    this.at = st.at;
    this.resumeAt = st.resumeAt;
    if (st.launched) this.launched = { ...st.launched };
  }

  respond(request_id: string, response: Json): void {
    // Left running: what's open stays as it was saved, for the backend that re-attaches to answer.
    if (this.detached) return;
    this.open.delete(request_id);
    this.write({ type: "control_response", response: { subtype: "success", request_id, response } });
  }

  respondError(request_id: string, error: string): void {
    this.write({ type: "control_response", response: { subtype: "error", request_id, error } });
  }
}

class ClaudeSession implements HarnessSession {
  #ctx: ThreadContext;
  #o: ClaudeCodeOptions;
  #run: Run | null = null;
  /** The run before, once it has exited (for its last checkpoint). */
  #last: Run | null = null;
  /** A run being stopped, which the next must wait for. */
  #stopping: Promise<void> | null = null;
  /** The options changed since the run started: the next turn starts a new one. */
  #stale = false;
  /**
   * The turn whose marks go to the thread as they come (ThreadContext.mark): one of a message once
   * Claude has echoed a message of it back (what it says before then may be from before the turn:
   * set_model's reply, say), and a compaction or a turn Claude started by itself from its start.
   */
  #marking: string | undefined;
  #steerTimer: NodeJS.Timeout | undefined;
  #stopTimer: NodeJS.Timeout | undefined;
  /**
   * Turns of its own Claude owes, to report background subagents that ended (see #oweTurn), and
   * when it's given up waiting for them.
   */
  #owed = 0;
  #owedTimer: NodeJS.Timeout | undefined;
  #owedAt: number | undefined;
  /** When those go off, for a checkpoint. */
  #steerAt: number | undefined;
  #stopAt: number | undefined;
  /** A directory for the thread's generated files (skills, attached files), made when needed. */
  #tmp: string | undefined;
  #closed = false;
  /** The app's control requests not yet answered: what fails each, when the backend lets go of its run. */
  #controls = new Set<(error: Error) => void>();

  constructor(ctx: ThreadContext, options: ClaudeCodeOptions) {
    this.#ctx = ctx;
    this.#o = options;
  }

  // ---------- the core's side ----------

  start(messages: Message[]): void {
    const run = this.#ensure(true);
    // One message, however many there are: Claude makes a turn of each message waiting for it, so
    // several would run as turns of their own after this one's result.
    if (messages.length) run.send(messages.map((m) => m.id), this.#userMessage(messages));
  }

  steer(message: Message): void {
    this.#ensure(false).send([message.id], this.#userMessage([message]));
  }

  carryOver(messages: Message[]): void {
    const run = this.#live();
    if (!run || this.#stale) {
      // The next turn runs with the options as they are now, so in a new process if they changed.
      // The old one has the messages on its stdin, and mustn't act on them: it's stopped at once.
      if (run) void this.#stop(run, true, true);
      this.start(messages);
      return;
    }
    // Claude has them on its stdin, and takes them in once it's ready, which starts the next turn.
    // If it doesn't, they go to a new process.
    this.#steerAfter(run, this.#o.steerGraceMs ?? 30_000);
  }

  #steerAfter(run: Run, ms: number): void {
    clearTimeout(this.#steerTimer);
    this.#steerAt = Date.now() + ms;
    this.#steerTimer = setTimeout(() => {
      this.#steerAt = undefined;
      this.#requeue(run);
    }, ms);
    this.#steerTimer.unref?.();
  }

  #clearSteer(): void {
    clearTimeout(this.#steerTimer);
    this.#steerAt = undefined;
  }

  compact(): void {
    // Claude Code compacts when it's sent /compact, which is its turn.
    this.#ensure(true).send([], this.#userMessage([{ id: "", text: "/compact" }]));
    this.#marking = this.#ctx.turnId;
  }

  rewindPoint(sessions: (TurnSession | undefined)[], index: number): RewindPoint {
    return resumeAtPoint(sessions, index);
  }

  interrupt(): void {
    const run = this.#live();
    if (!run) return;
    this.#stopAfter(run, this.#o.stopGraceMs ?? 10_000);
    const turn = this.#ctx.turnId;
    const send = () => {
      if (this.#live() === run && !run.detached && this.#ctx.turnId === turn) void run.control({ subtype: "interrupt" });
    };
    // A run that outlives the backend is saved first, its turn interrupted and when it's stopped if
    // the turn doesn't end: after a restart, one that Claude ignores the interrupt in is still stopped.
    if (this.#ctx.spawner.durable) void this.#ctx.persist().then(send, send);
    else send();
  }

  /** Stops the run if the turn running now hasn't ended in `ms`. */
  #stopAfter(run: Run, ms: number): void {
    const turn = this.#ctx.turnId;
    this.#clearStop();
    this.#stopAt = Date.now() + ms;
    this.#stopTimer = setTimeout(() => {
      this.#stopAt = undefined;
      if (this.#ctx.turnId === turn && !run.exited) void this.#stop(run, false);
    }, ms);
    this.#stopTimer.unref?.();
  }

  #clearStop(): void {
    clearTimeout(this.#stopTimer);
    this.#stopAt = undefined;
  }

  optionsChanged(): void {
    const run = this.#live();
    const l = run?.launched;
    // A process yet to start is started with them.
    if (!run || !l) return;
    const t = this.#ctx.thread;
    // Claude takes a new model and permission mode as it runs, even during a turn; a new effort
    // needs a new process, at the next turn.
    if (l.effort !== t.effort) this.#stale = true;
    // Set as they're asked for, so a restart before the answer doesn't ask again; one Claude
    // refuses is the next process's.
    const refused = (r: Json | null) => {
      if (!r && this.#run === run) this.#stale = true;
    };
    if (l.model !== t.model) {
      l.model = t.model;
      void run.control({ subtype: "set_model", model: t.model ?? "default" }, true).then(refused);
    }
    if (l.permission_mode !== t.permission_mode) {
      l.permission_mode = t.permission_mode;
      void run.control({ subtype: "set_permission_mode", mode: this.#liveMode(run, t.permission_mode) }, true).then(refused);
    }
  }

  configChanged(): void {
    this.#stale = true;
  }

  retire(): void {
    this.#stale = true;
    this.#clearSteer();
    this.#clearStop();
    const run = this.#live();
    if (!run) return;
    // Stopped now, and retired: what it says on its way out is left out. It's the thread's run no
    // more from now, so its end, whenever that comes, changes nothing.
    void this.#stop(run, true, true);
    if (this.#ctx.thread.run?.id === run.id) this.#ctx.setThread({ run: undefined });
  }

  /**
   * Claude's name for a permission mode the running process is switched to. One not started in
   * bypass mode can't be switched to it: it goes to acceptEdits, the driver allows what it asks
   * about (see #canUseTool), and the next turn has a new process, in bypass mode.
   */
  #liveMode(run: Run, mode: string | undefined): string {
    if (mode === "bypass" && !run.launched?.bypass) {
      this.#stale = true;
      return "acceptEdits";
    }
    return claudeMode(mode);
  }

  live(): boolean {
    return !!this.#live();
  }

  release(): void {
    this.#clearSteer();
    const run = this.#live();
    // It has the messages on its stdin: stopped at once, it can't take them in unseen.
    if (run) void this.#stop(run, true, true);
  }

  keepsProcess(): boolean {
    return this.#owed > 0 && !!this.#live();
  }

  closeIdle(): boolean {
    const run = this.#live();
    if (!run) return false;
    this.#owedTurn(true);
    this.#clearSteer();
    this.#clearStop();
    // Its input is closed, so it exits once it's done (or is signalled after the close grace).
    // Retired: what it says on its way out is left out, and its end changes nothing. It's the
    // thread's run no more, so its record ends now, and a backend that restarts doesn't re-attach
    // to it.
    void this.#stop(run, true);
    if (this.#ctx.thread.run?.id === run.id) this.#ctx.setThread({ run: undefined });
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearSteer();
    this.#clearStop();
    const run = this.#run;
    if (run) await this.#stop(run, false);
    if (this.#stopping) await this.#stopping;
    if (this.#tmp) rmSync(this.#tmp, { recursive: true, force: true });
    this.#tmp = undefined;
  }

  checkpoint(): RunCheckpoint | undefined {
    // The last run, until another starts: one that has exited is saved once more, as it ended.
    const run = this.#run ?? this.#last;
    const offset = run?.proc?.offset;
    if (!run || run.retired || offset === undefined) return undefined;
    const state: RunState = {
      ...run.state(),
      ...(this.#stale ? { stale: true } : {}),
      ...(this.#steerAt !== undefined ? { steerAt: this.#steerAt } : {}),
      ...(this.#stopAt !== undefined ? { stopAt: this.#stopAt } : {}),
      ...(this.#owed > 0 ? { owed: this.#owed, ...(this.#owedAt !== undefined ? { owedAt: this.#owedAt } : {}) } : {}),
    };
    const dir = (run.proc as { dir?: unknown }).dir;
    const input = run.proc?.inputOffset;
    return { id: run.id, offset, ...(typeof dir === "string" ? { dir } : {}), ...(input !== undefined ? { input } : {}), state, ...(run.exited ? { ended: true } : {}) };
  }

  reattach(record: RunRecord): boolean {
    const st = (record.data as { state?: RunState } | undefined)?.state;
    const spawner = this.#ctx.spawner;
    if (!st || st.v !== 1 || !spawner.attach || this.#run) return false;
    const run = new Run(record.id);
    // A new model or mode Claude refuses after the restart is the next process's, as before it.
    const refused = (r: Json | null) => {
      if (!r && this.#run === run) this.#stale = true;
    };
    run.restore(st, (subtype) =>
      subtype === "initialize"
        ? (r) => this.#initialized(run, body(r))
        : subtype === "set_model" || subtype === "set_permission_mode"
          ? (r) => refused(body(r))
          : () => {},
    );
    this.#run = run;
    try {
      run.proc = spawner.attach(record, this.#handlers(run));
    } catch (e) {
      this.#run = null;
      this.#ctx.error(e);
      return false;
    }
    // A process started with other options than the thread's now is replaced at the next turn.
    this.#stale = !!st.stale || !launchedNow(st.launched, this.#ctx);
    // Claude's requests that were open: the user's questions are taken up again, and the rest
    // (a policy that hadn't decided, a tool that was running) are dealt with again. One answered
    // before the restart, though that wasn't saved, is closed: Claude has its answer.
    for (const [id, open] of [...run.open]) {
      if (run.proc.answered?.(id)) run.open.delete(id);
      else this.#reopen(run, id, open);
    }
    // Reports of background subagents that ended which Claude hadn't made yet: its process is still
    // needed for them.
    if (st.owed && st.owed > 0) {
      this.#owed = st.owed;
      this.#waitOwed(Math.max(0, (st.owedAt ?? Date.now()) - Date.now()));
    }
    if (st.steerAt !== undefined) this.#steerAfter(run, Math.max(0, st.steerAt - Date.now()));
    if (st.stopAt !== undefined) this.#stopAfter(run, Math.max(0, st.stopAt - Date.now()));
    return true;
  }

  detach(): boolean {
    const run = this.#live();
    if (!run?.proc?.detach) return false;
    this.#closed = true;
    clearTimeout(this.#steerTimer);
    clearTimeout(this.#stopTimer);
    // (What Claude owes stays in the checkpoint, for the backend that re-attaches.)
    clearTimeout(this.#owedTimer);
    run.detached = true;
    run.proc.detach();
    run.abort.abort();
    for (const fail of [...this.#controls]) fail(new ControlError("The backend closed before Claude Code answered."));
    return true;
  }

  control(request: unknown): Promise<unknown> {
    const run = this.#live();
    if (!run?.proc || run.detached) return Promise.reject(new CommandError(`thread ${this.#ctx.threadId} has no running Claude Code process`));
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof (request as Json).subtype !== "string") {
      return Promise.reject(new CommandError("a Claude Code control request is an object with a subtype"));
    }
    return new Promise((resolve, reject) => {
      const fail = (e: Error) => {
        this.#controls.delete(fail);
        reject(e);
      };
      this.#controls.add(fail);
      void run.request(request as Json).then((r) => {
        if (!this.#controls.has(fail)) return;
        this.#controls.delete(fail);
        if (!r) reject(new ControlError("Claude Code exited before it answered."));
        else if (r.subtype === "error") reject(new ControlError(typeof r.error === "string" && r.error ? r.error : "Claude Code refused the request.", r.error));
        else resolve(r.response ?? null);
      });
    });
  }

  /** A request of Claude's that was open when the backend restarted. */
  #reopen(run: Run, requestId: string, open: OpenRequest): void {
    const req = open.request;
    if (req.subtype === "can_use_tool") return this.#canUseTool(run, requestId, req, run.asked.get(requestId));
    run.open.delete(requestId);
    if (req.subtype === "mcp_message") {
      // An app tool that was running: it went with the backend, and isn't run again, since it may have
      // done what it does.
      const msg: Json = req.message ?? {};
      run.respond(requestId, {
        mcp_response: {
          jsonrpc: "2.0",
          id: msg.id ?? 0,
          result: { content: [{ type: "text", text: "The app restarted while this tool was running, so it may or may not have finished." }], isError: true },
        },
      });
    }
  }

  /** The thread's directory for generated files. */
  #dir(): string {
    this.#tmp ??= mkdtempSync(join(tmpdir(), "agent-threads-"));
    return this.#tmp;
  }

  /** Messages as one message on Claude's stdin: their content, one after the other. */
  #userMessage(messages: Message[]): Json {
    const content = messages.flatMap((m) => this.#content(m));
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
  }

  /** A message's content as Claude takes it: images with data as images, other files as text. */
  #content(m: Message): Json[] {
    return messageParts(m, () => this.#dir()).map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : p.type === "image"
          ? { type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } }
          : { type: "text", text: pathText(p) },
    );
  }

  // ---------- the process ----------

  #live(): Run | null {
    const run = this.#run;
    return run && !run.exited && !run.retired ? run : null;
  }

  /** The running process, or a new one. A new turn (`fresh`) restarts it if the options changed. */
  #ensure(fresh: boolean): Run {
    const live = this.#live();
    if (live && !(fresh && this.#stale)) return live;
    if (live) void this.#stop(live, true);
    this.#stale = false;
    const run = new Run();
    this.#run = run;
    const after = this.#stopping;
    if (after) void after.then(() => this.#spawn(run));
    else this.#spawn(run);
    return run;
  }

  /**
   * Stops a run: closes its input, then signals it if it doesn't exit; or signals it straight away
   * (`now`), when it has messages on its stdin that are going to another process instead.
   */
  #stop(run: Run, retire: boolean, now = false): Promise<void> {
    if (retire) run.retired = true;
    if (run.exited) return run.done;
    const grace = this.#o.closeGraceMs ?? 5_000;
    let stopped: Promise<void>;
    if (run.proc?.stop) {
      // Written down by a process that outlives the backend, so it's carried on after a restart.
      run.proc.stop(grace, now);
      stopped = run.done;
    } else {
      run.proc?.closeInput();
      if (now) run.proc?.kill("SIGTERM");
      const term = setTimeout(() => run.proc?.kill("SIGTERM"), grace);
      const kill = setTimeout(() => run.proc?.kill("SIGKILL"), grace * 2);
      stopped = run.done.then(() => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    }
    if (retire) {
      const prev = this.#stopping;
      const all = Promise.all([prev, stopped]).then(() => {
        if (this.#stopping === all) this.#stopping = null;
      });
      this.#stopping = all;
    }
    return stopped;
  }

  /** Claude didn't take in steered messages after its turn: they go to a new process. */
  #requeue(run: Run): void {
    if (this.#run !== run || run.exited || !this.#ctx.queued().length) return;
    void this.#stop(run, true, true);
    const next = this.#ensure(false);
    const queued = this.#ctx.queued().map((m) => ({ id: m.id, text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) }));
    if (queued.length) next.send(queued.map((m) => m.id), this.#userMessage(queued));
  }

  #spawn(run: Run): void {
    if (this.#closed || run.retired) {
      run.exited = true;
      run.finish();
      return;
    }
    const ctx = this.#ctx;
    const thread = ctx.thread;
    const { tools } = ctx.config;
    const o = this.#o;
    const env = applyLaunchEnv(withEnv(o.env), ctx.launch);
    const configDir = ctx.launch.configDir || o.configDir;
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    let proc: HarnessProcess;
    try {
      proc = ctx.spawner.spawn(
        {
          command: o.bin ?? "claude",
          args: [...(o.binArgs ?? []), ...this.#args(run)],
          ...(thread.cwd ? { cwd: thread.cwd } : {}),
          env,
          threadId: ctx.threadId,
          runId: run.id,
        },
        this.#handlers(run),
      );
    } catch (e) {
      this.#exited(run, { code: null, signal: null, error: e instanceof Error ? e : new Error(String(e)) });
      return;
    }
    run.proc = proc;
    run.launched = { ...launchedOf(ctx), ...(thread.permission_mode === "bypass" ? { bypass: true } : {}) };
    ctx.setThread({ run: { id: run.id, spawner: ctx.spawner.name, started_at: new Date().toISOString() } });
    void run.control({ subtype: "initialize", ...(tools.length ? { sdkMcpServers: [APP_SERVER] } : {}) }).then((r) => this.#initialized(run, r));
  }

  #handlers(run: Run): ProcessHandlers {
    return {
      line: (line) => {
        const m = parseLine(line);
        this.#ctx.fromHarness(run.id, line, m, () => this.#line(run, m));
      },
      stderr: (line) => {
        run.stderr.push(line);
        if (run.stderr.length > 20) run.stderr.shift();
      },
      exit: (status) => this.#exited(run, status),
      unanswered: () => run.open.keys(),
    };
  }

  /** Claude answered `initialize` (null: it refused). */
  #initialized(run: Run, r: Json | null): void {
    if (run.exited || run.detached) return;
    if (!r) {
      // It refused: messages can't go in, so stop it, which ends the turn.
      run.stderr.push("Claude Code refused the initialize request.");
      void this.#stop(run, false);
      return;
    }
    run.ready = true;
    for (const line of run.waiting.splice(0)) run.proc?.write(line);
  }

  #args(run: Run): string[] {
    const ctx = this.#ctx;
    const t = ctx.thread;
    const { tools, mcpServers, skills, systemPrompt } = ctx.config;
    const o = this.#o;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--input-format", "stream-json"];
    args.push("--replay-user-messages", "--permission-prompt-tool", "stdio");
    if (!o.userSettings) args.push("--setting-sources", "", "--strict-mcp-config");
    args.push("--forward-subagent-text", "--include-hook-events");
    if (t.model) args.push("--model", t.model);
    if (t.effort) args.push("--effort", t.effort);
    const mode = claudePermissionMode(t.permission_mode);
    if (mode) args.push("--permission-mode", mode);
    if (t.session_id) args.push("--resume", t.session_id);
    // After a rewind: the session as it was at the end of the turn it went back to.
    run.resumeAt = t.session_id ? t.resume_at : undefined;
    if (run.resumeAt) args.push("--resume-session-at", run.resumeAt);
    const servers: Json = {};
    if (tools.length) servers[APP_SERVER] = { type: "sdk", name: APP_SERVER };
    for (const [name, s] of Object.entries(mcpServers)) {
      servers[name] =
        "url" in s
          ? { type: s.type ?? "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
          : { type: "stdio", command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
    }
    if (Object.keys(servers).length) args.push("--mcp-config", JSON.stringify({ mcpServers: servers }));
    if (skills.length) {
      // A plugin of the run's own, made from the skills as they are now: Claude finds a plugin's
      // skills (as app:<name>) even with --setting-sources "", which hides .claude/skills directories.
      run.pluginDir = writePlugin(join(this.#dir(), `plugin-${run.id}`), skills);
      args.push("--plugin-dir", run.pluginDir);
    }
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    const launch = ctx.launch;
    for (const d of launch.addDirs ?? []) args.push("--add-dir", d);
    args.push(...(o.args ?? []), ...(launch.args ?? []));
    return args;
  }

  #exited(run: Run, status: ExitStatus): void {
    if (run.exited || run.detached) return;
    run.exited = true;
    run.abort.abort();
    if (run.pluginDir) rmSync(run.pluginDir, { recursive: true, force: true });
    for (const p of run.pending.values()) p.resolve(null);
    run.pending.clear();
    const ctx = this.#ctx;
    if (this.#run === run) {
      this.#run = null;
      this.#last = run;
      this.#owedTurn(true);
    }
    if (ctx.thread.run?.id === run.id) ctx.setThread({ run: undefined });
    // Its subagents end with it.
    ctx.stopSubagents(run.agents);
    // A run that ends while its turn is running ends the turn (as interrupted, if it was).
    if (!run.retired && ctx.turnId) {
      this.#clearStop();
      this.#clearSteer();
      ctx.endTurn({ ok: false, error: exitError(status, run.stderr), ...(run.at ? { session_at: run.at } : {}) });
    }
    run.finish();
  }

  // ---------- what Claude says ----------

  /** A line of Claude's output, parsed (undefined if it isn't JSON). */
  #line(run: Run, parsed: unknown): void {
    // Not a message: Claude Code doesn't write anything else to stdout, but be safe.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const m = parsed as Json;
    if (m.type === "control_response") {
      // Claude echoes our own responses back too; those aren't for a request of ours.
      const r = m.response ?? {};
      const p = run.pending.get(r.request_id);
      if (p) {
        run.pending.delete(r.request_id);
        p.resolve(r);
      }
      return;
    }
    if (run.retired || run !== this.#run) return;
    try {
      this.#message(run, m);
    } catch (e) {
      this.#ctx.error(e);
    }
  }

  #message(run: Run, m: Json): void {
    const ctx = this.#ctx;
    const parent: string | undefined = m.parent_tool_use_id ?? undefined;
    // The main conversation's messages (replayed ones too): the turn's last is where a rewind to
    // after it resumes the session.
    if ((m.type === "user" || m.type === "assistant") && !parent && typeof m.uuid === "string") {
      run.at = m.uuid;
      if (m.type === "user" && m.isReplay && run.sent.some((s) => s.echo === echoKey(m.message?.content))) this.#marking = ctx.turnId;
      // A turn that has a mark already (re-attached after a restart, say) was being marked.
      if (ctx.turnId && (this.#marking === ctx.turnId || ctx.thread.turn_at !== undefined)) ctx.mark(m.uuid);
    }
    // A message refused for the usage limit says which limit, before anything else it leads to.
    if ((m.type === "assistant" || m.type === "user" || m.type === "result") && m.api_error === "usage_limit_reached") {
      const info = m.api_error_params?.rate_limit_info;
      if (info && typeof info === "object") ctx.rateLimits(claudeRateLimits(info));
    }
    switch (m.type) {
      case "rate_limit_event":
        if (m.rate_limit_info && typeof m.rate_limit_info === "object") ctx.rateLimits(claudeRateLimits(m.rate_limit_info));
        break;
      case "system":
        // Claude starts a turn by itself to tell the agent that a background subagent has ended.
        if (m.subtype === "init" && !ctx.turnId) {
          ctx.beginTurn();
          run.autoTurn = ctx.turnId;
          this.#marking = ctx.turnId;
        }
        if (m.subtype === "init") {
          // The session it runs in; and a rewind's resume_at is done with once it has resumed there.
          const patch: { session_id?: string; resume_at?: undefined } = {};
          if (m.session_id && m.session_id !== ctx.thread.session_id) patch.session_id = m.session_id;
          if (run.resumeAt && ctx.thread.resume_at === run.resumeAt) patch.resume_at = undefined;
          if (Object.keys(patch).length) ctx.setThread(patch);
        }
        if (m.subtype === "api_retry") ctx.addItem({ id: newId("n"), type: "notice", level: "warning", code: "retry", text: retryText(m), ...(parent ? { parent_id: parent } : {}) });
        if (m.subtype === "hook_response") {
          const n = hookNotice(m);
          if (n) ctx.addItem({ id: newId("n"), type: "notice", ...n, code: "hook", ...(parent ? { parent_id: parent } : {}) });
        }
        if (typeof m.subtype === "string" && m.subtype.startsWith("task_")) this.#task(run, m);
        if (m.subtype === "compact_boundary") {
          const meta = m.compact_metadata ?? {};
          ctx.addItem({
            id: m.uuid,
            type: "compaction",
            ...(meta.trigger === "auto" || meta.trigger === "manual" ? { trigger: meta.trigger } : {}),
            ...(typeof meta.pre_tokens === "number" ? { tokens_before: meta.pre_tokens } : {}),
            ...(parent ? { parent_id: parent } : {}),
          });
          run.summaryNext = m.uuid;
        }
        break;
      case "stream_event": {
        const ev = m.event ?? {};
        if (ev.type === "message_start") run.msgOfParent.set(parent, ev.message?.id);
        if (ev.type !== "content_block_delta") break;
        const kind = ev.delta?.type === "text_delta" ? "text" : ev.delta?.type === "thinking_delta" ? "reasoning" : null;
        const text: string | undefined = ev.delta?.text ?? ev.delta?.thinking;
        if (!kind || !text) break;
        const key = `${m.api_message_id ?? run.msgOfParent.get(parent)}:${ev.index}`;
        if (!run.streamed.has(key)) {
          run.streamed.add(key);
          ctx.addItem({ id: key, type: kind === "text" ? "assistant_message" : "reasoning", text: "", ...(parent ? { parent_id: parent } : {}) });
        }
        ctx.delta(key, kind, text);
        break;
      }
      case "assistant": {
        const msg = m.message ?? {};
        for (const block of msg.content ?? []) {
          const index = run.blockCount.get(msg.id) ?? 0;
          run.blockCount.set(msg.id, index + 1);
          const key = `${msg.id}:${index}`;
          if (block.type === "text" || block.type === "thinking") {
            // The <synthetic> model's messages are Claude Code's own (an API error, say), which the result has.
            if (msg.model === "<synthetic>") continue;
            const text: string = (block.type === "text" ? block.text : block.thinking) ?? "";
            if (run.streamed.has(key)) ctx.updateItem(key, { text });
            else if (text) ctx.addItem({ id: key, type: block.type === "text" ? "assistant_message" : "reasoning", text, ...(parent ? { parent_id: parent } : {}) });
          } else if (block.type === "tool_use") {
            ctx.addItem({ id: block.id, type: "tool_call", ...claudeTool(block.name, block.input), status: "running", ...(parent ? { parent_id: parent } : {}) });
          }
        }
        break;
      }
      case "user":
        this.#user(run, m);
        break;
      case "control_request":
        // Read again after a restart, and answered before it (though that wasn't saved): Claude
        // has its answer, and the user isn't asked again.
        if (run.proc?.answered?.(m.request_id)) break;
        this.#controlRequest(run, m.request_id, m.request ?? {});
        break;
      case "control_cancel_request": {
        // It no longer wants an answer, including one a policy is still working out.
        run.open.delete(m.request_id);
        const id = run.asked.get(m.request_id);
        if (id) ctx.cancelRequest(id);
        break;
      }
      case "result": {
        if (m.origin?.kind === "task-notification") this.#owedTurn(false);
        // The turn's requests are moot now; its open questions are cancelled with it. A background
        // subagent's carry on.
        const lookup = (id: string) => ctx.item(id);
        for (const [id, open] of run.open) {
          const call = toolUseOf(open.request);
          if (!call || !inBackground(lookup, call)) run.open.delete(id);
        }
        // Its messages are done with: what was kept to translate them needn't be any more, unless
        // a background subagent is still sending its own.
        if (![...run.agents].some((id) => runningInBackground(ctx.item(id)))) {
          run.msgOfParent.clear();
          run.blockCount.clear();
          run.streamed.clear();
        }
        if (!ctx.turnId) {
          run.at = undefined;
          break;
        }
        // The end of a turn Claude made by itself (to tell the agent a background subagent ended)
        // while a turn of the user's waited for it: the user's goes on to its own result, which
        // gets this one's usage too.
        if (m.origin?.kind === "task-notification" && ctx.turnId !== run.autoTurn) {
          run.heldUsage = sumUsage(run.heldUsage, claudeUsage(m));
          break;
        }
        // The turn's mark: its last message, the one Claude made by itself in it included.
        const at = run.at;
        run.at = undefined;
        this.#clearStop();
        const failed = !!m.is_error;
        const usage = sumUsage(run.heldUsage, claudeUsage(m));
        run.heldUsage = undefined;
        ctx.endTurn({
          ok: !failed,
          ...(failed ? { error: m.result || (Array.isArray(m.errors) ? m.errors.join("\n") : "") || m.subtype } : {}),
          usage,
          ...(typeof m.duration_ms === "number" ? { duration_ms: m.duration_ms } : {}),
          ...(at ? { session_at: at } : {}),
        });
        break;
      }
    }
  }

  #user(run: Run, m: Json): void {
    const ctx = this.#ctx;
    const content = m.message?.content;
    if (m.isReplay) {
      // Claude took in a message: if it was a steered one, it's no longer queued.
      // Claude echoes a message as it was sent: match it with the first sent like that.
      const echo = echoKey(content);
      const at = run.sent.findIndex((s) => s.echo === echo);
      if (at < 0) return;
      for (const id of run.sent.splice(at, 1)[0]!.ids) ctx.tookIn(id);
      // It's taking its messages in, and its turn for this one may run past the grace: the grace
      // is for a Claude that takes none in. The turn's result carries over what's still queued,
      // which starts it again.
      if (run === this.#run) this.#clearSteer();
      return;
    }
    if (typeof content === "string") {
      if (run.summaryNext && m.isSynthetic) {
        ctx.updateItem(run.summaryNext, { summary: content });
        run.summaryNext = null;
      }
      return;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type !== "tool_result") continue;
      const it = ctx.item(b.tool_use_id);
      if (!it || it.type !== "tool_call") continue;
      const patch: Json = {};
      // A denied call stays denied; its result is what the agent was told.
      if (it.status !== "denied") patch.status = b.is_error ? (ctx.interrupted ? "cancelled" : "failed") : "completed";
      patch.result = slim(resultText(b.content));
      const tur = m.tool_use_result;
      if (it.kind === "edit" && tur && typeof tur === "object" && !b.is_error) {
        const change = editChange(tur, it.changes?.[0]?.path);
        if (change) patch.changes = [change];
      }
      const subagent = subagentResult(it, !!b.is_error, ctx.interrupted, tur, patch.result.content);
      if (subagent) {
        patch.subagent = subagent;
        run.agents.add(it.id);
      }
      ctx.updateItem(it.id, patch);
    }
  }

  /**
   * Claude's task_* messages about a subagent: an Agent call's, or a skill's forked one (whose
   * Skill call becomes a subagent call). Other tasks (a command run in the background) aren't.
   */
  #task(run: Run, m: Json): void {
    const ctx = this.#ctx;
    if (m.subtype === "task_started" && m.task_type === "local_agent" && typeof m.tool_use_id === "string") {
      const it = ctx.item(m.tool_use_id);
      if (it?.type !== "tool_call") return;
      if (typeof m.task_id === "string") run.tasks.set(m.task_id, it.id);
      run.agents.add(it.id);
      const kind = it.kind === "subagent" ? {} : { kind: "subagent", ...(!it.title && typeof m.description === "string" && m.description ? { title: m.description } : {}) };
      ctx.updateItem(it.id, { ...kind, subagent: subagentStarted(it, m) });
      return;
    }
    const id = typeof m.tool_use_id === "string" ? m.tool_use_id : run.tasks.get(m.task_id);
    const it = id ? ctx.item(id) : undefined;
    if (it?.type !== "tool_call" || !it.subagent) return;
    const next = subagentTask(it.subagent, m);
    // A background subagent that ends is reported to the agent in a turn Claude starts by itself:
    // its process is needed until then (see keepsProcess).
    if (it.subagent.background && it.subagent.status === "running" && next.status !== "running") this.#oweTurn();
    ctx.updateItem(it.id, { subagent: next });
  }

  /**
   * Claude owes the agent a turn of its own, to report a background subagent that ended: until it
   * comes (its result has origin.kind task-notification), or for the steer grace at most, the
   * thread isn't let go of as idle.
   */
  #oweTurn(): void {
    this.#owed++;
    this.#waitOwed(this.#o.steerGraceMs ?? 30_000);
  }

  /** Gives up waiting for the turns Claude owes after `ms`. */
  #waitOwed(ms: number): void {
    clearTimeout(this.#owedTimer);
    this.#owedAt = Date.now() + ms;
    this.#owedTimer = setTimeout(() => {
      this.#owedTimer = undefined;
      this.#owedAt = undefined;
      this.#owed = 0;
      // No event says so: the core checks again whether the thread is idle.
      this.#ctx.recheckIdle();
    }, ms);
    this.#owedTimer.unref?.();
  }

  /** Claude made a turn it owed, or its process has gone (`all`). */
  #owedTurn(all: boolean): void {
    this.#owed = all ? 0 : Math.max(0, this.#owed - 1);
    if (this.#owed === 0) {
      clearTimeout(this.#owedTimer);
      this.#owedTimer = undefined;
      this.#owedAt = undefined;
    }
  }

  #controlRequest(run: Run, requestId: string, req: Json): void {
    switch (req.subtype) {
      case "can_use_tool":
        return this.#canUseTool(run, requestId, req);
      case "mcp_message":
        return void this.#mcp(run, requestId, req);
      default:
        run.respondError(requestId, `agent-threads doesn't handle ${req.subtype} requests`);
    }
  }

  /**
   * A tool Claude wants to use: the policy decides, or the user is asked. `existing` is the
   * request the user was asked with before the backend restarted, which is taken up again.
   */
  #canUseTool(run: Run, requestId: string, req: Json, existing?: string): void {
    const ctx = this.#ctx;
    const toolUseId: string | undefined = req.tool_use_id;
    const input = req.input ?? {};
    const turn = existing !== undefined ? run.open.get(requestId)?.turn : ctx.turnId;
    run.open.set(requestId, { turn, request: req });
    const ask: typeof ctx.ask = (request, toolCallId, answered, standing) =>
      existing !== undefined && ctx.reopen(existing, answered, standing) ? existing : ctx.ask(request, toolCallId, answered, standing);
    // Whether Claude still wants this answered: not cancelled, its turn not over (unless it's a
    // background subagent's, which carries on after it), its run not gone.
    const wanted = () =>
      run.open.has(requestId) &&
      !run.exited &&
      !run.retired &&
      !run.detached &&
      this.#run === run &&
      (ctx.turnId === turn || (toolUseId !== undefined && inBackground((id) => ctx.item(id), toolUseId)));
    const allow = (updatedInput: unknown, more?: Json) => wanted() && run.respond(requestId, { behavior: "allow", updatedInput, ...more });
    const deny = (message: string) => wanted() && run.respond(requestId, { behavior: "deny", message });
    const denied = () => toolUseId && ctx.updateItem(toolUseId, { status: "denied" });

    if (req.tool_name === "AskUserQuestion") {
      const qs = questions(input);
      if (!qs.length) return void allow(input);
      const id = ask({ type: "question", questions: qs as [(typeof qs)[0], ...typeof qs] }, toolUseId, (res: Resolution) => {
        if (res.outcome === "answer") {
          const answers: { [q: string]: string } = {};
          for (const [q, a] of Object.entries(res.answers ?? {})) answers[q] = (a ?? []).join(", ");
          allow({ ...input, answers });
          if (toolUseId) ctx.updateItem(toolUseId, { status: "running" });
        } else {
          deny(res.message || "The user didn't answer.");
          denied();
        }
      });
      run.asked.set(requestId, id);
      return;
    }

    if (req.tool_name === "ExitPlanMode") {
      // A plan, which only the user approves. Approved, Claude leaves plan mode for the mode the
      // thread carries on in (setMode), as does the thread; sent back, it plans again.
      const plan = typeof input.plan === "string" ? input.plan : "";
      const id = ask({ type: "plan", plan }, toolUseId, (res: Resolution) => {
        if (!wanted()) return;
        if (res.outcome === "allow") {
          const mode = modeAfterPlan(ctx.thread.permission_mode, res.permission_mode);
          allow(input, { updatedPermissions: [{ type: "setMode", mode: this.#liveMode(run, mode), destination: "session" }] });
          if (run.launched) run.launched.permission_mode = mode;
          ctx.setThread({ permission_mode: mode });
          if (toolUseId) ctx.updateItem(toolUseId, { status: "running" });
        } else {
          deny(res.message || "The user wants you to keep planning rather than start on this plan.");
          denied();
        }
      });
      run.asked.set(requestId, id);
      return;
    }

    // The thread is in bypass mode, which its process couldn't be switched to: nothing is asked.
    if (ctx.thread.permission_mode === "bypass" && existing === undefined) return void allow(input);

    const t = claudeTool(req.tool_name, input);
    const call = toolUseId ? ctx.item(toolUseId) : undefined;
    const query = {
      name: t.name,
      kind: t.kind,
      input,
      title: title(t),
      ...(t.kind === "shell" && t.command ? { command: t.command } : {}),
      ...(t.server ? { server: t.server } : {}),
      ...(typeof req.decision_reason === "string" && req.decision_reason ? { reason: req.decision_reason } : {}),
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
      ...(call?.parent_id ? { parentId: call.parent_id } : {}),
    };
    const apply = (d: PermissionDecision) => {
      // A policy that took a while may answer after Claude stopped asking.
      if (!wanted()) return;
      if (d === "allow") return void allow(input);
      if (d === "ask") {
        const id = ask(
          {
            type: "permission",
            name: t.name,
            kind: t.kind,
            input,
            title: title(t),
            ...(typeof req.decision_reason === "string" && req.decision_reason ? { reason: req.decision_reason } : {}),
          },
          toolUseId,
          (res: Resolution) => {
            if (res.outcome === "allow") {
              allow(input);
              if (toolUseId) ctx.updateItem(toolUseId, { status: "running" });
            } else {
              deny(res.message || "The user didn't allow this.");
              denied();
            }
          },
          permissionKey(query),
        );
        run.asked.set(requestId, id);
        return;
      }
      deny(typeof d === "object" ? d.deny : "The app's permission policy doesn't allow this.");
      denied();
    };
    // The user was asked before the backend restarted: they still are.
    const d = existing !== undefined ? "ask" : ctx.decide(query);
    if (d instanceof Promise) void d.then(apply);
    else apply(d);
  }

  /** The app's tools, as an MCP server on the control channel. */
  async #mcp(run: Run, requestId: string, req: Json): Promise<void> {
    const msg: Json = req.message ?? {};
    const reply = (body: Json) => run.respond(requestId, { mcp_response: { jsonrpc: "2.0", id: msg.id ?? 0, ...body } });
    if (req.server_name !== APP_SERVER) return reply({ error: { code: -32601, message: `there's no MCP server ${req.server_name} in process` } });
    if (msg.id === undefined) return reply({ result: {} }); // a notification
    const ctx = this.#ctx;
    const tools = ctx.config.tools;
    switch (msg.method) {
      case "initialize":
        return reply({
          result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: APP_SERVER, version: "1.0.0" } },
        });
      case "ping":
        return reply({ result: {} });
      case "tools/list":
        return reply({ result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) } });
      case "tools/call": {
        const name = msg.params?.name;
        const tool = tools.find((t) => t.name === name);
        if (!tool) return reply({ result: { content: [{ type: "text", text: `There's no tool ${name}.` }], isError: true } });
        const toolCallId = msg.params?._meta?.["claudecode/toolUseId"];
        // Saved before it runs, so a backend that restarts while it does answers it rather than run
        // it again (see #reopen).
        run.open.set(requestId, { turn: ctx.turnId, request: req });
        try {
          await ctx.persist();
        } catch {
          if (run.detached) return;
          run.open.delete(requestId);
          return reply({ result: { content: [{ type: "text", text: "The app couldn't save its state, so it didn't run this tool." }], isError: true } });
        }
        if (!run.open.has(requestId) || run.exited || run.detached) return;
        const out = await runTool(tool, msg.params?.arguments ?? {}, {
          threadId: ctx.threadId,
          metadata: ctx.thread.metadata ?? {},
          ...(typeof toolCallId === "string" ? { toolCallId } : {}),
          signal: run.abort.signal,
        });
        // The backend shut down while it ran (and aborted it): it's left open, as saved, for the
        // backend that re-attaches to answer.
        if (run.detached) return;
        if (typeof toolCallId === "string") ctx.toolOutput(toolCallId, out.structured);
        reply({
          result: {
            content: [{ type: "text", text: out.text }],
            ...(out.isError ? { isError: true } : {}),
            ...(out.structured !== undefined ? { structuredContent: out.structured } : {}),
          },
        });
        // Saved as answered, though no event says so: a restart doesn't answer it again.
        ctx.persist().catch(() => {}); // A store that fails has said so.
        return;
      }
      default:
        return reply({ error: { code: -32601, message: `method ${msg.method} isn't supported` } });
    }
  }
}

/** The tool call a request of Claude's is about: a can_use_tool's, or an app tool's mcp_message. */
function toolUseOf(req: Json): string | undefined {
  const id = req.tool_use_id ?? req.message?.params?._meta?.["claudecode/toolUseId"];
  return typeof id === "string" ? id : undefined;
}

/** A control response's body, or null if Claude refused the request (or exited before answering). */
function body(r: Json | null): Json | null {
  return r && r.subtype !== "error" ? (r.response ?? {}) : null;
}

/**
 * What identifies a user message in Claude's echo of it: its text blocks and how many images it
 * has (Claude echoes the content as it was sent).
 */
function echoKey(content: unknown): string {
  if (typeof content === "string") return JSON.stringify([content, 0]);
  const blocks = Array.isArray(content) ? (content as Json[]) : [];
  return JSON.stringify([blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n"), blocks.filter((b) => b?.type === "image").length]);
}

function exitError(status: ExitStatus, stderr: string[]): string {
  if (status.error) return `Claude Code couldn't be started: ${status.error.message}`;
  const how = status.signal ? `was stopped by ${status.signal}` : `exited with code ${status.code}`;
  const tail = stderr.join("\n").trim();
  return `Claude Code ${how} during the turn.${tail ? `\n${tail.slice(-2000)}` : ""}`;
}

/** Writes a plugin (named `app`) holding the skills, for --plugin-dir. */
function writePlugin(dir: string, skills: Skill[]): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: APP_SERVER, version: "1.0.0", description: "The app's skills" }));
  writeSkills(join(dir, "skills"), skills);
  return dir;
}

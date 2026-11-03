// The Codex driver: runs `codex app-server` (JSON-RPC over stdio), one process per thread (started
// at its first message, kept between turns), and translates its items into the thread's events by
// the rules in spec/fixtures/README.md. A message is turn/start (or turn/steer while a turn runs);
// the server's approval and question requests go through the permission policy; the app's tools are
// dynamic tools answered over item/tool/call, or (where Codex can't take those) a loopback MCP server.
// With a spawner whose runs outlive the backend, it checkpoints what it needs to carry on reading a
// run (the JSON-RPC client's pending requests, Codex's open ones, the turn, what it streamed) and
// re-attaches to it after a restart.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PermissionMode, Resolution, SubagentState, ToolCall, TurnSession, Usage } from "@dire-kiwi/agent-threads-protocol";
import { messageParts } from "../attachments.js";
import { title } from "../claude/translate.js";
import { CommandError, ControlError } from "../errors.js";
import { ancestors, inBackground, parseLine, runningInBackground, type Harness, type HarnessSession, type Message, type RunCheckpoint, type ThreadContext } from "../harness.js";
import { newId } from "../ids.js";
import { applyLaunchEnv, launchedOf, launchFromStored, sameLaunch, withEnv, type Launched } from "../launch.js";
import { serveTools, type LoopbackMcp } from "../mcp-http.js";
import { modeAfterPlan, permissionKey, type PermissionDecision, type PermissionQuery } from "../permissions.js";
import { revertPoint, type RewindPoint } from "../sessions.js";
import { writeSkills } from "../skills.js";
import type { ExitStatus, HarnessProcess, ProcessHandlers } from "../spawner.js";
import type { RunRecord } from "../store.js";
import { addUsage, SECRET } from "../thread.js";
import { runTool, type Tool } from "../tools.js";
import { defaultCodexHome, prepareCodexHome, readSessionState, userCodexHome, writeSessionState } from "./home.js";
import type {
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  SkillsListResponse,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnPlanUpdatedNotification,
  SandboxMode,
  SandboxPolicy,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from "./protocol.js";
import { Rpc, RpcError, type Incoming, type PendingRequest, type RequestId } from "./rpc.js";
import {
  APP_SERVER,
  callUsage,
  childTurnSubagent,
  codexDone,
  codexPolicy,
  codexRateLimits,
  codexTool,
  collabSubagent,
  isToolItem,
  mcpServerConfig,
  questions,
  sandboxPolicy,
  spawnDone,
  todos,
  unwrapCommand,
} from "./translate.js";

export interface CodexOptions {
  /** The `codex` binary. */
  bin?: string;
  /** Arguments before Codex's own: e.g. the script, when `bin` is `node`. */
  binArgs?: string[];
  /** More arguments, after `app-server`. */
  args?: string[];
  /** Added to the backend's environment. */
  env?: { [k: string]: string | undefined };
  /**
   * The app's CODEX_HOME, where Codex keeps the app's sessions (resuming a thread needs them), so
   * it should last as long as the threads do. `~/.agent-threads/codex` by default.
   */
  home?: string;
  /**
   * The CODEX_HOME whose login (auth.json) is linked into `home` if it has none of its own: the
   * user's ($CODEX_HOME, or ~/.codex) by default. `false` links none.
   */
  login?: string | false;
  /**
   * Run with the user's own CODEX_HOME, and so their config, MCP servers and skills. Off by default:
   * a thread sees only the app's.
   */
  userConfig?: boolean;
  /**
   * How the app's tools reach Codex: as dynamic tools (experimental in Codex; the default), or on a
   * loopback MCP server. A Codex that refuses dynamic tools gets the MCP server.
   */
  appTools?: "dynamic" | "mcp";
  /** More config for thread/start (Codex's config.toml keys, dotted), under the driver's own. */
  config?: { [k: string]: unknown };
  /** How long an interrupted turn has to end before the process is stopped. 10s by default. */
  stopGraceMs?: number;
  /** How long a process has to exit after its input is closed before it's sent SIGTERM. 5s by default. */
  closeGraceMs?: number;
}

/** The Codex harness. */
export function codex(options: CodexOptions = {}): Harness {
  return {
    name: "codex",
    open: (ctx) => new CodexSession(ctx, options),
  };
}

/** How long a thread's MCP tools (the app's, on the loopback server) may take: the policy may ask the user. */
const APP_TOOL_TIMEOUT_SEC = 3600;

/** A request of Codex's not yet answered: the turn it came in, the request, and whether we've started on it. */
interface OpenRequest {
  turn: string | undefined;
  msg: Incoming;
  /** An app tool it asked to run, which has started running (so isn't run again after a restart). */
  started?: boolean;
}

/** A message sent (by turn/start or turn/steer), by what Codex echoes when it takes it in. */
type Sent = { ids: string[]; key: string };

/** What Codex is told when the user approves its plan, as its own client says it. */
const IMPLEMENT = "Implement the plan.";

/**
 * A thread's turn that has had a plan from Codex: what its Codex turns so far used, and the plan
 * request while the user hasn't answered it (the turn goes on meanwhile).
 */
interface Planned {
  usage?: Usage;
  duration_ms?: number;
  /** The turn's mark (its session's `at`): its first Codex turn. */
  session_at?: string;
  request?: string;
}

/**
 * What a run's checkpoint holds (see HarnessSession.checkpoint): what's needed to carry on reading
 * it, as of the offset saved with it.
 */
interface RunState {
  v: 1;
  threadId: string;
  turnId?: string;
  starting: boolean;
  compacting: boolean;
  /** Codex has reported the thread's tokens in this run. */
  reported?: boolean;
  /** What the running turn has used so far, since its turn/started. */
  used?: Usage | null;
  error: string | null;
  home: string;
  dynamic: ToolSpec[] | null;
  mcpApp: boolean;
  hiddenSkills: string[];
  noticedServers: boolean;
  skillsDir?: string;
  /** The loopback MCP server Codex was configured with, to serve again where it was. */
  mcp?: { port: number; token: string };
  streamed: string[];
  summaryPart: [string, number][];
  children: [string, string][];
  lastChild: [string, string][];
  mcpCalls: Run["mcpCalls"];
  open: [RequestId, OpenRequest][];
  asked: [RequestId, string][];
  sent: Sent[];
  held: string[];
  rpc: { next: number; pending: PendingRequest[] };
  launched?: Launched;
  model?: string;
  workspace?: SandboxPolicy;
  sandbox?: SandboxMode;
  collab?: "plan" | "default";
  proposed?: string;
  planned?: Planned;
  stale?: boolean;
  /** When the session's stop timer goes off (ms since the epoch). */
  stopAt?: number;
}

/** One `codex app-server` process, and what's needed to read it. */
class Run {
  readonly id: string;
  proc: HarnessProcess | undefined;
  rpc!: Rpc;
  exited = false;
  /** Stopped on purpose (to restart), so its end doesn't end the turn. */
  retired = false;
  readonly done: Promise<void>;
  finish!: () => void;
  stderr: string[] = [];
  readonly abort = new AbortController();
  /** Resolves with Codex's thread id once the thread is started or resumed. */
  ready!: Promise<string>;
  /** Codex's thread: the thread's own, as against its subagents'. */
  threadId: string | undefined;
  /** The Codex turn running on the thread, once its id is known. */
  turnId: string | undefined;
  /** A turn/start (or compaction) was sent and its turn hasn't ended. */
  starting = false;
  #turnWaiters: ((id: string | undefined) => void)[] = [];
  /** The running turn is a compaction. */
  compacting = false;
  /** Codex has reported the thread's tokens in this run (so its turns' usage is known). */
  reported = false;
  /**
   * What the running turn has used: each model call's tokens (tokenUsage.last), summed from its
   * turn/started on. Codex's running totals aren't used: for a session the thread adopted they
   * include what came before, and a revert doesn't take them back.
   */
  used: Usage | null = null;
  /** The running turn's last error that won't be retried. */
  error: string | null = null;
  /** The CODEX_HOME it runs with. */
  home = "";
  /**
   * The dynamic tools Codex has for the session (it keeps those it was started with), by name; null
   * if they aren't known (the session was started elsewhere).
   */
  dynamic: Map<string, ToolSpec> | null = null;
  /** Some of the app's tools are on the loopback MCP server (those the session hasn't as dynamic tools). */
  mcpApp = false;
  /** Skills Codex found that aren't the app's (the user's, the project's): they're turned off. */
  hiddenSkills: string[] = [];
  /** Notices about the thread's MCP servers were given. */
  noticedServers = false;
  mcp: LoopbackMcp | undefined;
  /**
   * Where Codex was told the loopback MCP server is, which it is (or, re-attached, is about to be)
   * for as long as the process runs: what a checkpoint keeps, so a restart serves it there too.
   */
  mcpEndpoint: { port: number; token: string } | undefined;
  skillsDir: string | undefined;
  // What's needed to translate its output.
  streamed = new Set<string>(); // items that got deltas
  summaryPart = new Map<string, number>(); // reasoning item -> the summary part its deltas are in
  children = new Map<string, string>(); // child thread -> the spawnAgent call it's for
  lastChild = new Map<string, string>(); // child thread -> its last message
  /** MCP tool calls running: for an elicitation (which only names its server) and the app's MCP tools. */
  mcpCalls: { id: string; server: string; name: string; args: unknown; thread: string | undefined }[] = [];
  /** The server's requests not yet answered. */
  open = new Map<RequestId, OpenRequest>();
  asked = new Map<RequestId, string>(); // the server's request -> our request
  /** Messages sent, oldest first, by the text inputs Codex echoes in its userMessage item. */
  sent: Sent[] = [];
  /** Queued messages this process has (it was sent them, and didn't refuse them). */
  held = new Set<string>();
  launched: Launched | undefined;
  /** The model Codex says the thread runs, for a collaboration mode's settings when the thread has none of its own. */
  model: string | undefined;
  /** The workspace-write sandbox Codex last said the thread had, with its settings. */
  workspace: SandboxPolicy | undefined;
  /** The sandbox mode it has (none: its permission mode's, from a checkpoint from before this was kept). */
  sandbox: SandboxMode | undefined;
  /** The collaboration mode it was last given (none: it's in its default one). */
  collab: "plan" | "default" | undefined;
  /** The plan the running Codex turn proposed, in plan mode. */
  proposed: string | undefined;
  /** The thread's turn has had a plan. */
  planned: Planned | undefined;
  /** Left running when the backend shut down: nothing more is read or written. */
  detached = false;

  constructor(id = newId("run")) {
    this.id = id;
    this.done = new Promise((r) => (this.finish = r));
  }

  write(msg: object): void {
    if (!this.exited && !this.detached) this.proc?.write(JSON.stringify(msg));
  }

  /** What a checkpoint needs; undefined while it's starting (Codex's thread isn't known yet). */
  state(): Omit<RunState, "stale" | "stopAt"> | undefined {
    if (!this.threadId) return undefined;
    return {
      v: 1,
      threadId: this.threadId,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      starting: this.starting,
      compacting: this.compacting,
      reported: this.reported,
      used: this.used,
      error: this.error,
      home: this.home,
      dynamic: this.dynamic ? [...this.dynamic.values()] : null,
      mcpApp: this.mcpApp,
      hiddenSkills: this.hiddenSkills,
      noticedServers: this.noticedServers,
      ...(this.skillsDir ? { skillsDir: this.skillsDir } : {}),
      ...(this.mcpEndpoint ? { mcp: this.mcpEndpoint } : {}),
      streamed: [...this.streamed],
      summaryPart: [...this.summaryPart],
      children: [...this.children],
      lastChild: [...this.lastChild],
      mcpCalls: this.mcpCalls,
      open: [...this.open],
      asked: [...this.asked],
      sent: this.sent,
      held: [...this.held],
      rpc: this.rpc.state(),
      ...(this.launched ? { launched: this.launched } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.workspace ? { workspace: this.workspace } : {}),
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      ...(this.collab ? { collab: this.collab } : {}),
      ...(this.proposed !== undefined ? { proposed: this.proposed } : {}),
      ...(this.planned ? { planned: this.planned } : {}),
    };
  }

  /** Takes up a checkpoint's state (all but the JSON-RPC client's, which the session restores). */
  restore(st: RunState): void {
    this.threadId = st.threadId;
    this.turnId = st.turnId;
    this.starting = st.starting;
    this.compacting = st.compacting;
    this.reported = st.reported ?? false;
    this.used = st.used ?? null;
    this.error = st.error;
    this.home = st.home;
    this.dynamic = st.dynamic ? new Map(st.dynamic.map((t) => [t.name, t])) : null;
    this.mcpApp = st.mcpApp;
    this.hiddenSkills = st.hiddenSkills;
    this.noticedServers = st.noticedServers;
    if (st.skillsDir) this.skillsDir = st.skillsDir;
    if (st.mcp) this.mcpEndpoint = { ...st.mcp };
    this.streamed = new Set(st.streamed);
    this.summaryPart = new Map(st.summaryPart);
    this.children = new Map(st.children);
    this.lastChild = new Map(st.lastChild);
    this.mcpCalls = st.mcpCalls;
    this.open = new Map(st.open);
    this.asked = new Map(st.asked);
    this.sent = st.sent;
    this.held = new Set(st.held);
    if (st.launched) this.launched = { ...st.launched };
    this.model = st.model;
    this.workspace = st.workspace;
    this.sandbox = st.sandbox;
    this.collab = st.collab;
    this.proposed = st.proposed;
    if (st.planned) this.planned = { ...st.planned };
    this.ready = Promise.resolve(st.threadId);
  }

  /** Calls `fn` with the running turn's id once it's known, or undefined if none is coming. */
  withTurn(fn: (id: string | undefined) => void): void {
    if (this.turnId) fn(this.turnId);
    else if (this.starting && !this.exited) this.#turnWaiters.push(fn);
    else fn(undefined);
  }

  setTurn(id: string): void {
    this.turnId = id;
    for (const fn of this.#turnWaiters.splice(0)) fn(id);
  }

  turnEnded(): void {
    this.turnId = undefined;
    this.starting = false;
    this.compacting = false;
    for (const fn of this.#turnWaiters.splice(0)) fn(undefined);
  }
}

class CodexSession implements HarnessSession {
  #ctx: ThreadContext;
  #o: CodexOptions;
  #run: Run | null = null;
  /** The run before, once it has exited (for its last checkpoint). */
  #last: Run | null = null;
  /** When the stop timer goes off, for a checkpoint. */
  #stopAt: number | undefined;
  /** A run being stopped, which the next must wait for. */
  #stopping: Promise<void> | null = null;
  /** The options changed since the run started: the next turn starts a new one. */
  #stale = false;
  #stopTimer: NodeJS.Timeout | undefined;
  /** A directory for the thread's generated files (skills, attached files), made when needed. */
  #tmp: string | undefined;
  #closed = false;
  /** The app's control requests not yet answered: what fails each, when the backend lets go of its run. */
  #controls = new Set<(error: Error) => void>();

  constructor(ctx: ThreadContext, options: CodexOptions) {
    this.#ctx = ctx;
    this.#o = options;
  }

  // ---------- the core's side ----------

  start(messages: Message[]): void {
    if (messages.length === 1 && messages[0]!.text.trim() === "/compact" && !messages[0]!.attachments?.length) return this.compact();
    this.#turnStart(this.#ensure(true), messages);
  }

  compact(): void {
    const run = this.#ensure(true);
    run.starting = true;
    run.compacting = true;
    void run.ready
      .then((threadId) => run.rpc.request("thread/compact/start", { threadId }))
      .catch((e) => this.#turnFailed(run, e));
  }

  rewindPoint(sessions: (TurnSession | undefined)[], index: number): RewindPoint {
    return revertPoint(sessions, index);
  }

  steer(message: Message): void {
    const run = this.#live();
    // With no process, there's no turn to steer: the message stays queued, and the turn's end
    // carries it over.
    if (!run) return;
    if (run.planned?.request) {
      // A message instead of an answer to the plan: it goes to Codex, which keeps planning.
      this.#ctx.cancelRequest(run.planned.request);
      run.planned.request = undefined;
      return this.#turnStart(run, [message]);
    }
    const input = this.#input([message]);
    const sent = this.#sent(run, [message.id], input);
    run.withTurn((turnId) => {
      if (!turnId) return void this.#refused(run, sent);
      run.rpc
        .request("turn/steer", { threadId: run.threadId, expectedTurnId: turnId, input }, { sent })
        // The turn ended first: the message is still queued, and goes with the next.
        .catch(() => this.#refused(run, sent));
    });
  }

  carryOver(messages: Message[]): void {
    const run = this.#live();
    if (!run || this.#stale) {
      // The next turn runs with the options as they are now, so in a new process if they changed.
      if (run) void this.#stop(run, true, true);
      this.start(messages);
      return;
    }
    this.#turnStart(run, messages);
  }

  interrupt(): void {
    const run = this.#live();
    if (!run) return;
    // Waiting on the user's answer to a plan, with no Codex turn to interrupt.
    if (run.planned?.request) return this.#endPlanned(run);
    this.#stopAfter(run, this.#o.stopGraceMs ?? 10_000);
    const turn = this.#ctx.turnId;
    const send = () => {
      if (this.#live() !== run || run.detached || this.#ctx.turnId !== turn) return;
      run.withTurn((turnId) => {
        if (turnId && !run.exited) void run.rpc.request("turn/interrupt", { threadId: run.threadId, turnId }).catch(() => {});
      });
    };
    // A run that outlives the backend is saved first, its turn interrupted and when it's stopped if
    // the turn doesn't end: after a restart, one that Codex ignores the interrupt in is still stopped.
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
    // Codex takes them with the next turn (#turnOptions), and keeps them: a model or effort that's
    // cleared, which turn/start can't say, needs a new process, which starts with Codex's own.
    const l = this.#live()?.launched;
    const t = this.#ctx.thread;
    if (l && ((l.model && !t.model) || (l.effort && !t.effort))) this.#stale = true;
  }

  configChanged(): void {
    this.#stale = true;
  }

  retire(): void {
    this.#stale = true;
    this.#clearStop();
    const run = this.#live();
    if (!run) return;
    // Stopped now, and retired: what it says on its way out is left out. It's the thread's run no
    // more from now, so its end, whenever that comes, changes nothing.
    void this.#stop(run, true, true);
    if (this.#ctx.thread.run?.id === run.id) this.#ctx.setThread({ run: undefined });
  }

  live(): boolean {
    return !!this.#live();
  }

  release(): void {
    const run = this.#live();
    // A process that has the messages is stopped, so it can't act on them unseen.
    if (run && this.#ctx.queued().some((m) => run.held.has(m.id))) void this.#stop(run, true, true);
  }

  closeIdle(): boolean {
    const run = this.#live();
    if (!run) return false;
    this.#clearStop();
    // Its input is closed, so the app server exits (or is signalled after the close grace).
    // Retired: what it says on its way out is left out, and its end changes nothing. It's the
    // thread's run no more, so its record ends now, and a backend that restarts doesn't re-attach
    // to it.
    void this.#stop(run, true);
    if (this.#ctx.thread.run?.id === run.id) this.#ctx.setThread({ run: undefined });
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
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
    const st = run.state();
    // While it's starting there's nothing to carry on with: a restart then stops it.
    const state: RunState | undefined = st && { ...st, ...(this.#stale ? { stale: true } : {}), ...(this.#stopAt !== undefined ? { stopAt: this.#stopAt } : {}) };
    const dir = (run.proc as { dir?: unknown }).dir;
    const input = run.proc?.inputOffset;
    return { id: run.id, offset, ...(typeof dir === "string" ? { dir } : {}), ...(input !== undefined ? { input } : {}), state, ...(run.exited ? { ended: true } : {}) };
  }

  reattach(record: RunRecord): boolean {
    const st = (record.data as { state?: RunState } | undefined)?.state;
    const ctx = this.#ctx;
    const spawner = ctx.spawner;
    if (!st || st.v !== 1 || !spawner.attach || this.#run) return false;
    const run = new Run(record.id);
    run.restore(st);
    run.rpc = new Rpc((msg) => run.write(msg));
    // Our requests still unanswered: their answers do what they would have.
    run.rpc.restore(
      st.rpc.next,
      st.rpc.pending.map((p) => {
        const sent = (p.meta as { sent?: Sent } | undefined)?.sent;
        const mine = sent && run.sent.find((x) => x.key === sent.key && x.ids.join() === sent.ids.join());
        const refused = () => mine && this.#refused(run, mine);
        switch (p.method) {
          case "turn/start":
            return {
              ...p,
              resolve: (r: TurnStartResponse) => r.turn?.id && run.starting && !run.turnId && run.setTurn(r.turn.id),
              reject: (e: Error) => (refused(), this.#turnFailed(run, e)),
            };
          case "turn/steer":
            return { ...p, resolve: () => {}, reject: () => refused() };
          case "thread/compact/start":
            return { ...p, resolve: () => {}, reject: (e: Error) => this.#turnFailed(run, e) };
          default:
            return { ...p, resolve: () => {}, reject: () => {} };
        }
      }),
    );
    this.#run = run;
    try {
      run.proc = spawner.attach(record, this.#handlers(run));
    } catch (e) {
      this.#run = null;
      ctx.error(e);
      return false;
    }
    // The app's tools on the loopback MCP server, where Codex was told they are.
    if (st.mcp) {
      void serveTools(APP_SERVER, { tools: () => this.#mcpTools(run), call: (name, args) => this.#mcpAppTool(run, name, args) }, st.mcp).then(
        (mcp) => (run.exited || run.detached ? void mcp.close() : (run.mcp = mcp)),
        (e) => this.#notice(`The app's tools aren't available to this turn any more: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    // The options it doesn't have go with its next turn; one whose options aren't known, or that was
    // started with other launch options than the thread's now, is replaced.
    this.#stale = !!st.stale || !st.launched || !sameLaunch(launchFromStored(st.launched.launch), ctx.launch);
    // Codex's requests that were open: the user's questions are taken up again, an app tool that
    // was running is answered (not run again), and the rest are dealt with again. One answered
    // before the restart, though that wasn't saved, is closed: Codex has its answer.
    for (const [id, open] of [...run.open]) {
      if (run.proc.answered?.(id)) run.open.delete(id);
      else this.#reopen(run, id, open);
    }
    if (st.stopAt !== undefined) this.#stopAfter(run, Math.max(0, st.stopAt - Date.now()));
    // A plan the user was asked about is still asked; if it's no longer open, its turn ends.
    const plan = run.planned?.request;
    if (plan && !ctx.reopen(plan, (res) => this.#planAnswered(run, res))) queueMicrotask(() => this.#endPlanned(run));
    return true;
  }

  detach(): boolean {
    const run = this.#live();
    if (!run?.proc?.detach) return false;
    this.#closed = true;
    clearTimeout(this.#stopTimer);
    run.detached = true;
    run.proc.detach();
    run.abort.abort();
    void run.mcp?.close();
    for (const fail of [...this.#controls]) fail(new ControlError("The backend closed before Codex answered."));
    return true;
  }

  control(request: unknown): Promise<unknown> {
    const run = this.#live();
    if (!run?.proc || !run.rpc || run.detached) return Promise.reject(new CommandError(`thread ${this.#ctx.threadId} has no running Codex process`));
    const r = request as { method?: unknown; params?: unknown } | null;
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.method !== "string") {
      return Promise.reject(new CommandError("a Codex control request is an object with a method (and params)"));
    }
    return new Promise((resolve, reject) => {
      const fail = (e: Error) => {
        this.#controls.delete(fail);
        reject(e);
      };
      this.#controls.add(fail);
      run.rpc.requestRaw(r.method as string, r.params).then(
        (result) => {
          if (!this.#controls.has(fail)) return;
          this.#controls.delete(fail);
          resolve(result);
        },
        (e: unknown) => {
          if (!this.#controls.has(fail)) return;
          this.#controls.delete(fail);
          reject(e instanceof RpcError ? new ControlError(e.message, e.error) : e);
        },
      );
    });
  }

  /** A request of Codex's that was open when the backend restarted. */
  #reopen(run: Run, id: RequestId, open: OpenRequest): void {
    if (open.started) {
      run.open.delete(id);
      // It went with the backend, and isn't run again, since it may have done what it does.
      return run.rpc.respond(id, { contentItems: [{ type: "inputText", text: "The app restarted while this tool was running, so it may or may not have finished." }], success: false });
    }
    this.#request(run, open.msg, { turn: open.turn, existing: run.asked.get(id) });
  }

  /** The thread's directory for generated files. */
  #dir(): string {
    this.#tmp ??= mkdtempSync(join(tmpdir(), "agent-threads-"));
    return this.#tmp;
  }

  /** Messages as a turn's input: their text and attachments, one after the other. */
  #input(messages: Message[]): UserInput[] {
    return messages.flatMap((m) =>
      messageParts(m, () => this.#dir()).map((p): UserInput => {
        if (p.type === "text") return { type: "text", text: p.text, text_elements: [] };
        if (p.type === "image") return { type: "image", url: `data:${p.media_type};base64,${p.data}` };
        if (p.kind === "image") return { type: "localImage", path: p.path };
        return { type: "text", text: p.written ? `Attached file ${p.name}${p.media_type ? ` (${p.media_type})` : ""}: ${p.path}` : `Attached file: ${p.path}`, text_elements: [] };
      }),
    );
  }

  /** Starts a Codex turn with the messages. */
  #turnStart(run: Run, messages: Message[]): void {
    const input = this.#input(messages);
    this.#startTurn(run, input, this.#sent(run, messages.map((m) => m.id), input));
  }

  /** Starts a Codex turn with the input: the messages `sent`, or the driver's own. */
  #startTurn(run: Run, input: UserInput[], sent?: Sent): void {
    run.starting = true;
    let before: Pick<Run, "launched" | "collab" | "sandbox"> | undefined;
    void run.ready
      .then((threadId) => {
        before = { launched: run.launched, collab: run.collab, sandbox: run.sandbox };
        return run.rpc.request<TurnStartResponse>("turn/start", { threadId, input, ...this.#turnOptions(run) }, sent ? { sent } : {});
      })
      .then((r) => {
        if (r.turn?.id && run.starting && !run.turnId) run.setTurn(r.turn.id);
      })
      .catch((e) => {
        // Refused, the process hasn't the options it was sent with it.
        if (before && e instanceof RpcError) Object.assign(run, before);
        if (sent) this.#refused(run, sent);
        this.#turnFailed(run, e);
      });
  }

  /**
   * turn/start's options: the thread's effort, and what the process doesn't have yet (Codex keeps
   * them for later turns): the model, the policy for the permission mode, and in plan mode the
   * collaboration mode `plan` (and `default` after it).
   */
  #turnOptions(run: Run): Omit<TurnStartParams, "threadId" | "input"> {
    const t = this.#ctx.thread;
    const l = run.launched ?? {};
    const o: Omit<TurnStartParams, "threadId" | "input"> = {};
    if (t.effort) o.effort = t.effort;
    if (t.model && t.model !== l.model) o.model = t.model;
    const before = codexPolicy(l.permission_mode as PermissionMode | undefined);
    const now = codexPolicy(t.permission_mode);
    if (before.approvalPolicy !== now.approvalPolicy) o.approvalPolicy = now.approvalPolicy;
    // Only a new sandbox, since what's sent replaces all of it.
    if ((run.sandbox ?? before.sandbox) !== now.sandbox) o.sandboxPolicy = sandboxPolicy(now.sandbox, run.workspace, this.#o.config);
    run.sandbox = now.sandbox;
    const collab = t.permission_mode === "plan" ? "plan" : run.collab === "plan" ? "default" : undefined;
    if (collab) {
      const model = t.model ?? l.model ?? run.model ?? "";
      o.collaborationMode = { mode: collab, settings: { model, reasoning_effort: t.effort ?? null, developer_instructions: null } };
      run.collab = collab;
    }
    run.launched = { ...l, model: t.model ?? l.model, effort: t.effort, permission_mode: t.permission_mode };
    return o;
  }

  /** Messages are being sent to the process, as this input. */
  #sent(run: Run, ids: string[], input: UserInput[]): Run["sent"][number] {
    const sent = { ids, key: echoKey(input) };
    run.sent.push(sent);
    for (const id of ids) run.held.add(id);
    return sent;
  }

  /** Codex refused messages it was sent. */
  #refused(run: Run, sent: Run["sent"][number]): void {
    run.sent = run.sent.filter((s) => s !== sent);
    for (const id of sent.ids) if (!run.sent.some((s) => s.ids.includes(id))) run.held.delete(id);
  }

  /** A turn couldn't be started: it ends with the error. */
  #turnFailed(run: Run, e: unknown): void {
    if (run.exited || run.retired || run !== this.#run) return;
    const at = run.turnId;
    run.turnEnded();
    if (this.#ctx.turnId) this.#ctx.endTurn({ ok: false, error: e instanceof Error ? e.message : String(e), ...this.#plannedSoFar(run, at) });
    run.planned = undefined;
  }

  /**
   * What the turn's Codex turns that completed (its plans') used, for a turn that ends otherwise,
   * and its mark: its first Codex turn (`at`, the one running, if it's that).
   */
  #plannedSoFar(run: Run, at: string | undefined): { usage?: Usage; duration_ms?: number; session_at?: string } {
    const p = run.planned;
    const session_at = p?.session_at ?? at;
    return { ...(p?.usage ? { usage: p.usage } : {}), ...(p?.duration_ms !== undefined ? { duration_ms: p.duration_ms } : {}), ...(session_at ? { session_at } : {}) };
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
    run.rpc = new Rpc((msg) => run.write(msg));
    let started!: (id: string) => void;
    let failed!: (e: unknown) => void;
    run.ready = new Promise<string>((res, rej) => ((started = res), (failed = rej)));
    run.ready.catch(() => {}); // Each use of it handles its failure.
    const go = () => this.#spawn(run).then(started, failed);
    const after = this.#stopping;
    if (after) void after.then(go);
    else void go();
    return run;
  }

  /**
   * Stops a run: closes its input, then signals it if it doesn't exit; or signals it straight away
   * (`now`), when it has messages that are going to another process instead.
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

  /** Starts the process and the thread: initialize, skills, thread/start or thread/resume. */
  async #spawn(run: Run): Promise<string> {
    if (this.#closed || run.retired) {
      run.exited = true;
      run.finish();
      throw new Error("the session is closed");
    }
    const ctx = this.#ctx;
    const o = this.#o;
    const launch = ctx.launch;
    let home: string;
    try {
      // The thread's own CODEX_HOME is used as it is.
      if (launch.configDir) home = resolve(launch.configDir);
      else home = o.userConfig ? userCodexHome() : prepareCodexHome(o.home ?? defaultCodexHome(), o.login ?? userCodexHome());
    } catch (e) {
      this.#exited(run, { code: null, signal: null, error: e instanceof Error ? e : new Error(String(e)) });
      throw e;
    }
    let proc: HarnessProcess;
    try {
      proc = ctx.spawner.spawn(
        {
          command: o.bin ?? "codex",
          args: [...(o.binArgs ?? []), "app-server", ...(o.args ?? []), ...(launch.args ?? [])],
          ...(ctx.thread.cwd ? { cwd: ctx.thread.cwd } : {}),
          env: { ...applyLaunchEnv(withEnv(o.env), launch), CODEX_HOME: home },
          threadId: ctx.threadId,
          runId: run.id,
        },
        this.#handlers(run),
      );
    } catch (e) {
      this.#exited(run, { code: null, signal: null, error: e instanceof Error ? e : new Error(String(e)) });
      throw e;
    }
    run.proc = proc;
    ctx.setThread({ run: { id: run.id, spawner: ctx.spawner.name, started_at: new Date().toISOString() } });

    try {
      await run.rpc.request("initialize", {
        clientInfo: { name: "agent-threads", title: "agent-threads", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      run.rpc.notify("initialized");
      const { skills } = ctx.config;
      if (skills.length) {
        run.skillsDir = writeSkills(join(this.#dir(), `skills-${run.id}`), skills);
        await run.rpc.request("skills/extraRoots/set", { extraRoots: [run.skillsDir] }).catch((e) => this.#notice(`Codex couldn't load the app's skills: ${e.message}`));
      }
      run.home = home;
      if (!o.userConfig) run.hiddenSkills = await this.#ambientSkills(run);
      const r = await this.#startThread(run);
      run.threadId = r.thread.id;
      if (r.model) run.model = r.model;
      if (r.sandbox?.type === "workspaceWrite") run.workspace = r.sandbox;
      // A rewind's resume_at was for the session it had, which this isn't if it couldn't be resumed.
      if (ctx.thread.session_id !== run.threadId) ctx.setThread({ session_id: run.threadId, resume_at: undefined });
      return run.threadId;
    } catch (e) {
      // The thread can't run: the process is stopped (and its end ends nothing), and the turn ends
      // with why.
      if (!run.exited && run === this.#run && !run.retired) {
        void this.#stop(run, true, true);
        if (ctx.turnId) ctx.endTurn({ ok: false, error: `Codex couldn't start the thread: ${e instanceof Error ? e.message : String(e)}` });
      }
      throw e;
    }
  }

  /**
   * The skills Codex finds that aren't the app's: the user's ($HOME/.agents/skills...), the
   * project's and the machine's, which a separate CODEX_HOME doesn't keep it from loading. (Its own
   * built-in ones stay.)
   */
  async #ambientSkills(run: Run): Promise<string[]> {
    const cwd = this.#ctx.thread.cwd;
    let r: SkillsListResponse;
    try {
      r = await run.rpc.request<SkillsListResponse>("skills/list", { cwds: cwd ? [cwd] : [], forceReload: true });
    } catch (e) {
      throw new Error(`Codex couldn't list its skills, to leave out the user's: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Codex reports paths with symlinks resolved (the temporary directory often is one: /var on
    // macOS), so the app's are told apart by their real paths.
    const own = run.skillsDir ? canonicalPath(run.skillsDir) + sep : undefined;
    const paths = (r.data ?? []).flatMap((e) => e.skills ?? []).filter((sk) => sk.scope !== "system" && !(own && canonicalPath(sk.path).startsWith(own)));
    return [...new Set(paths.map((sk) => sk.path))];
  }

  /** thread/resume for a thread that has a session, or thread/start (also if Codex hasn't the session). */
  async #startThread(run: Run): Promise<ThreadStartResponse> {
    const session = this.#ctx.thread.session_id;
    if (session) {
      // Codex keeps the dynamic tools the session started with, and resuming can't change them.
      const state = readSessionState(run.home, session);
      run.dynamic = state ? new Map(state.dynamicTools.map((t) => [t.name, t])) : null;
      let r: ThreadStartResponse | undefined;
      try {
        r = await run.rpc.request<ThreadStartResponse>("thread/resume", { threadId: session, ...(await this.#threadParams(run, false)), excludeTurns: true });
      } catch (e) {
        if (!(e instanceof RpcError) || !/not found|no rollout|unknown thread|does not exist/i.test(e.message)) throw e;
        this.#notice(`Codex couldn't resume its session (${e.message}), so this is a new one: it doesn't remember the thread so far.`);
      }
      if (r) {
        // After a rewind: the session as it was before the turn it went back to before.
        const at = this.#ctx.thread.resume_at;
        if (at) {
          await run.rpc.request("thread/revert", { threadId: session, beforeTurnId: at });
          if (this.#ctx.thread.resume_at === at) this.#ctx.setThread({ resume_at: undefined });
        }
        return r;
      }
    }
    return this.#newThread(run);
  }

  /** thread/start: a new session, with the app's tools as dynamic tools (or on the MCP server). */
  async #newThread(run: Run): Promise<ThreadStartResponse> {
    const tools = this.#ctx.config.tools;
    run.dynamic = new Map(this.#o.appTools === "mcp" ? [] : tools.map((t) => [t.name, toolSpec(t)]));
    let r: ThreadStartResponse;
    try {
      r = await run.rpc.request<ThreadStartResponse>("thread/start", await this.#threadParams(run, true));
    } catch (e) {
      // A Codex without dynamic tools gets the app's tools on the MCP server instead.
      if (!run.dynamic.size || !(e instanceof RpcError) || !/dynamic.?tools|experimental/i.test(e.message)) throw e;
      run.dynamic = new Map();
      r = await run.rpc.request<ThreadStartResponse>("thread/start", await this.#threadParams(run, true));
    }
    this.#saveState(run, r.thread.id);
    return r;
  }

  /** Records the session's dynamic tools, where they're known. */
  #saveState(run: Run, session: string): void {
    if (!run.dynamic) return;
    try {
      writeSessionState(run.home, session, { dynamicTools: [...run.dynamic.values()] });
    } catch (e) {
      this.#ctx.error(e);
    }
  }

  /** The app's tools that go on the MCP server: those the session hasn't as dynamic tools, as they are now. */
  #mcpTools(run: Run): Tool[] {
    return this.#ctx.config.tools.filter((t) => !(run.dynamic?.has(t.name) && sameJson(run.dynamic.get(t.name), toolSpec(t))));
  }

  /** thread/start's (`fresh`) or thread/resume's parameters. */
  async #threadParams(run: Run, fresh: boolean): Promise<ThreadStartParams> {
    const ctx = this.#ctx;
    const t = ctx.thread;
    const { mcpServers, systemPrompt } = ctx.config;
    const servers: { [name: string]: unknown } = {};
    for (const [name, s] of Object.entries(mcpServers)) {
      const c = mcpServerConfig(s);
      if (!("unsupported" in c)) servers[name] = c;
      else if (!run.noticedServers) this.#notice(`The MCP server ${name} isn't available: ${c.unsupported}.`);
    }
    run.noticedServers = true;
    run.mcpApp = this.#mcpTools(run).length > 0;
    if (run.mcpApp) {
      if (!run.mcp) {
        run.mcp = await serveTools(APP_SERVER, { tools: () => this.#mcpTools(run), call: (name, args) => this.#mcpAppTool(run, name, args) });
        run.mcpEndpoint = { port: Number(new URL(run.mcp.url).port), token: run.mcp.token };
      }
      // The policy decides on the app's tools when they're called, so Codex needn't ask.
      servers[APP_SERVER] = {
        url: run.mcp.url,
        http_headers: { Authorization: `Bearer ${run.mcp.token}` },
        default_tools_approval_mode: "approve",
        tool_timeout_sec: APP_TOOL_TIMEOUT_SEC,
      };
    }
    const config: { [k: string]: unknown } = {
      ...this.#o.config,
      // So the agent can ask the user questions outside plan mode.
      "features.default_mode_request_user_input": true,
      suppress_unstable_features_warning: true,
      ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
      ...writableRoots(this.#o.config, ctx.launch.addDirs, t.cwd),
      ...(run.hiddenSkills.length ? { skills: { config: run.hiddenSkills.map((path) => ({ path, enabled: false })) } } : {}),
    };
    const dynamic = fresh ? [...(run.dynamic?.values() ?? [])] : [];
    run.launched = launchedOf(ctx);
    // The thread starts in the workspace-write sandbox whatever its mode, so that Codex says what
    // that sandbox is with all of its config (CODEX_HOME's, the thread's writable roots...): the
    // first turn puts it in its mode's, and switching back to workspace-write later has it all.
    run.sandbox = "workspace-write";
    return {
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...(t.model ? { model: t.model } : {}),
      approvalPolicy: codexPolicy(t.permission_mode).approvalPolicy,
      sandbox: "workspace-write",
      config,
      ...(dynamic.length ? { dynamicTools: dynamic.map((d) => ({ type: "function" as const, ...d })) } : {}),
      ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
    };
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

  #exited(run: Run, status: ExitStatus): void {
    if (run.exited || run.detached) return;
    run.exited = true;
    run.abort.abort();
    run.rpc?.close(new Error(exitError(status, run.stderr, false)));
    const at = run.turnId;
    run.turnEnded();
    void run.mcp?.close();
    if (run.skillsDir) rmSync(run.skillsDir, { recursive: true, force: true });
    const ctx = this.#ctx;
    if (this.#run === run) {
      this.#run = null;
      this.#last = run;
    }
    if (ctx.thread.run?.id === run.id) ctx.setThread({ run: undefined });
    // Its subagents (child threads) end with it.
    ctx.stopSubagents(run.children.values());
    // A run that ends while its turn is running ends the turn (as interrupted, if it was).
    if (!run.retired && ctx.turnId) {
      this.#clearStop();
      ctx.endTurn({ ok: false, error: exitError(status, run.stderr, true), ...this.#plannedSoFar(run, at) });
    }
    run.planned = undefined;
    run.finish();
  }

  #notice(text: string): void {
    this.#ctx.addItem({ id: newId("n"), type: "notice", level: "warning", text });
  }

  // ---------- what Codex says ----------

  /** A line of Codex's output, parsed (undefined if it isn't JSON). */
  #line(run: Run, parsed: unknown): void {
    // Not a message: the app server writes only JSON-RPC to stdout, but be safe.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const m = parsed as Incoming;
    if (run.rpc.take(m)) return;
    if (run.retired || run !== this.#run) {
      // A run being stopped: its requests go unanswered.
      if (m.id !== undefined) run.rpc.respondError(m.id, "this session is being stopped", -32000);
      return;
    }
    try {
      // A request read again after a restart, and answered before it (though that wasn't saved):
      // Codex has its answer, and the user isn't asked again.
      if (m.id !== undefined) {
        if (!run.proc?.answered?.(m.id)) this.#request(run, m);
      } else this.#notification(run, m);
    } catch (e) {
      this.#ctx.error(e);
    }
  }

  /** The subagent call a message from a child thread belongs to: null for the thread's own, undefined for a thread it doesn't know. */
  #parent(run: Run, threadId: unknown): string | null | undefined {
    if (typeof threadId !== "string" || !run.threadId || threadId === run.threadId) return null;
    return run.children.get(threadId);
  }

  #notification(run: Run, m: Incoming): void {
    const ctx = this.#ctx;
    const p = m.params ?? {};
    const parent = this.#parent(run, p.threadId);
    if (parent === undefined) return; // A thread it doesn't know.
    const parent_id = parent ?? undefined;
    const own = parent === null;
    switch (m.method) {
      case "item/started":
      case "item/completed":
        return this.#item(run, p.item as ThreadItem, m.method === "item/completed", parent_id, own ? undefined : p.threadId);
      case "item/agentMessage/delta":
      case "item/plan/delta":
        return this.#delta(run, p.itemId, "text", p.delta, parent_id);
      case "item/reasoning/summaryTextDelta": {
        // Summary parts are joined by a blank line, as the completed item's text is.
        const part = run.summaryPart.get(p.itemId);
        if (part !== undefined && typeof p.summaryIndex === "number" && p.summaryIndex > part && p.delta) this.#delta(run, p.itemId, "reasoning", "\n\n", parent_id);
        if (typeof p.summaryIndex === "number") run.summaryPart.set(p.itemId, p.summaryIndex);
        return this.#delta(run, p.itemId, "reasoning", p.delta, parent_id);
      }
      case "item/reasoning/textDelta":
        return this.#delta(run, p.itemId, "reasoning", p.delta, parent_id);
      case "turn/plan/updated":
        return this.#plan(p as TurnPlanUpdatedNotification, parent_id);
      case "turn/started":
        if (own && p.turn?.id) {
          run.starting = true;
          run.error = null;
          run.setTurn(p.turn.id);
          run.used = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
          // The turn's mark is its first Codex turn (one that goes on after a plan has it already).
          if (!run.planned) this.#ctx.mark(p.turn.id);
        }
        // A child taking up work again (a follow-up sent to it): its report is to come.
        if (!own) {
          run.lastChild.delete(p.threadId);
          this.#subagent(run, parent_id!, (s) => collabSubagent(s, { status: "running" }));
        }
        return;
      case "turn/completed":
        if (own) return this.#turnCompleted(run, p.turn as Turn);
        return this.#childDone(run, p.threadId, p.turn as Turn, parent_id!);
      case "thread/settings/updated": {
        // Its workspace-write sandbox, kept for when it's switched back to it.
        const sandbox = p.threadSettings?.sandboxPolicy;
        if (own && sandbox?.type === "workspaceWrite") run.workspace = sandbox;
        return;
      }
      case "thread/tokenUsage/updated":
        if (!own || !p.tokenUsage) return;
        run.reported = true;
        // A report outside a turn (a resumed session's totals, say) isn't any turn's.
        if (run.used && p.tokenUsage.last) run.used = addUsage(run.used, callUsage(p.tokenUsage.last))!;
        return;
      case "account/rateLimits/updated":
        if (p.rateLimits && typeof p.rateLimits === "object") ctx.rateLimits(codexRateLimits(p.rateLimits));
        return;
      case "warning":
        if (own && p.threadId && p.message) this.#notice(p.message);
        return;
      case "error":
        if (!own) return;
        if (p.willRetry) ctx.addItem({ id: newId("n"), type: "notice", level: "warning", code: "retry", text: p.error?.message ?? "Codex is retrying." });
        else run.error = p.error?.message ?? null;
        return;
      case "mcpServer/startupStatus/updated":
        if (own && p.status === "failed" && (p.name in ctx.config.mcpServers || p.name === APP_SERVER)) {
          this.#notice(`The MCP server ${p.name} didn't start${p.error ? `: ${p.error}` : "."}`);
        }
        return;
      case "serverRequest/resolved": {
        // Codex no longer wants an answer (it answered itself, or gave up).
        if (!run.open.delete(p.requestId)) return;
        const id = run.asked.get(p.requestId);
        if (id) ctx.cancelRequest(id);
        return;
      }
    }
  }

  #delta(run: Run, itemId: string, kind: "text" | "reasoning", text: unknown, parent_id: string | undefined): void {
    if (typeof text !== "string" || !text) return;
    if (!run.streamed.has(itemId)) {
      run.streamed.add(itemId);
      this.#ctx.addItem({ id: itemId, type: kind === "text" ? "assistant_message" : "reasoning", text: "", ...(parent_id ? { parent_id } : {}) });
    }
    this.#ctx.delta(itemId, kind, text);
  }

  #item(run: Run, item: ThreadItem, done: boolean, parent_id: string | undefined, child: string | undefined): void {
    const ctx = this.#ctx;
    if (!item || typeof item !== "object") return;
    const under = parent_id ? { parent_id } : {};
    switch (item.type) {
      case "userMessage":
        // A message taken in; a child's first one is its prompt, which isn't an item.
        if (!child && !done) this.#tookIn(run, echoKey(item.content));
        return;
      case "agentMessage":
      case "plan":
      case "reasoning": {
        if (!done) return;
        const text =
          item.type === "reasoning"
            ? ((item.summary ?? []).join("\n\n") || (item.content ?? []).join("\n\n"))
            : (item.text ?? "");
        if (child && item.type === "agentMessage") run.lastChild.set(child, text);
        if (!child && item.type === "plan") run.proposed = text;
        if (run.streamed.has(item.id)) ctx.updateItem(item.id, { text });
        else if (text) ctx.addItem({ id: item.id, type: item.type === "reasoning" ? "reasoning" : "assistant_message", text, ...under });
        return;
      }
      case "collabAgentToolCall": {
        // wait, sendInput... aren't items of their own.
        if (item.tool === "spawnAgent" && !done) {
          if (!ctx.item(item.id)) {
            const prompt = item.prompt ?? "";
            ctx.addItem({ id: item.id, type: "tool_call", name: "spawnAgent", kind: "subagent", input: { prompt }, status: "running", ...(prompt ? { title: prompt } : {}), ...under });
          }
          return;
        }
        if (!done) return;
        if (item.tool === "spawnAgent") {
          for (const t of item.receiverThreadIds ?? []) run.children.set(t, item.id);
          ctx.updateItem(item.id, spawnDone(item));
        }
        // Any collab call's completion says how the child threads it's about are getting on.
        for (const [t, state] of Object.entries(item.agentsStates ?? {})) {
          const call = run.children.get(t);
          if (call) this.#subagent(run, call, (s) => collabSubagent(s, state));
        }
        return;
      }
      case "contextCompaction":
        if (!done && !ctx.item(item.id)) ctx.addItem({ id: item.id, type: "compaction", trigger: run.compacting ? "manual" : "auto", ...under });
        return;
    }
    if (!isToolItem(item)) return;
    const fields = codexTool(item, run.mcpApp);
    if (item.type === "mcpToolCall") {
      run.mcpCalls = run.mcpCalls.filter((c) => c.id !== item.id);
      if (!done) run.mcpCalls.push({ id: item.id, server: item.server, name: item.tool, args: item.arguments ?? {}, thread: child ?? run.threadId });
    }
    const it = ctx.item(item.id) as ToolCall | undefined;
    if (!done) {
      if (!it) ctx.addItem({ id: item.id, type: "tool_call", ...fields, status: "running", ...under });
      return;
    }
    if (!it) ctx.addItem({ id: item.id, type: "tool_call", ...fields, status: "running", ...under, ...codexDone(item, false) } as ToolCall);
    else ctx.updateItem(item.id, codexDone(item, it.status === "denied"));
  }

  /** A plan update: the turn's todo list, one item per turn and thread. */
  #plan(p: TurnPlanUpdatedNotification, parent_id: string | undefined): void {
    const ctx = this.#ctx;
    const id = `plan-${p.threadId}-${p.turnId}`;
    const input = { ...(p.explanation ? { explanation: p.explanation } : {}), plan: p.plan };
    if (ctx.item(id)) ctx.updateItem(id, { input, todos: todos(p.plan) });
    else ctx.addItem({ id, type: "tool_call", name: "update_plan", kind: "todo", input, todos: todos(p.plan), status: "completed", ...(parent_id ? { parent_id } : {}) });
  }

  #tookIn(run: Run, key: string): void {
    const at = run.sent.findIndex((s) => s.key === key);
    if (at < 0) return;
    const { ids } = run.sent[at]!;
    // Sent more than once (steered, then carried over), they're all taken in now.
    run.sent = run.sent.filter((s) => !s.ids.some((id) => ids.includes(id)));
    for (const id of ids) {
      run.held.delete(id);
      this.#ctx.tookIn(id);
    }
  }

  #turnCompleted(run: Run, turn: Turn): void {
    const ctx = this.#ctx;
    const error = run.error;
    const at = turn?.id ?? run.turnId;
    const plan = run.proposed;
    run.proposed = undefined;
    run.turnEnded();
    run.error = null;
    // The turn's requests are moot now; its open ones are cancelled with it. A background
    // subagent's carry on.
    for (const [id, open] of run.open) {
      if (!this.#inBackground(this.#parent(run, open.msg.params?.threadId) ?? undefined)) run.open.delete(id);
    }
    const usage = run.reported ? (run.used ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }) : undefined;
    run.used = null;
    if (!ctx.turnId) return;
    this.#clearStop();
    const ok = turn?.status === "completed";
    // The thread's turn is all of its Codex turns, the plans' included.
    const sum: Planned = { ...run.planned };
    // Its mark is its first Codex turn: reverting to before that takes back all of them.
    sum.session_at ??= at;
    sum.usage = addUsage(sum.usage, usage);
    if (typeof turn?.durationMs === "number") sum.duration_ms = (sum.duration_ms ?? 0) + turn.durationMs;
    delete sum.request;
    if (plan !== undefined && ok && ctx.thread.permission_mode === "plan" && !ctx.interrupted) {
      // A plan: the turn goes on while the user decides whether to start on it.
      run.planned = sum;
      run.planned.request = ctx.ask({ type: "plan", plan }, undefined, (res) => this.#planAnswered(run, res));
      return;
    }
    run.planned = undefined;
    ctx.endTurn({
      ok,
      ...(turn?.status === "failed" ? { error: turn.error?.message ?? error ?? "The turn failed." } : {}),
      ...(sum.usage ? { usage: sum.usage } : {}),
      ...(sum.duration_ms !== undefined ? { duration_ms: sum.duration_ms } : {}),
      ...(sum.session_at ? { session_at: sum.session_at } : {}),
    });
  }

  /**
   * The user answered a plan: approved, Codex implements it in the mode the thread carries on in;
   * sent back with feedback, it plans again. Either way in another Codex turn of the same turn.
   * Otherwise the turn ends.
   */
  #planAnswered(run: Run, res: Resolution): void {
    if (run !== this.#live() || !run.planned?.request || run.detached) return;
    run.planned.request = undefined;
    const ctx = this.#ctx;
    const text = (t: string): UserInput[] => [{ type: "text", text: t, text_elements: [] }];
    if (res.outcome === "allow") {
      ctx.setThread({ permission_mode: modeAfterPlan(ctx.thread.permission_mode, res.permission_mode) });
      this.#startTurn(run, text(IMPLEMENT));
    } else if (res.outcome === "deny" && res.message) this.#startTurn(run, text(res.message));
    else this.#endPlanned(run);
  }

  /** Ends a turn that's waiting on its plan (or whose plan wasn't answered), as its Codex turns went. */
  #endPlanned(run: Run): void {
    const planned = run.planned;
    if (!planned || run !== this.#run) return;
    run.planned = undefined;
    if (planned.request) this.#ctx.cancelRequest(planned.request);
    this.#clearStop();
    if (!this.#ctx.turnId) return;
    this.#ctx.endTurn({
      ok: true,
      ...(planned.usage ? { usage: planned.usage } : {}),
      ...(planned.duration_ms !== undefined ? { duration_ms: planned.duration_ms } : {}),
      ...(planned.session_at ? { session_at: planned.session_at } : {}),
    });
  }

  /** A subagent's turn ended: so did the subagent, with its last message. */
  #childDone(run: Run, child: string, turn: Turn, callId: string): void {
    this.#subagent(run, callId, (s) => childTurnSubagent(s, turn, run.lastChild.get(child)));
  }

  /**
   * Changes a spawnAgent call's subagent, if it has one (`change` returns undefined to leave it).
   * One that ends leaves nothing running: what it was doing is cancelled, and its requests with it.
   */
  #subagent(run: Run, callId: string, change: (s: SubagentState) => SubagentState | undefined): void {
    const ctx = this.#ctx;
    const it = ctx.item(callId);
    if (it?.type !== "tool_call" || !it.subagent) return;
    const next = change(it.subagent);
    if (!next) return;
    // Its requests Codex no longer wants answered: the user's too, those that aren't about one of
    // its calls (which ending it doesn't reach) included.
    const asked: string[] = [];
    if (it.subagent.status === "running" && next.status !== "running") {
      const lookup = (id: string) => ctx.item(id);
      const within = (call: string | null | undefined) => !!call && (call === callId || [...ancestors(lookup, call)].some((a) => a.id === callId));
      for (const id of [...run.open.keys()]) {
        if (!within(this.#parent(run, run.open.get(id)!.msg.params?.threadId))) continue;
        run.open.delete(id);
        const rid = run.asked.get(id);
        if (rid) asked.push(rid);
      }
    }
    ctx.endSubagent(callId, next);
    for (const rid of asked) ctx.cancelRequest(rid);
  }

  /** Whether what comes from the child thread of this subagent call is a background subagent's, which carries on after its turn. */
  #inBackground(parentId: string | undefined): boolean {
    const lookup = (id: string) => this.#ctx.item(id);
    return parentId !== undefined && (runningInBackground(lookup(parentId)) || inBackground(lookup, parentId));
  }

  // ---------- the server's requests ----------

  /**
   * A request of Codex's; `resume` when it's one that was open when the backend restarted: the turn
   * it came in, and the request the user was asked with, which is taken up again.
   */
  #request(run: Run, m: Incoming, resume?: { turn: string | undefined; existing: string | undefined }): void {
    const id = m.id!;
    const p = m.params ?? {};
    const parent = this.#parent(run, p.threadId);
    const ctx = this.#ctx;
    const turn = resume ? resume.turn : ctx.turnId;
    const existing = resume?.existing;
    run.open.set(id, { turn, msg: m });
    // Whether Codex still wants this answered: not resolved, its turn not over (unless it's a
    // background subagent's, which carries on after it), its run not gone. (Not once it's left
    // running as the backend shuts down: what's open stays as it was saved.)
    const wanted = () =>
      run.open.has(id) &&
      !run.exited &&
      !run.retired &&
      !run.detached &&
      this.#run === run &&
      (ctx.turnId === turn || this.#inBackground(parent ?? undefined));
    const answer = (result: unknown) => {
      if (!wanted()) return;
      run.open.delete(id);
      run.rpc.respond(id, result);
    };
    const parentId = parent ?? undefined;
    switch (m.method) {
      case "item/commandExecution/requestApproval": {
        const q = p as CommandExecutionRequestApprovalParams;
        const it = ctx.item(q.itemId) as ToolCall | undefined;
        const t = it ?? { name: "commandExecution", kind: "shell" as const, input: { command: q.command, cwd: q.cwd }, ...(q.command ? { command: unwrapCommand(q.command) } : {}) };
        return this.#permit(run, id, this.#query(t, q.itemId, q.reason, parentId), wanted, (ok) => answer({ decision: ok ? "accept" : "decline" }), existing);
      }
      case "item/fileChange/requestApproval": {
        const q = p as FileChangeRequestApprovalParams;
        const it = ctx.item(q.itemId) as ToolCall | undefined;
        const t = it ?? { name: "fileChange", kind: "edit" as const, input: { grantRoot: q.grantRoot ?? null } };
        return this.#permit(run, id, this.#query(t, q.itemId, q.reason, parentId), wanted, (ok) => answer({ decision: ok ? "accept" : "decline" }), existing);
      }
      case "item/permissions/requestApproval": {
        const q = p as PermissionsRequestApprovalParams;
        const t = { name: "permissions", kind: "other" as const, input: { permissions: q.permissions, cwd: q.cwd, ...(q.reason ? { reason: q.reason } : {}) }, title: q.reason ?? "More permissions" };
        return this.#permit(
          run,
          id,
          this.#query(t, q.itemId, q.reason, parentId),
          wanted,
          (ok) => answer({ permissions: ok ? q.permissions : {}, scope: "turn" }),
          existing,
        );
      }
      case "mcpServer/elicitation/request":
        return this.#elicitation(run, id, p, wanted, answer, parentId, existing);
      case "item/tool/requestUserInput":
        return this.#userInput(run, id, p as ToolRequestUserInputParams, answer, parentId, existing);
      case "item/tool/call":
        return this.#dynamicTool(run, id, p as DynamicToolCallParams, wanted, answer, parentId, existing);
      default:
        run.open.delete(id);
        run.rpc.respondError(id, `agent-threads doesn't handle ${m.method}`);
    }
  }

  /** A permission query about a call (the item, or what the request says about it). */
  #query(t: Pick<ToolCall, "name" | "kind" | "input"> & Partial<ToolCall>, itemId: string | undefined, reason: string | null | undefined, parentId: string | undefined): PermissionQuery {
    const known = itemId && this.#ctx.item(itemId) ? itemId : undefined;
    return {
      name: t.name,
      kind: t.kind,
      input: t.input,
      title: t.title ?? title(t),
      ...(t.kind === "shell" && t.command ? { command: t.command } : {}),
      ...(t.server ? { server: t.server } : {}),
      ...(reason ? { reason } : {}),
      ...(known ? { toolCallId: known } : {}),
      ...(parentId ? { parentId } : {}),
    };
  }

  /**
   * Asks the policy (and, if it says so, the user) about a call, and calls `done` with the answer
   * while `wanted` holds: synchronously when the policy answers synchronously, so effects keep
   * their order.
   */
  #permit(run: Run, requestId: RequestId | undefined, q: PermissionQuery, wanted: () => boolean, done: (ok: boolean, message: string) => void, existing?: string): void {
    const ctx = this.#ctx;
    const ask: typeof ctx.ask = (request, toolCallId, answered, standing) =>
      existing !== undefined && ctx.reopen(existing, answered, standing) ? existing : ctx.ask(request, toolCallId, answered, standing);
    const call = q.toolCallId;
    const denied = () => call && ctx.updateItem(call, { status: "denied" });
    const apply = (d: PermissionDecision) => {
      // A policy that took a while may answer after Codex stopped asking.
      if (!wanted()) return;
      if (d === "allow") return done(true, "");
      if (d === "ask") {
        const id = ask(
          {
            type: "permission",
            name: q.name,
            kind: q.kind,
            input: q.input,
            ...(q.title ? { title: q.title } : {}),
            ...(q.reason ? { reason: q.reason } : {}),
            ...(q.parentId ? { parent_id: q.parentId } : {}),
          },
          call,
          (res: Resolution) => {
            if (!wanted()) return;
            if (res.outcome === "allow") {
              done(true, "");
              if (call) ctx.updateItem(call, { status: "running" });
            } else {
              done(false, res.message || "The user didn't allow this.");
              denied();
            }
          },
          permissionKey(q),
        );
        if (requestId !== undefined) run.asked.set(requestId, id);
        return;
      }
      done(false, typeof d === "object" ? d.deny : "The app's permission policy doesn't allow this.");
      denied();
    };
    // The user was asked before the backend restarted: they still are.
    const d = existing !== undefined ? "ask" : ctx.decide(q);
    if (d instanceof Promise) void d.then(apply);
    else apply(d);
  }

  /** An MCP server asking: Codex asks this way whether a tool on it may be called. */
  #elicitation(run: Run, id: RequestId, p: any, wanted: () => boolean, answer: (r: McpServerElicitationRequestResponse) => void, parentId: string | undefined, existing?: string): void {
    const server: string = p.serverName ?? "";
    const fields = Object.keys(p.requestedSchema?.properties ?? {}).length;
    // Only an elicitation that needs nothing filled in ("may it call this tool?") can be answered.
    if (p.mode !== "form" || fields > 0) return answer({ action: "decline" });
    // The app's own tools are decided on when they're called.
    if (server === APP_SERVER && run.mcpApp) return answer({ action: "accept", content: {} });
    // The policy is asked about the tool and arguments the elicitation names. The running call is
    // only taken to be the one it's about if it's the only one that matches it.
    const message: string = p.message ?? "";
    const named = /tool "([^"]+)"/.exec(message)?.[1];
    const params: unknown = p._meta?.tool_params;
    const thread = typeof p.threadId === "string" ? p.threadId : run.threadId;
    const matching = named
      ? run.mcpCalls.filter((c) => c.server === server && c.thread === thread && c.name === named && (params === undefined || sameJson(c.args, params)))
      : [];
    const it = matching.length === 1 ? (this.#ctx.item(matching[0]!.id) as ToolCall | undefined) : undefined;
    const t = { name: named ?? "elicitation", kind: "mcp" as const, server, input: params ?? it?.input ?? {}, ...(it ? {} : { title: message }) };
    this.#permit(run, id, this.#query(t, it?.id, undefined, parentId), wanted, (ok) => answer(ok ? { action: "accept", content: {} } : { action: "decline" }), existing);
  }

  /** A question for the user: a request_user_input call, and a question request for it. */
  #userInput(run: Run, id: RequestId, p: ToolRequestUserInputParams, answer: (r: ToolRequestUserInputResponse) => void, parentId: string | undefined, existing?: string): void {
    const ctx = this.#ctx;
    const qs = questions(p.questions ?? []);
    if (!ctx.item(p.itemId)) {
      ctx.addItem({ id: p.itemId, type: "tool_call", name: "request_user_input", kind: "other", input: { questions: p.questions }, status: "pending", ...(parentId ? { parent_id: parentId } : {}) });
    }
    if (!qs.length) {
      answer({ answers: {} });
      return void ctx.updateItem(p.itemId, { status: "completed", result: { content: "" } });
    }
    const answered = (res: Resolution) => {
      if (res.outcome !== "answer") {
        answer({ answers: {} });
        return void ctx.updateItem(p.itemId, { status: "denied" });
      }
      const answers: ToolRequestUserInputResponse["answers"] = {};
      const lines: string[] = [];
      const secret = new Set(qs.filter((q) => q.secret).map((q) => q.id));
      for (const [q, a] of Object.entries(res.answers ?? {})) {
        answers[q] = { answers: a ?? [] };
        // The real answer goes only to Codex; the call's result is shown and saved.
        lines.push(`${q}: ${secret.has(q) && a?.length ? SECRET : (a ?? []).join(", ")}`);
      }
      answer({ answers });
      ctx.updateItem(p.itemId, { status: "completed", result: { content: lines.join("\n") } });
    };
    const rid =
      existing !== undefined && ctx.reopen(existing, answered) ? existing : ctx.ask({ type: "question", questions: qs as [(typeof qs)[0], ...typeof qs] }, p.itemId, answered);
    run.asked.set(id, rid);
  }

  /** item/tool/call: one of the app's tools, given as a dynamic tool. */
  #dynamicTool(
    run: Run,
    id: RequestId,
    p: DynamicToolCallParams,
    wanted: () => boolean,
    answer: (r: DynamicToolCallResponse) => void,
    parentId: string | undefined,
    existing?: string,
  ): void {
    const reply = (text: string, ok: boolean) => answer({ contentItems: [{ type: "inputText", text }], success: ok });
    const tool = this.#ctx.config.tools.find((t) => t.name === p.tool);
    // Codex keeps a session's dynamic tools as they were: one that has gone or changed since is
    // answered with where the app's tools are now.
    const elsewhere = () => {
      const names = this.#mcpTools(run).map((t) => t.name);
      return names.length ? ` The app's other tools are on its ${APP_SERVER} MCP server: ${names.join(", ")}.` : "";
    };
    if (!tool) return reply(run.dynamic?.has(p.tool) ? `The tool ${p.tool} isn't available any more.${elsewhere()}` : `There's no tool ${p.tool}.`, false);
    const was = run.dynamic?.get(p.tool);
    if (run.dynamic && !(was && sameJson(was, toolSpec(tool)))) return reply(`The tool ${p.tool} has changed: call it on the ${APP_SERVER} MCP server instead.`, false);
    const t = { name: p.tool, kind: "app" as const, input: p.arguments ?? {}, title: p.tool };
    this.#permit(
      run,
      id,
      this.#query(t, p.callId, undefined, parentId),
      wanted,
      (ok, message) => {
        if (!ok) return reply(message, false);
        // Saved as running before it runs, so a backend that restarts while it does answers it
        // rather than run it again (see #reopen).
        const open = run.open.get(id);
        if (open) open.started = true;
        void this.#ctx.persist().then(
          () => {
            if (!wanted() || run.detached) return;
            void this.#runApp(run, p.tool, p.arguments ?? {}, p.callId).then((out) => {
              // The backend shut down while it ran (and aborted it): it's left open, as saved, for
              // the backend that re-attaches to answer.
              if (run.detached) return;
              reply(out.text, !out.isError);
              // Saved as answered, though no event says so: a restart doesn't answer it again.
              this.#ctx.persist().catch(() => {});
            });
          },
          () => reply("The app couldn't save its state, so it didn't run this tool.", false),
        );
      },
      existing,
    );
  }

  /** tools/call on the loopback MCP server: one of the app's tools. */
  #mcpAppTool(run: Run, name: string, args: unknown): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    const ctx = this.#ctx;
    if (!this.#mcpTools(run).some((t) => t.name === name)) return Promise.resolve({ text: `There's no tool ${name}.`, isError: true });
    // The call it is, if only one running call matches it.
    const matching = run.mcpCalls.filter((c) => c.server === APP_SERVER && c.name === name && sameJson(c.args, args ?? {}));
    const it = matching.length === 1 ? ctx.item(matching[0]!.id) : undefined;
    const turn = ctx.turnId;
    const wanted = () => !run.exited && !run.retired && !run.detached && this.#run === run && (ctx.turnId === turn || this.#inBackground(it?.parent_id));
    const t = { name, kind: "app" as const, input: args ?? {}, title: name };
    return new Promise((resolve) => {
      this.#permit(run, undefined, this.#query(t, it?.id, undefined, it?.parent_id), wanted, (ok, message) => {
        if (!ok) return resolve({ text: message, isError: true });
        void this.#runApp(run, name, args, it?.id).then(resolve);
      });
    });
  }

  #runApp(run: Run, name: string, args: unknown, toolCallId: string | undefined): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    const ctx = this.#ctx;
    const tool = ctx.config.tools.find((t) => t.name === name);
    if (!tool) return Promise.resolve({ text: `There's no tool ${name}.`, isError: true });
    return runTool(tool, args, {
      threadId: ctx.threadId,
      metadata: ctx.thread.metadata ?? {},
      ...(toolCallId ? { toolCallId } : {}),
      signal: run.abort.signal,
    }).then((out) => {
      if (toolCallId && !run.detached) ctx.toolOutput(toolCallId, out.structured);
      return out;
    });
  }
}

type ToolSpec = { name: string; description: string; inputSchema: unknown };

/** Where Codex's sandbox lets the agent write besides the working directory (a dotted config key). */
const WRITABLE_ROOTS = "sandbox_workspace_write.writable_roots";

/**
 * The thread's other directories, as config: writable as its working directory is (relative ones
 * are in it), after any the options' config gives. Nothing if it has none.
 */
function writableRoots(config: { [k: string]: unknown } | undefined, addDirs: string[] | undefined, cwd: string | undefined): { [k: string]: unknown } {
  if (!addDirs?.length) return {};
  const given = config?.[WRITABLE_ROOTS];
  const roots = Array.isArray(given) ? [...given] : [];
  for (const d of addDirs) roots.push(cwd && !isAbsolute(d) ? join(cwd, d) : d);
  return { [WRITABLE_ROOTS]: roots };
}

/** A tool as Codex has it as a dynamic tool. */
function toolSpec(t: Tool): ToolSpec {
  return { name: t.name, description: t.description, inputSchema: t.input };
}


/** A path with its symlinks resolved, where it exists. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether two JSON values are equal, whatever their keys' order. */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as { [k: string]: unknown })[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** What identifies a message in Codex's userMessage item: its text inputs and how many images it has. */
function echoKey(input: unknown): string {
  const parts = Array.isArray(input) ? (input as { type?: string; text?: string }[]) : [];
  return JSON.stringify([parts.filter((p) => p?.type === "text").map((p) => p.text), parts.filter((p) => p?.type === "image" || p?.type === "localImage").length]);
}

function exitError(status: ExitStatus, stderr: string[], duringTurn: boolean): string {
  if (status.error) return `Codex couldn't be started: ${status.error.message}`;
  const how = status.signal ? `was stopped by ${status.signal}` : `exited with code ${status.code}`;
  const tail = stderr.join("\n").trim();
  return `Codex ${how}${duringTurn ? " during the turn" : ""}.${tail ? `\n${tail.slice(-2000)}` : ""}`;
}

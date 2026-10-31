// The Codex driver: runs `codex app-server` (JSON-RPC over stdio), one process per thread (started
// at its first message, kept between turns), and translates its items into the thread's events by
// the rules in spec/fixtures/README.md. A message is turn/start (or turn/steer while a turn runs);
// the server's approval and question requests go through the permission policy; the app's tools are
// dynamic tools answered over item/tool/call, or (where Codex can't take those) a loopback MCP server.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Resolution, ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { messageParts } from "../attachments.js";
import { title } from "../claude/translate.js";
import type { Harness, HarnessSession, Message, ThreadContext } from "../harness.js";
import { newId } from "../ids.js";
import { serveTools, type LoopbackMcp } from "../mcp-http.js";
import { permissionKey, type PermissionDecision, type PermissionQuery } from "../permissions.js";
import { writeSkills } from "../skills.js";
import type { ExitStatus, HarnessProcess } from "../spawner.js";
import { runTool } from "../tools.js";
import { defaultCodexHome, prepareCodexHome, userCodexHome } from "./home.js";
import type {
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  TokenUsageBreakdown,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnPlanUpdatedNotification,
  TurnStartResponse,
  UserInput,
} from "./protocol.js";
import { Rpc, RpcError, type Incoming, type RequestId } from "./rpc.js";
import { APP_SERVER, codexDone, codexPolicy, codexTool, codexUsage, isToolItem, mcpServerConfig, questions, todos } from "./translate.js";

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

/** One `codex app-server` process, and what's needed to read it. */
class Run {
  readonly id = newId("run");
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
  /** The thread's token totals, as Codex last reported them in this run. */
  total: TokenUsageBreakdown | null = null;
  /** The running turn's last error that won't be retried. */
  error: string | null = null;
  /** The app's tools are on the loopback MCP server, not dynamic tools. */
  mcpApp = false;
  mcp: LoopbackMcp | undefined;
  skillsDir: string | undefined;
  // What's needed to translate its output.
  streamed = new Set<string>(); // items that got deltas
  summaryPart = new Map<string, number>(); // reasoning item -> the summary part its deltas are in
  children = new Map<string, string>(); // child thread -> the spawnAgent call it's for
  lastChild = new Map<string, string>(); // child thread -> its last message
  /** MCP tool calls running: for an elicitation (which only names its server) and the app's MCP tools. */
  mcpCalls: { id: string; server: string; name: string }[] = [];
  /** The server's requests not yet answered. */
  open = new Set<RequestId>();
  asked = new Map<RequestId, string>(); // the server's request -> our request
  /** Messages sent, oldest first, by the text inputs Codex echoes in its userMessage item. */
  sent: { ids: string[]; key: string }[] = [];
  /** Queued messages this process has (it was sent them, and didn't refuse them). */
  held = new Set<string>();

  constructor() {
    this.done = new Promise((r) => (this.finish = r));
  }

  write(msg: object): void {
    if (!this.exited) this.proc?.write(JSON.stringify(msg));
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
  /** A run being stopped, which the next must wait for. */
  #stopping: Promise<void> | null = null;
  /** The options changed since the run started: the next turn starts a new one. */
  #stale = false;
  #stopTimer: NodeJS.Timeout | undefined;
  /** A directory for the thread's generated files (skills, attached files), made when needed. */
  #tmp: string | undefined;
  #closed = false;

  constructor(ctx: ThreadContext, options: CodexOptions) {
    this.#ctx = ctx;
    this.#o = options;
  }

  // ---------- the core's side ----------

  start(messages: Message[]): void {
    const run = this.#ensure(true);
    if (messages.length === 1 && messages[0]!.text.trim() === "/compact" && !messages[0]!.attachments?.length) {
      run.starting = true;
      run.compacting = true;
      void run.ready
        .then((threadId) => run.rpc.request("thread/compact/start", { threadId }))
        .catch((e) => this.#turnFailed(run, e));
      return;
    }
    this.#turnStart(run, messages);
  }

  steer(message: Message): void {
    const run = this.#live();
    // With no process, there's no turn to steer: the message stays queued, and the turn's end
    // carries it over.
    if (!run) return;
    const input = this.#input([message]);
    const sent = this.#sent(run, [message.id], input);
    run.withTurn((turnId) => {
      if (!turnId) return void this.#refused(run, sent);
      run.rpc
        .request("turn/steer", { threadId: run.threadId, expectedTurnId: turnId, input })
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
    run.withTurn((turnId) => {
      if (turnId && !run.exited) void run.rpc.request("turn/interrupt", { threadId: run.threadId, turnId }).catch(() => {});
    });
    const turn = this.#ctx.turnId;
    clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => {
      if (this.#ctx.turnId === turn && !run.exited) void this.#stop(run, false);
    }, this.#o.stopGraceMs ?? 10_000);
    this.#stopTimer.unref?.();
  }

  optionsChanged(): void {
    this.#stale = true;
  }

  live(): boolean {
    return !!this.#live();
  }

  release(): void {
    const run = this.#live();
    // A process that has the messages is stopped, so it can't act on them unseen.
    if (run && this.#ctx.queued().some((m) => run.held.has(m.id))) void this.#stop(run, true, true);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#stopTimer);
    const run = this.#run;
    if (run) await this.#stop(run, false);
    if (this.#stopping) await this.#stopping;
    if (this.#tmp) rmSync(this.#tmp, { recursive: true, force: true });
    this.#tmp = undefined;
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
    const sent = this.#sent(run, messages.map((m) => m.id), input);
    run.starting = true;
    const effort = this.#ctx.thread.effort;
    void run.ready
      .then((threadId) => run.rpc.request<TurnStartResponse>("turn/start", { threadId, input, ...(effort ? { effort } : {}) }))
      .then((r) => {
        if (r.turn?.id && run.starting && !run.turnId) run.setTurn(r.turn.id);
      })
      .catch((e) => {
        this.#refused(run, sent);
        this.#turnFailed(run, e);
      });
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
    run.turnEnded();
    if (this.#ctx.turnId) this.#ctx.endTurn({ ok: false, error: e instanceof Error ? e.message : String(e) });
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
    run.proc?.closeInput();
    const grace = this.#o.closeGraceMs ?? 5_000;
    if (now) run.proc?.kill("SIGTERM");
    const term = setTimeout(() => run.proc?.kill("SIGTERM"), grace);
    const kill = setTimeout(() => run.proc?.kill("SIGKILL"), grace * 2);
    const stopped = run.done.then(() => {
      clearTimeout(term);
      clearTimeout(kill);
    });
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
    let home: string;
    try {
      home = o.userConfig ? userCodexHome() : prepareCodexHome(o.home ?? defaultCodexHome(), o.login ?? userCodexHome());
    } catch (e) {
      this.#exited(run, { code: null, signal: null, error: e instanceof Error ? e : new Error(String(e)) });
      throw e;
    }
    let proc: HarnessProcess;
    try {
      proc = ctx.spawner.spawn(
        {
          command: o.bin ?? "codex",
          args: [...(o.binArgs ?? []), "app-server", ...(o.args ?? [])],
          ...(ctx.thread.cwd ? { cwd: ctx.thread.cwd } : {}),
          env: { ...process.env, ...o.env, CODEX_HOME: home },
          threadId: ctx.threadId,
          runId: run.id,
        },
        {
          line: (line) => this.#line(run, line),
          stderr: (line) => {
            run.stderr.push(line);
            if (run.stderr.length > 20) run.stderr.shift();
          },
          exit: (status) => this.#exited(run, status),
        },
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
      run.mcpApp = o.appTools === "mcp";
      let r: ThreadStartResponse;
      try {
        r = await this.#startThread(run);
      } catch (e) {
        // A Codex without dynamic tools gets the app's tools as an MCP server instead.
        if (run.mcpApp || !ctx.config.tools.length || !(e instanceof RpcError) || !/dynamic.?tools|experimental/i.test(e.message)) throw e;
        run.mcpApp = true;
        r = await this.#startThread(run);
      }
      run.threadId = r.thread.id;
      if (ctx.thread.session_id !== run.threadId) ctx.setThread({ session_id: run.threadId });
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

  /** thread/start, or thread/resume for a thread that has a session (or thread/start, if that's gone). */
  async #startThread(run: Run): Promise<ThreadStartResponse> {
    const ctx = this.#ctx;
    const params = await this.#threadParams(run);
    const session = ctx.thread.session_id;
    if (!session) return run.rpc.request<ThreadStartResponse>("thread/start", params);
    try {
      return await run.rpc.request<ThreadStartResponse>("thread/resume", { threadId: session, ...params, excludeTurns: true });
    } catch (e) {
      if (!(e instanceof RpcError) || !/not found|no rollout|unknown thread|does not exist/i.test(e.message)) throw e;
      this.#notice(`Codex couldn't resume its session (${e.message}), so this is a new one: it doesn't remember the thread so far.`);
      return run.rpc.request<ThreadStartResponse>("thread/start", params);
    }
  }

  async #threadParams(run: Run): Promise<ThreadStartParams> {
    const ctx = this.#ctx;
    const t = ctx.thread;
    const { tools, mcpServers, systemPrompt } = ctx.config;
    const servers: { [name: string]: unknown } = {};
    for (const [name, s] of Object.entries(mcpServers)) {
      const c = mcpServerConfig(s);
      if ("unsupported" in c) this.#notice(`The MCP server ${name} isn't available: ${c.unsupported}.`);
      else servers[name] = c;
    }
    if (tools.length && run.mcpApp) {
      run.mcp ??= await serveTools(APP_SERVER, { tools: () => ctx.config.tools, call: (name, args) => this.#mcpAppTool(run, name, args) });
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
    };
    return {
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...(t.model ? { model: t.model } : {}),
      ...codexPolicy(t.permission_mode),
      config,
      ...(tools.length && !run.mcpApp
        ? { dynamicTools: tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, inputSchema: tool.input })) }
        : {}),
      ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
    };
  }

  #exited(run: Run, status: ExitStatus): void {
    if (run.exited) return;
    run.exited = true;
    run.abort.abort();
    run.rpc?.close(new Error(exitError(status, run.stderr, false)));
    run.turnEnded();
    void run.mcp?.close();
    if (run.skillsDir) rmSync(run.skillsDir, { recursive: true, force: true });
    const ctx = this.#ctx;
    if (this.#run === run) this.#run = null;
    if (ctx.thread.run?.id === run.id) ctx.setThread({ run: undefined });
    // A run that ends while its turn is running ends the turn (as interrupted, if it was).
    if (!run.retired && ctx.turnId) {
      clearTimeout(this.#stopTimer);
      ctx.endTurn({ ok: false, error: exitError(status, run.stderr, true) });
    }
    run.finish();
  }

  #notice(text: string): void {
    this.#ctx.addItem({ id: newId("n"), type: "notice", level: "warning", text });
  }

  // ---------- what Codex says ----------

  #line(run: Run, line: string): void {
    let m: Incoming;
    try {
      m = JSON.parse(line);
    } catch {
      return; // Not a message: the app server writes only JSON-RPC to stdout, but be safe.
    }
    if (!m || typeof m !== "object") return;
    if (run.rpc.take(m)) return;
    if (run.retired || run !== this.#run) {
      // A run being stopped: its requests go unanswered.
      if (m.id !== undefined) run.rpc.respondError(m.id, "this session is being stopped", -32000);
      return;
    }
    try {
      if (m.id !== undefined) this.#request(run, m);
      else this.#notification(run, m);
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
        }
        return;
      case "turn/completed":
        if (own) return this.#turnCompleted(run, p.turn as Turn);
        return this.#childDone(run, p.threadId, p.turn as Turn, parent_id!);
      case "thread/tokenUsage/updated":
        if (own && p.tokenUsage?.total) run.total = p.tokenUsage.total;
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
        if (run.streamed.has(item.id)) ctx.updateItem(item.id, { text });
        else if (text) ctx.addItem({ id: item.id, type: item.type === "reasoning" ? "reasoning" : "assistant_message", text, ...under });
        return;
      }
      case "collabAgentToolCall": {
        if (item.tool !== "spawnAgent") return; // wait, sendInput... aren't items of their own.
        if (!done) {
          if (!ctx.item(item.id)) {
            const prompt = item.prompt ?? "";
            ctx.addItem({ id: item.id, type: "tool_call", name: "spawnAgent", kind: "subagent", input: { prompt }, status: "running", ...(prompt ? { title: prompt } : {}), ...under });
          }
          return;
        }
        for (const t of item.receiverThreadIds ?? []) run.children.set(t, item.id);
        if (item.status === "failed") ctx.updateItem(item.id, { status: "failed" });
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
      if (!done) run.mcpCalls.push({ id: item.id, server: item.server, name: item.tool });
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
    run.turnEnded();
    run.error = null;
    // The turn's requests are moot now; its open ones are cancelled with it.
    run.open.clear();
    if (!ctx.turnId) return;
    clearTimeout(this.#stopTimer);
    const ok = turn?.status === "completed";
    ctx.endTurn({
      ok,
      ...(turn?.status === "failed" ? { error: turn.error?.message ?? error ?? "The turn failed." } : {}),
      ...(run.total ? { usage: codexUsage(run.total, ctx.thread.usage) } : {}),
      ...(typeof turn?.durationMs === "number" ? { duration_ms: turn.durationMs } : {}),
    });
  }

  /** A subagent's turn ended: so did its call, with the subagent's last message. */
  #childDone(run: Run, child: string, turn: Turn, callId: string): void {
    const status = turn?.status === "completed" ? "completed" : turn?.status === "interrupted" ? "cancelled" : "failed";
    const content = status === "failed" ? (turn?.error?.message ?? run.lastChild.get(child) ?? "") : (run.lastChild.get(child) ?? "");
    this.#ctx.updateItem(callId, { status, result: { content } });
  }

  // ---------- the server's requests ----------

  #request(run: Run, m: Incoming): void {
    const id = m.id!;
    const p = m.params ?? {};
    const parent = this.#parent(run, p.threadId);
    const ctx = this.#ctx;
    const turn = ctx.turnId;
    run.open.add(id);
    // Whether Codex still wants this answered: not resolved, its turn not over, its run not gone.
    const wanted = () => run.open.has(id) && !run.exited && !run.retired && this.#run === run && ctx.turnId === turn;
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
        const t = it ?? { name: "commandExecution", kind: "shell" as const, input: { command: q.command, cwd: q.cwd }, ...(q.command ? { command: q.command } : {}) };
        return this.#permit(run, id, this.#query(t, q.itemId, q.reason, parentId), wanted, (ok) => answer({ decision: ok ? "accept" : "decline" }));
      }
      case "item/fileChange/requestApproval": {
        const q = p as FileChangeRequestApprovalParams;
        const it = ctx.item(q.itemId) as ToolCall | undefined;
        const t = it ?? { name: "fileChange", kind: "edit" as const, input: { grantRoot: q.grantRoot ?? null } };
        return this.#permit(run, id, this.#query(t, q.itemId, q.reason, parentId), wanted, (ok) => answer({ decision: ok ? "accept" : "decline" }));
      }
      case "item/permissions/requestApproval": {
        const q = p as PermissionsRequestApprovalParams;
        const t = { name: "permissions", kind: "other" as const, input: { permissions: q.permissions, cwd: q.cwd, ...(q.reason ? { reason: q.reason } : {}) }, title: q.reason ?? "More permissions" };
        return this.#permit(run, id, this.#query(t, q.itemId, q.reason, parentId), wanted, (ok) =>
          answer({ permissions: ok ? q.permissions : {}, scope: "turn" }),
        );
      }
      case "mcpServer/elicitation/request":
        return this.#elicitation(run, id, p, wanted, answer, parentId);
      case "item/tool/requestUserInput":
        return this.#userInput(run, id, p as ToolRequestUserInputParams, answer, parentId);
      case "item/tool/call":
        return this.#dynamicTool(run, id, p as DynamicToolCallParams, wanted, answer, parentId);
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
  #permit(run: Run, requestId: RequestId | undefined, q: PermissionQuery, wanted: () => boolean, done: (ok: boolean, message: string) => void): void {
    const ctx = this.#ctx;
    const call = q.toolCallId;
    const denied = () => call && ctx.updateItem(call, { status: "denied" });
    const apply = (d: PermissionDecision) => {
      // A policy that took a while may answer after Codex stopped asking.
      if (!wanted()) return;
      if (d === "allow") return done(true, "");
      if (d === "ask") {
        const id = ctx.ask(
          { type: "permission", name: q.name, kind: q.kind, input: q.input, ...(q.title ? { title: q.title } : {}), ...(q.reason ? { reason: q.reason } : {}) },
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
    const d = ctx.decide(q);
    if (d instanceof Promise) void d.then(apply);
    else apply(d);
  }

  /** An MCP server asking: Codex asks this way whether a tool on it may be called. */
  #elicitation(run: Run, id: RequestId, p: any, wanted: () => boolean, answer: (r: McpServerElicitationRequestResponse) => void, parentId: string | undefined): void {
    const server: string = p.serverName ?? "";
    const fields = Object.keys(p.requestedSchema?.properties ?? {}).length;
    // Only an elicitation that needs nothing filled in ("may it call this tool?") can be answered.
    if (p.mode !== "form" || fields > 0) return answer({ action: "decline" });
    // The app's own tools are decided on when they're called.
    if (server === APP_SERVER && run.mcpApp) return answer({ action: "accept", content: {} });
    const call = run.mcpCalls.findLast((c) => c.server === server);
    const it = call ? (this.#ctx.item(call.id) as ToolCall | undefined) : undefined;
    const message: string = p.message ?? "";
    const name = it?.name ?? /tool "([^"]+)"/.exec(message)?.[1] ?? "elicitation";
    const t = { name, kind: "mcp" as const, server, input: it?.input ?? p._meta?.tool_params ?? {}, ...(it ? {} : { title: message }) };
    this.#permit(run, id, this.#query(t, it?.id, undefined, parentId), wanted, (ok) => answer(ok ? { action: "accept", content: {} } : { action: "decline" }));
  }

  /** A question for the user: a request_user_input call, and a question request for it. */
  #userInput(run: Run, id: RequestId, p: ToolRequestUserInputParams, answer: (r: ToolRequestUserInputResponse) => void, parentId: string | undefined): void {
    const ctx = this.#ctx;
    const qs = questions(p.questions ?? []);
    if (!ctx.item(p.itemId)) {
      ctx.addItem({ id: p.itemId, type: "tool_call", name: "request_user_input", kind: "other", input: { questions: p.questions }, status: "pending", ...(parentId ? { parent_id: parentId } : {}) });
    }
    if (!qs.length) {
      answer({ answers: {} });
      return void ctx.updateItem(p.itemId, { status: "completed", result: { content: "" } });
    }
    const rid = ctx.ask({ type: "question", questions: qs as [(typeof qs)[0], ...typeof qs] }, p.itemId, (res: Resolution) => {
      if (res.outcome !== "answer") {
        answer({ answers: {} });
        return void ctx.updateItem(p.itemId, { status: "denied" });
      }
      const answers: ToolRequestUserInputResponse["answers"] = {};
      const lines: string[] = [];
      for (const [q, a] of Object.entries(res.answers ?? {})) {
        answers[q] = { answers: a ?? [] };
        lines.push(`${q}: ${(a ?? []).join(", ")}`);
      }
      answer({ answers });
      ctx.updateItem(p.itemId, { status: "completed", result: { content: lines.join("\n") } });
    });
    run.asked.set(id, rid);
  }

  /** item/tool/call: one of the app's tools, given as a dynamic tool. */
  #dynamicTool(run: Run, id: RequestId, p: DynamicToolCallParams, wanted: () => boolean, answer: (r: DynamicToolCallResponse) => void, parentId: string | undefined): void {
    const reply = (text: string, ok: boolean) => answer({ contentItems: [{ type: "inputText", text }], success: ok });
    const tool = this.#ctx.config.tools.find((t) => t.name === p.tool);
    if (!tool) return reply(`There's no tool ${p.tool}.`, false);
    const t = { name: p.tool, kind: "app" as const, input: p.arguments ?? {}, title: p.tool };
    this.#permit(run, id, this.#query(t, p.callId, undefined, parentId), wanted, (ok, message) => {
      if (!ok) return reply(message, false);
      void this.#runApp(run, p.tool, p.arguments ?? {}, p.callId).then((out) => reply(out.text, !out.isError));
    });
  }

  /** tools/call on the loopback MCP server: one of the app's tools. */
  #mcpAppTool(run: Run, name: string, args: unknown): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    const ctx = this.#ctx;
    if (!ctx.config.tools.some((t) => t.name === name)) return Promise.resolve({ text: `There's no tool ${name}.`, isError: true });
    const call = run.mcpCalls.find((c) => c.server === APP_SERVER && c.name === name);
    const it = call ? ctx.item(call.id) : undefined;
    const turn = ctx.turnId;
    const wanted = () => !run.exited && !run.retired && this.#run === run && ctx.turnId === turn;
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
    });
  }
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

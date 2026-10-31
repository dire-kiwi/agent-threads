// The Claude Code driver: runs `claude -p` in stream-json mode, one process per thread (started at
// its first message, kept between turns), and translates what it says into the thread's events by
// the rules in spec/fixtures/README.md. Permissions come in as `can_use_tool` control requests, the
// app's tools are an in-process MCP server answered over `mcp_message`, and steered messages go in
// over stdin and join the turn when Claude echoes them back.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Resolution } from "@dire-kiwi/agent-threads-protocol";
import type { Harness, HarnessSession, Message, Skill, ThreadContext } from "../harness.js";
import { newId } from "../ids.js";
import { permissionKey, type PermissionDecision } from "../permissions.js";
import type { ExitStatus, HarnessProcess } from "../spawner.js";
import { runTool } from "../tools.js";
import { APP_SERVER, claudePermissionMode, claudeTool, claudeUsage, editChange, questions, resultText, slim, title } from "./translate.js";

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

/** One `claude` process, and what's needed to read it. */
class Run {
  readonly id = newId("run");
  proc: HarnessProcess | undefined;
  /** Claude answered `initialize`, so messages can go in. */
  ready = false;
  waiting: string[] = [];
  /** Our control requests, by id. */
  pending = new Map<string, (response: Json | null) => void>();
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
  open = new Map<string, string | undefined>();
  /** The messages sent, oldest first, by what Claude echoes when it takes one in. */
  sent: { id: string; echo: string }[] = [];
  /** The generated plugin with the thread's skills, for this run only. */
  pluginDir: string | undefined;

  constructor() {
    this.done = new Promise((r) => (this.finish = r));
  }

  write(msg: Json): void {
    if (!this.exited) this.proc?.write(JSON.stringify(msg));
  }

  /** Writes a user message (that's the item `id`), once Claude is ready for one. */
  send(id: string, msg: Json): void {
    this.sent.push({ id, echo: echoKey(msg.message.content) });
    if (this.ready) this.write(msg);
    else this.waiting.push(JSON.stringify(msg));
  }

  control(request: Json): Promise<Json | null> {
    const request_id = `req_${this.#nextRequest++}`;
    const p = new Promise<Json | null>((r) => this.pending.set(request_id, r));
    this.write({ type: "control_request", request_id, request });
    return p;
  }

  respond(request_id: string, response: Json): void {
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
  /** A run being stopped, which the next must wait for. */
  #stopping: Promise<void> | null = null;
  /** The options changed since the run started: the next turn starts a new one. */
  #stale = false;
  #steerTimer: NodeJS.Timeout | undefined;
  #stopTimer: NodeJS.Timeout | undefined;
  /** A directory for the thread's generated files (skills, attached files), made when needed. */
  #tmp: string | undefined;
  #closed = false;

  constructor(ctx: ThreadContext, options: ClaudeCodeOptions) {
    this.#ctx = ctx;
    this.#o = options;
  }

  // ---------- the core's side ----------

  start(messages: Message[]): void {
    const run = this.#ensure(true);
    for (const m of messages) run.send(m.id, this.#userMessage(m));
  }

  steer(message: Message): void {
    this.#ensure(false).send(message.id, this.#userMessage(message));
  }

  carryOver(messages: Message[]): void {
    const run = this.#live();
    if (!run) {
      this.start(messages);
      return;
    }
    // Claude has them on its stdin, and takes them in once it's ready, which starts the next turn.
    // If it doesn't, they go to a new process.
    clearTimeout(this.#steerTimer);
    this.#steerTimer = setTimeout(() => this.#requeue(run), this.#o.steerGraceMs ?? 30_000);
    this.#steerTimer.unref?.();
  }

  interrupt(): void {
    const run = this.#live();
    if (!run) return;
    void run.control({ subtype: "interrupt" });
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

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#steerTimer);
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

  /**
   * A message as Claude takes it. Images with data go as images; files with textual data as their
   * text; other files with data are written out, and Claude is told where (as for files with a path).
   */
  #userMessage(m: Message): Json {
    const content: Json[] = [{ type: "text", text: m.text }];
    for (const [i, a] of (m.attachments ?? []).entries()) {
      const name = a.name ?? a.path ?? `attachment-${i + 1}`;
      if (a.data !== undefined) {
        if (a.kind === "image") {
          content.push({ type: "image", source: { type: "base64", media_type: a.media_type ?? "image/png", data: a.data } });
          continue;
        }
        const bytes = Buffer.from(a.data, "base64");
        if (a.media_type && TEXTUAL.test(a.media_type)) {
          content.push({ type: "text", text: `Attached file ${name}:\n${bytes.toString("utf8")}` });
          continue;
        }
        const dir = join(this.#dir(), "attachments", m.id);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${i + 1}-${basename(name).replace(/[^\w.-]+/g, "_")}`);
        writeFileSync(path, bytes);
        content.push({ type: "text", text: `Attached file ${name}${a.media_type ? ` (${a.media_type})` : ""}: ${path}` });
      } else if (a.path) {
        content.push({ type: "text", text: `Attached file: ${a.path}` });
      }
    }
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
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

  /** Stops a run: closes its input, then signals it if it doesn't exit. */
  #stop(run: Run, retire: boolean): Promise<void> {
    if (retire) run.retired = true;
    if (run.exited) return run.done;
    run.proc?.closeInput();
    const grace = this.#o.closeGraceMs ?? 5_000;
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

  /** Claude didn't take in steered messages after its turn: they go to a new process. */
  #requeue(run: Run): void {
    if (this.#run !== run || run.exited || !this.#ctx.queued().length) return;
    void this.#stop(run, true);
    const next = this.#ensure(false);
    for (const m of this.#ctx.queued()) next.send(m.id, this.#userMessage({ id: m.id, text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) }));
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
    let proc: HarnessProcess;
    try {
      proc = ctx.spawner.spawn(
        {
          command: o.bin ?? "claude",
          args: [...(o.binArgs ?? []), ...this.#args(run)],
          ...(thread.cwd ? { cwd: thread.cwd } : {}),
          env: { ...process.env, ...o.env, ...(o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {}) },
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
      return;
    }
    run.proc = proc;
    ctx.setThread({ run: { id: run.id, spawner: ctx.spawner.name, started_at: new Date().toISOString() } });
    void run.control({ subtype: "initialize", ...(tools.length ? { sdkMcpServers: [APP_SERVER] } : {}) }).then((r) => {
      if (run.exited) return;
      if (!r) {
        // It refused: messages can't go in, so stop it, which ends the turn.
        run.stderr.push("Claude Code refused the initialize request.");
        void this.#stop(run, false);
        return;
      }
      run.ready = true;
      for (const line of run.waiting.splice(0)) proc.write(line);
    });
  }

  #args(run: Run): string[] {
    const ctx = this.#ctx;
    const t = ctx.thread;
    const { tools, mcpServers, skills, systemPrompt } = ctx.config;
    const o = this.#o;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--input-format", "stream-json"];
    args.push("--replay-user-messages", "--permission-prompt-tool", "stdio");
    if (!o.userSettings) args.push("--setting-sources", "", "--strict-mcp-config");
    args.push("--forward-subagent-text");
    if (t.model) args.push("--model", t.model);
    if (t.effort) args.push("--effort", t.effort);
    const mode = claudePermissionMode(t.permission_mode);
    if (mode) args.push("--permission-mode", mode);
    if (t.session_id) args.push("--resume", t.session_id);
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
    args.push(...(o.args ?? []));
    return args;
  }

  #exited(run: Run, status: ExitStatus): void {
    if (run.exited) return;
    run.exited = true;
    run.abort.abort();
    if (run.pluginDir) rmSync(run.pluginDir, { recursive: true, force: true });
    for (const resolve of run.pending.values()) resolve(null);
    run.pending.clear();
    const ctx = this.#ctx;
    if (this.#run === run) this.#run = null;
    if (ctx.thread.run?.id === run.id) ctx.setThread({ run: undefined });
    // A run that ends while its turn is running ends the turn (as interrupted, if it was).
    if (!run.retired && ctx.turnId) {
      clearTimeout(this.#stopTimer);
      clearTimeout(this.#steerTimer);
      ctx.endTurn({ ok: false, error: exitError(status, run.stderr) });
    }
    run.finish();
  }

  // ---------- what Claude says ----------

  #line(run: Run, line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return; // Not a message: Claude Code doesn't write anything else to stdout, but be safe.
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "control_response") {
      // Claude echoes our own responses back too; those aren't for a request of ours.
      const r = m.response ?? {};
      const resolve = run.pending.get(r.request_id);
      if (resolve) {
        run.pending.delete(r.request_id);
        resolve(r.subtype === "error" ? null : (r.response ?? {}));
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
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && m.session_id && m.session_id !== ctx.thread.session_id) ctx.setThread({ session_id: m.session_id });
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
        // The turn's requests are moot now; its open questions are cancelled with it.
        run.open.clear();
        if (!ctx.turnId) break;
        clearTimeout(this.#stopTimer);
        const failed = !!m.is_error;
        ctx.endTurn({
          ok: !failed,
          ...(failed ? { error: m.result || (Array.isArray(m.errors) ? m.errors.join("\n") : "") || m.subtype } : {}),
          usage: claudeUsage(m),
          ...(typeof m.duration_ms === "number" ? { duration_ms: m.duration_ms } : {}),
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
      if (at >= 0) ctx.tookIn(run.sent.splice(at, 1)[0]!.id);
      if (this.#steerTimer && !ctx.queued().length) clearTimeout(this.#steerTimer);
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
      ctx.updateItem(it.id, patch);
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

  #canUseTool(run: Run, requestId: string, req: Json): void {
    const ctx = this.#ctx;
    const toolUseId: string | undefined = req.tool_use_id;
    const input = req.input ?? {};
    const turn = ctx.turnId;
    run.open.set(requestId, turn);
    // Whether Claude still wants this answered: not cancelled, its turn not over, its run not gone.
    const wanted = () => run.open.has(requestId) && !run.exited && !run.retired && this.#run === run && ctx.turnId === turn;
    const allow = (updatedInput: unknown) => wanted() && run.respond(requestId, { behavior: "allow", updatedInput });
    const deny = (message: string) => wanted() && run.respond(requestId, { behavior: "deny", message });
    const denied = () => toolUseId && ctx.updateItem(toolUseId, { status: "denied" });

    if (req.tool_name === "AskUserQuestion") {
      const qs = questions(input);
      if (!qs.length) return void allow(input);
      const id = ctx.ask({ type: "question", questions: qs as [(typeof qs)[0], ...typeof qs] }, toolUseId, (res: Resolution) => {
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

    const t = claudeTool(req.tool_name, input);
    const call = toolUseId ? ctx.item(toolUseId) : undefined;
    const query = {
      name: t.name,
      kind: t.kind,
      input,
      title: title(t),
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
        const id = ctx.ask(
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
    const d = ctx.decide(query);
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
        const out = await runTool(tool, msg.params?.arguments ?? {}, {
          threadId: ctx.threadId,
          metadata: ctx.thread.metadata ?? {},
          ...(typeof toolCallId === "string" ? { toolCallId } : {}),
          signal: run.abort.signal,
        });
        return reply({
          result: {
            content: [{ type: "text", text: out.text }],
            ...(out.isError ? { isError: true } : {}),
            ...(out.structured !== undefined ? { structuredContent: out.structured } : {}),
          },
        });
      }
      default:
        return reply({ error: { code: -32601, message: `method ${msg.method} isn't supported` } });
    }
  }
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

/** Media types whose content goes to Claude as text. */
const TEXTUAL = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|x-sh|x-ndjson|csv)\b)|\+(json|xml)\b/;

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
  const root = join(dir, "skills");
  mkdirSync(root, { recursive: true });
  for (const s of skills) {
    if (typeof s === "string") cpSync(resolve(s), join(root, basename(resolve(s))), { recursive: true });
    else {
      mkdirSync(join(root, s.name), { recursive: true });
      writeFileSync(join(root, s.name, "SKILL.md"), s.content);
    }
  }
  return dir;
}

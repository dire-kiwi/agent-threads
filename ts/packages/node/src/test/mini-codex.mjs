#!/usr/bin/env node
// A tiny scriptable `codex app-server` for the driver's tests of what the recorded fixtures don't
// cover. It speaks the app server's JSON-RPC over stdio: initialize, thread/start and
// thread/resume (its sessions are files in $CODEX_HOME/mini-sessions), turn/start, turn/steer,
// turn/interrupt and thread/compact/start. A turn does what each line of its message's text says:
//
//   reply <text>        an agent message, streamed a word at a time
//   reason <text>       a reasoning item with two summary parts, streamed
//   exec <command>      a command, asking item/commandExecution/requestApproval first
//   edit <path>         a file change, asking item/fileChange/requestApproval first
//   perms               item/permissions/requestApproval, then says what it was granted
//   mcp <server> <tool> an MCP tool call, approved by an mcpServer/elicitation/request
//   form                an elicitation with a field to fill in, then says what it got
//   ask                 item/tool/requestUserInput, then says the answers
//   app <tool> <json>   an app tool: a dynamic tool (item/tool/call) if thread/start gave it, or a
//                       call to the `app` MCP server in its config, over HTTP
//   tools               says what tools it has: the session's dynamic tools, and the app MCP server's
//   skills              says which skills it would use (those skills.config doesn't turn off)
//   secret              asks a secret question (isSecret)
//   concurrent <server> <json>  starts MCP calls ({"calls": [[tool, args]...]}) on one server, then
//                       elicits approval for the one at "ask"
//   plan                two turn/plan/updated notifications
//   search <query>      a web search
//   sub <prompt>        spawns a subagent (a child thread), which replies, and waits for it
//   sleep <ms>          waits (or until it's interrupted)
//   slow                waits for an interrupt
//   stubborn            ignores interrupts, and a closed stdin (saying "not stopping"), until it's
//                       signalled
//   warn <text>         a warning notification
//   retry               an error that will be retried
//   fail <text>         an error, and the turn fails
//   crash               writes to stderr and exits with code 3
//
// A steered message is taken in at once (a userMessage item), and the turn says it heard it at its
// end. MINI_CODEX_STEER=never accepts steered messages but never takes them in; =reject refuses
// them. MINI_CODEX_TOOL_DELAY=<ms> waits that long between a dynamic tool's call and asking for
// it to be run. MINI_CODEX_NO_DYNAMIC=1 refuses
// thread/start with dynamicTools. MINI_CODEX_LOG names a file each run appends its argv and
// CODEX_HOME, and every message it's sent, to.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = process.env.MINI_CODEX_LOG;
const steerMode = process.env.MINI_CODEX_STEER ?? "now";
const home = process.env.CODEX_HOME;
const note = (v) => log && appendFileSync(log, JSON.stringify(v) + "\n");
note({ argv: process.argv.slice(2), codexHome: home });

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => out({ method, params });
let nextRequest = 0;
const waiting = new Map(); // our request id -> resolve
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequest++;
    waiting.set(id, resolve);
    out({ id, method, params });
  });
let n = 0;
const uid = (p) => `${p}-${process.pid}-${++n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let thread = null; // { id, totals, params, dynamicTools }
let extraRoots = [];
let turn = null; // { id, interrupted, wake, heard }
let stubborn = false;

const sessions = home && join(home, "mini-sessions");
function save() {
  if (!sessions || !thread) return;
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${thread.id}.json`), JSON.stringify({ totals: thread.totals, dynamicTools: thread.dynamicTools }));
}

/** The skills it finds, as Codex does: the user's, the project's, the extra roots' and a built-in one. */
function skills(cwds) {
  const found = [];
  // Like Codex, it reports paths with their symlinks resolved.
  const scan = (root, scope) => {
    if (!existsSync(root)) return;
    const real = realpathSync(root);
    for (const d of readdirSync(real)) if (existsSync(join(real, d, "SKILL.md"))) found.push({ name: d, path: join(real, d, "SKILL.md"), scope, enabled: true, description: d });
  };
  if (process.env.HOME) scan(join(process.env.HOME, ".agents", "skills"), "user");
  for (const c of cwds) scan(join(c, ".agents", "skills"), "repo");
  for (const r of extraRoots) scan(r, "user");
  found.push({ name: "builtin", path: join(home ?? "/", "skills", ".system", "builtin", "SKILL.md"), scope: "system", enabled: true, description: "built in" });
  return found;
}

/** The app's tools on its MCP server, and a client for it. */
function appServer() {
  const srv = thread.params.config?.mcp_servers?.app;
  if (!srv) return null;
  const post = async (body) => {
    const res = await fetch(srv.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...srv.http_headers }, body: JSON.stringify(body) });
    return res.status === 202 ? null : res.json();
  };
  return post;
}

const texts = (input) => (input ?? []).filter((i) => i.type === "text").map((i) => i.text);

function item(method, it, threadId = thread.id) {
  notify(method, { item: it, threadId, turnId: turn?.id });
}

function message(text, threadId = thread.id) {
  const id = uid("msg");
  item("item/started", { type: "agentMessage", id, text: "" }, threadId);
  const words = text.split(/(?= )/);
  for (const w of words) notify("item/agentMessage/delta", { threadId, turnId: turn?.id, itemId: id, delta: w });
  item("item/completed", { type: "agentMessage", id, text }, threadId);
}

/** Waits `ms` (forever if undefined), or until the turn is interrupted. */
function wait(ms) {
  return new Promise((resolve) => {
    if (turn.interrupted) return resolve();
    turn.wake = resolve;
    if (ms !== undefined) setTimeout(resolve, ms);
  });
}

async function step(line) {
  const [cmd, ...rest] = line.split(" ");
  const arg = rest.join(" ");
  const ids = { threadId: thread.id, turnId: turn.id };
  switch (cmd) {
    case "reply":
      return message(arg);
    case "reason": {
      const id = uid("rs");
      item("item/started", { type: "reasoning", id, summary: [], content: [] });
      notify("item/reasoning/summaryTextDelta", { ...ids, itemId: id, delta: `${arg} one`, summaryIndex: 0 });
      notify("item/reasoning/summaryTextDelta", { ...ids, itemId: id, delta: `${arg} two`, summaryIndex: 1 });
      return item("item/completed", { type: "reasoning", id, summary: [`${arg} one`, `${arg} two`], content: [] });
    }
    case "exec": {
      const id = uid("exec");
      const command = `/bin/bash -lc '${arg}'`;
      const base = { type: "commandExecution", id, command, cwd: process.cwd(), commandActions: [] };
      item("item/started", { ...base, status: "inProgress", aggregatedOutput: null, exitCode: null });
      const r = await request("item/commandExecution/requestApproval", { ...ids, itemId: id, command, cwd: process.cwd() });
      const ok = r.result?.decision === "accept";
      return item("item/completed", { ...base, status: ok ? "completed" : "declined", aggregatedOutput: ok ? `ran ${arg}\n` : null, exitCode: ok ? 0 : null });
    }
    case "edit": {
      const id = uid("patch");
      const base = { type: "fileChange", id, changes: [{ path: arg, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] };
      item("item/started", { ...base, status: "inProgress" });
      const r = await request("item/fileChange/requestApproval", { ...ids, itemId: id, reason: null, grantRoot: null });
      return item("item/completed", { ...base, status: r.result?.decision === "accept" ? "completed" : "declined" });
    }
    case "perms": {
      const r = await request("item/permissions/requestApproval", { ...ids, itemId: uid("perm"), cwd: process.cwd(), reason: "It needs the network.", permissions: { network: { enabled: true } } });
      return message(`granted ${JSON.stringify(r.result?.permissions ?? null)}`);
    }
    case "mcp": {
      const [server, tool] = rest;
      const id = uid("mcp");
      const base = { type: "mcpToolCall", id, server, tool, arguments: { x: 1 } };
      item("item/started", { ...base, status: "inProgress" });
      const r = await request("mcpServer/elicitation/request", {
        ...ids,
        serverName: server,
        mode: "form",
        message: `Allow the ${server} MCP server to run tool "${tool}"?`,
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { x: 1 } },
      });
      if (r.result?.action === "accept") return item("item/completed", { ...base, status: "completed", result: { content: [{ type: "text", text: "mcp ok" }] } });
      return item("item/completed", { ...base, status: "failed", error: { message: "the user rejected it" } });
    }
    case "form": {
      const r = await request("mcpServer/elicitation/request", {
        ...ids,
        serverName: "srv",
        mode: "form",
        message: "What's your name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      });
      return message(`form ${r.result?.action}`);
    }
    case "ask": {
      const r = await request("item/tool/requestUserInput", {
        ...ids,
        itemId: uid("call"),
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Which color?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Red", description: "Choose red." },
              { label: "Blue", description: "Choose blue." },
            ],
          },
        ],
      });
      return message(`answers ${JSON.stringify(r.result?.answers ?? null)}`);
    }
    case "app": {
      const [tool, ...json] = rest;
      const args = JSON.parse(json.join(" ") || "{}");
      if (thread.dynamicTools.some((t) => t.name === tool)) {
        const id = uid("call");
        const base = { type: "dynamicToolCall", id, tool, arguments: args };
        item("item/started", { ...base, status: "inProgress", contentItems: null, success: null });
        // As Codex does, a while later (so the backend has saved the call before it's asked to run it).
        await new Promise((r) => setTimeout(r, Number(process.env.MINI_CODEX_TOOL_DELAY ?? 0)));
        const r = await request("item/tool/call", { ...ids, callId: id, tool, arguments: args });
        item("item/completed", { ...base, status: r.result?.success ? "completed" : "failed", contentItems: r.result?.contentItems, success: r.result?.success });
        return message(`app said ${r.result?.contentItems?.[0]?.text}`);
      }
      const post = appServer();
      if (!post) return message("there are no app tools");
      const id = uid("mcp");
      const base = { type: "mcpToolCall", id, server: "app", tool, arguments: args };
      item("item/started", { ...base, status: "inProgress" });
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mini-codex", version: "0" } } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      note({ mcpTools: list.result.tools.map((t) => t.name) });
      const r = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args } });
      item("item/completed", { ...base, status: r.result?.isError ? "failed" : "completed", result: { content: r.result?.content ?? [] } });
      return message(`app said ${r.result?.content?.[0]?.text}`);
    }
    case "tools": {
      // What the model would be offered: the session's dynamic tools, and the app MCP server's.
      const post = appServer();
      const mcp = post ? (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name) : [];
      return message(`dynamic: ${thread.dynamicTools.map((t) => t.name).join(",")}; mcp: ${mcp.join(",")}`);
    }
    case "skills": {
      const off = new Set((thread.params.config?.skills?.config ?? []).filter((c) => c.enabled === false).map((c) => c.path));
      return message(`skills: ${skills([thread.params.cwd ?? process.cwd()]).filter((sk) => !off.has(sk.path)).map((sk) => sk.name).sort().join(",")}`);
    }
    case "secret": {
      const r = await request("item/tool/requestUserInput", {
        ...ids,
        itemId: uid("call"),
        questions: [{ id: "password", header: "Password", question: "What's the password?", isOther: false, isSecret: true, options: null }],
      });
      note({ secretAnswer: r.result?.answers });
      return message("thanks");
    }
    case "concurrent": {
      // Starts calls on one server, then asks about one of them: {"calls": [[tool, args]...], "ask": i}.
      const [server, ...json] = rest;
      const { calls, ask } = JSON.parse(json.join(" "));
      const started = calls.map(([tool, args]) => {
        const it = { type: "mcpToolCall", id: uid("mcp"), server, tool, arguments: args, status: "inProgress" };
        item("item/started", it);
        return it;
      });
      const [tool, args] = calls[ask];
      const r = await request("mcpServer/elicitation/request", {
        ...ids,
        serverName: server,
        mode: "form",
        message: `Allow the ${server} MCP server to run tool "${tool}"?`,
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: args },
      });
      for (const [i, it] of started.entries()) {
        const ok = i !== ask || r.result?.action === "accept";
        item("item/completed", { ...it, status: ok ? "completed" : "failed", ...(ok ? { result: { content: [{ type: "text", text: "mcp ok" }] } } : { error: { message: "the user rejected it" } }) });
      }
      return message(`asked about ${tool}: ${r.result?.action}`);
    }
    case "plan":
      notify("turn/plan/updated", { ...ids, explanation: "The steps", plan: [{ step: "one", status: "inProgress" }, { step: "two", status: "pending" }] });
      notify("turn/plan/updated", { ...ids, explanation: "The steps", plan: [{ step: "one", status: "completed" }, { step: "two", status: "inProgress" }] });
      return;
    case "search": {
      const id = uid("ws");
      item("item/started", { type: "webSearch", id, query: "", action: null });
      return item("item/completed", { type: "webSearch", id, query: arg, action: { type: "search", query: arg } });
    }
    case "sub": {
      const id = uid("spawn");
      const child = uid("child");
      const base = { type: "collabAgentToolCall", id, tool: "spawnAgent", senderThreadId: thread.id, prompt: arg, agentsStates: {} };
      item("item/started", { ...base, status: "inProgress", receiverThreadIds: [] });
      item("item/completed", { ...base, status: "completed", receiverThreadIds: [child] });
      const childTurn = uid("turn");
      notify("turn/started", { threadId: child, turn: { id: childTurn, status: "inProgress", items: [] } });
      item("item/started", { type: "userMessage", id: uid("um"), content: [{ type: "text", text: arg }] }, child);
      message(`child says ${arg}`, child);
      notify("turn/completed", { threadId: child, turn: { id: childTurn, status: "completed", items: [] } });
      return message("the subagent is done");
    }
    case "sleep":
      return wait(Number(arg));
    case "slow":
      return wait();
    case "stubborn":
      stubborn = true;
      // Running with nothing else to do once its stdin's closed.
      setInterval(() => {}, 60_000);
      return new Promise(() => {});
    case "warn":
      return notify("warning", { threadId: thread.id, message: arg });
    case "retry":
      return notify("error", { ...ids, error: { message: "Reconnecting... 1/5" }, willRetry: true });
    case "fail":
      notify("error", { ...ids, error: { message: arg }, willRetry: false });
      return { status: "failed", error: { message: arg } };
    case "crash":
      process.stderr.write("mini-codex crashed\n");
      process.exit(3);
  }
}

async function runTurn(input, id0 = uid("turn")) {
  turn = { id: id0, interrupted: false, wake: null, heard: [] };
  const id = turn.id;
  notify("turn/started", { threadId: thread.id, turn: { id, status: "inProgress", items: [] } });
  item("item/started", { type: "userMessage", id: uid("um"), content: input });
  let status = "completed";
  let error = null;
  for (const line of texts(input).flatMap((t) => t.split("\n"))) {
    const r = await step(line);
    if (r?.status) ({ status, error } = r);
    if (turn.interrupted) status = "interrupted";
    if (status !== "completed") break;
  }
  if (status === "completed" && turn.heard.length) message(`heard ${turn.heard.join(", ")}`);
  thread.totals.inputTokens += 100;
  thread.totals.cachedInputTokens += 40;
  thread.totals.outputTokens += 10;
  save();
  notify("thread/tokenUsage/updated", { threadId: thread.id, turnId: id, tokenUsage: { total: { ...thread.totals }, last: {} } });
  turn = null;
  notify("turn/completed", { threadId: thread.id, turn: { id, status, error, durationMs: 7, items: [] } });
}

async function compact() {
  turn = { id: uid("turn"), interrupted: false, wake: null, heard: [] };
  const id = turn.id;
  notify("turn/started", { threadId: thread.id, turn: { id, status: "inProgress", items: [] } });
  const cid = uid("compact");
  item("item/started", { type: "contextCompaction", id: cid });
  item("item/completed", { type: "contextCompaction", id: cid });
  turn = null;
  notify("turn/completed", { threadId: thread.id, turn: { id, status: "completed", error: null, durationMs: 3, items: [] } });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    note(m);
    if (m.method === undefined) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
      return;
    }
    const reply = (result) => out({ id: m.id, result });
    const fail = (message) => out({ id: m.id, error: { code: -32600, message } });
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return reply({ codexHome: home, platformFamily: "unix", platformOs: "linux" });
      case "initialized":
        return;
      case "skills/list":
        return reply({ data: (p.cwds ?? []).map((cwd) => ({ cwd, skills: skills([cwd]), errors: [] })) });
      case "skills/extraRoots/set":
        extraRoots = p.extraRoots ?? [];
        note({ skills: (p.extraRoots ?? []).flatMap((r) => readdirSync(r).map((d) => readFileSync(join(r, d, "SKILL.md"), "utf8"))) });
        return reply({});
      case "thread/start":
        if (p.dynamicTools?.length && process.env.MINI_CODEX_NO_DYNAMIC) return fail("dynamicTools isn't supported by this version");
        thread = { id: uid("thread"), totals: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 }, params: p, dynamicTools: p.dynamicTools ?? [] };
        save();
        return reply({ thread: { id: thread.id } });
      case "thread/resume": {
        const file = sessions && join(sessions, `${p.threadId}.json`);
        if (!file || !existsSync(file)) return fail(`no rollout found for thread id ${p.threadId}`);
        // As Codex does, it keeps the dynamic tools the session started with (resuming can't change them).
        const saved = JSON.parse(readFileSync(file, "utf8"));
        thread = { id: p.threadId, totals: saved.totals, params: p, dynamicTools: saved.dynamicTools ?? [] };
        return reply({ thread: { id: thread.id } });
      }
      case "turn/start":
        if (turn) return fail("a turn is already running");
        {
          const id = uid("turn");
          reply({ turn: { id, status: "inProgress", items: [] } });
          return void runTurn(p.input, id).catch((e) => process.stderr.write(`${e.stack}\n`));
        }
      case "turn/steer":
        if (!turn || p.expectedTurnId !== turn.id || steerMode === "reject") return fail("there's no turn to steer");
        reply({ turnId: turn.id });
        if (steerMode === "now") {
          item("item/started", { type: "userMessage", id: uid("um"), content: p.input });
          turn.heard.push(...texts(p.input));
        }
        return;
      case "turn/interrupt":
        reply({});
        if (turn && p.turnId === turn.id && !stubborn) {
          turn.interrupted = true;
          turn.wake?.();
        }
        return;
      case "thread/compact/start":
        reply({});
        return void compact();
      default:
        return fail(`unknown method ${m.method}`);
    }
  })
  .on("close", () => {
    if (!stubborn) process.exit(0);
    message("not stopping");
  });

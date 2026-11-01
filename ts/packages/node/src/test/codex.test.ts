// What the recorded Codex fixtures don't cover, against a scriptable fake `codex app-server`
// (mini-codex.mjs): the thread's options, CODEX_HOME, every kind of approval and question, app
// tools on both paths, plans, searches, subagents, steering, failures, resuming and compaction.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvents, initialState, type Item, type Notice, type ThreadEvent, type ToolCall, type TurnResult, type UserMessage } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads, type AgentThreadsOptions } from "../agent-threads.js";
import { codex, type CodexOptions } from "../codex/driver.js";
import { prepareCodexHome } from "../codex/home.js";
import { serveTools } from "../mcp-http.js";
import { MemoryStore } from "../stores/memory.js";
import type { PermissionQuery } from "../permissions.js";
import { defineTool, type ToolContext } from "../tools.js";
import { tempDir } from "./spec.js";

const mini = fileURLToPath(new URL("./mini-codex.mjs", import.meta.url));

let open: AgentThreads[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

interface Setup extends AgentThreadsOptions {
  codex?: CodexOptions;
  /** More of mini-codex's environment. */
  env?: { [k: string]: string };
}

function setup(options: Setup = {}) {
  const log = join(tempDir(), "log.jsonl");
  const home = tempDir();
  // A home of its own, so the user's own skills don't show up.
  const userHome = tempDir();
  const { codex: o, env, ...rest } = options;
  const events: ThreadEvent[] = [];
  const store = rest.store ?? new MemoryStore();
  const make = () => {
    const sdk = new AgentThreads({
      permissions: "allow",
      ...rest,
      store,
      harnesses: { codex: codex({ bin: mini, env: { MINI_CODEX_LOG: log, HOME: userHome, ...env }, home, login: false, closeGraceMs: 1000, ...o }) },
      onError:
        rest.onError ??
        ((e) => {
          throw e;
        }),
    });
    sdk.subscribe((e) => events.push(e));
    open.push(sdk);
    return sdk;
  };
  /** What each run was started with and sent. */
  const runs = () => {
    if (!existsSync(log)) return [];
    const out: { argv: string[]; codexHome: string; sent: { [k: string]: any }[]; notes: { [k: string]: any }[] }[] = [];
    for (const l of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const v = JSON.parse(l);
      if (v.argv) out.push({ argv: v.argv, codexHome: v.codexHome, sent: [], notes: [] });
      else if ("jsonrpc" in v || "method" in v || "id" in v) out[out.length - 1]!.sent.push(v);
      else out[out.length - 1]!.notes.push(v);
    }
    return out;
  };
  /** The requests a run sent, by method. */
  const sent = (method: string, run = -1) => runs().at(run)?.sent.filter((m) => m.method === method) ?? [];
  return { sdk: make(), make, events, runs, sent, home, userHome, store };
}

async function until<T>(what: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Waits until the thread is idle (or failed), and returns its snapshot. */
async function settle(sdk: AgentThreads, id: string, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await sdk.snapshot(id);
    if ((s.thread.status === "idle" || s.thread.status === "error") && !s.items.some((i) => i.type === "user_message" && i.queued)) return s;
    if (Date.now() > deadline) throw new Error(`thread ${id} is still ${s.thread.status}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Waits for the thread's one open request. */
const request = (sdk: AgentThreads, id: string) => until(async () => (await sdk.snapshot(id)).requests[0]);

const results = (items: Item[]) => items.filter((i): i is TurnResult => i.type === "turn_result");
const texts = (items: Item[]) => items.filter((i) => i.type === "assistant_message").map((i) => (i as { text: string }).text);
const calls = (items: Item[]) => items.filter((i): i is ToolCall => i.type === "tool_call");
/** The driver's answers to the server's requests, in order. */
const answers = (sent: { [k: string]: any }[]) => sent.filter((m) => m.method === undefined && "result" in m).map((m) => m.result);
const notices = (items: Item[]) => items.filter((i): i is Notice => i.type === "notice");

const lookupOrder = (seen: ToolContext[] = []) =>
  defineTool<{ order_id: string }>({
    name: "lookup_order",
    description: "Looks up an order.",
    input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    run: ({ order_id }, ctx) => {
      seen.push(ctx);
      return `Order ${order_id}: 3 blue widgets.`;
    },
  });

describe("the Codex driver", () => {
  it("streams replies and reasoning, sets the session, and counts each turn's usage", async () => {
    const { sdk, events, sent } = setup();
    const t = await sdk.create({ harness: "codex", model: "gpt-test", effort: "low", cwd: tempDir() });
    await sdk.send(t.id, "reply hello there world\nreason thinking");
    let s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(["hello there world"]);
    expect(s.items.find((i) => i.type === "reasoning")).toMatchObject({ text: "thinking one\n\nthinking two" });
    expect(s.thread.session_id).toMatch(/^thread-/);
    // The totals grow by 100 input tokens (40 of them cached) and 10 output tokens a turn.
    expect(results(s.items)[0]).toMatchObject({ ok: true, usage: { input_tokens: 60, cache_read_tokens: 40, output_tokens: 10, cache_write_tokens: 0 }, duration_ms: 7 });

    await sdk.send(t.id, "reply again");
    s = await settle(sdk, t.id);
    expect(results(s.items)[1]).toMatchObject({ usage: { input_tokens: 60, cache_read_tokens: 40, output_tokens: 10 } });
    expect(s.thread.usage).toMatchObject({ input_tokens: 120, cache_read_tokens: 80, output_tokens: 20 });
    // One process, one thread, a turn/start per message, with the thread's effort.
    expect(sent("thread/start")).toHaveLength(1);
    expect(sent("turn/start").map((m) => [m.params.effort, m.params.input[0].text])).toEqual([
      ["low", "reply hello there world\nreason thinking"],
      ["low", "reply again"],
    ]);
    expect(s).toEqual(applyEvents(initialState(t), events));
  });

  it("starts the thread with its options, MCP servers, app tools and system prompt", async () => {
    const { sdk, sent, runs, home } = setup({
      tools: [lookupOrder()],
      systemPrompt: "Be brief.",
      mcpServers: {
        gh: { command: "gh-mcp", args: ["--stdio"], env: { TOKEN: "x" } },
        docs: { url: "https://example.com/mcp", headers: { "X-Key": "k" } },
        old: { type: "sse", url: "https://example.com/sse" },
      },
      codex: { config: { model_reasoning_summary: "auto" } },
    });
    const cwd = tempDir();
    const t = await sdk.create({ harness: "codex", model: "gpt-test", permission_mode: "plan", cwd });
    await sdk.send(t.id, "reply ok");
    const s = await settle(sdk, t.id);
    const run = runs()[0]!;
    expect(run.argv).toEqual(["app-server"]);
    expect(run.codexHome).toBe(home);
    expect(run.sent.slice(0, 4).map((m) => m.method)).toEqual(["initialize", "initialized", "skills/list", "thread/start"]);
    expect(run.sent[0]!.params.capabilities).toEqual({ experimentalApi: true });
    expect(sent("thread/start")[0]!.params).toEqual({
      cwd,
      model: "gpt-test",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      developerInstructions: "Be brief.",
      config: {
        model_reasoning_summary: "auto",
        "features.default_mode_request_user_input": true,
        suppress_unstable_features_warning: true,
        mcp_servers: {
          gh: { command: "gh-mcp", args: ["--stdio"], env: { TOKEN: "x" } },
          docs: { url: "https://example.com/mcp", http_headers: { "X-Key": "k" } },
        },
      },
      dynamicTools: [{ type: "function", name: "lookup_order", description: "Looks up an order.", inputSchema: lookupOrder().input }],
    });
    expect(notices(s.items).map((n) => n.text)).toEqual(["The MCP server old isn't available: Codex doesn't support SSE MCP servers."]);
  });

  it("runs permission modes as Codex's approval policies and sandboxes", async () => {
    const { sdk, sent } = setup();
    const modes = { default: ["untrusted", "workspace-write"], accept_edits: ["on-request", "workspace-write"], bypass: ["never", "danger-full-access"] } as const;
    for (const [mode, [approvalPolicy, sandbox]] of Object.entries(modes)) {
      const t = await sdk.create({ harness: "codex", permission_mode: mode as keyof typeof modes, cwd: tempDir() });
      await sdk.send(t.id, "reply ok");
      await settle(sdk, t.id);
      expect(sent("thread/start")[0]!.params).toMatchObject({ approvalPolicy, sandbox });
    }
  });

  it("asks the policy about commands and file changes, and the user when it says ask", async () => {
    const asked: unknown[] = [];
    const { sdk, runs } = setup({
      permissions: (q) => {
        asked.push(q);
        return "ask";
      },
    });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "exec touch a.txt\nedit /w/notes.txt\nreply done");
    let r = await request(sdk, t.id);
    expect(r).toMatchObject({ type: "permission", name: "commandExecution", kind: "shell", title: "touch a.txt", input: { command: "/bin/bash -lc 'touch a.txt'" } });
    let s = await sdk.snapshot(t.id);
    expect(s.thread.status).toBe("waiting");
    expect(calls(s.items)[0]).toMatchObject({ id: r.tool_call_id, status: "pending", command: "touch a.txt" });
    await sdk.respond(t.id, r.id, { outcome: "allow" });

    r = await until(async () => (await sdk.snapshot(t.id)).requests.find((x) => x.id !== r.id));
    expect(r).toMatchObject({ type: "permission", name: "fileChange", kind: "edit", title: "/w/notes.txt" });
    await sdk.respond(t.id, r.id, { outcome: "deny", message: "no edits" });
    s = await settle(sdk, t.id);
    const [cmd, edit] = calls(s.items);
    expect(cmd).toMatchObject({ status: "completed", result: { content: "ran touch a.txt\n", exit_code: 0 } });
    expect(edit).toMatchObject({ status: "denied", changes: [{ path: "/w/notes.txt", op: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }] });
    expect(texts(s.items)).toEqual(["done"]);
    expect(asked).toMatchObject([
      { name: "commandExecution", kind: "shell", toolCallId: cmd!.id },
      { name: "fileChange", kind: "edit", toolCallId: edit!.id },
    ]);
    // Codex is told accept and decline.
    expect(answers(runs()[0]!.sent)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
  });

  it("keeps an answer given always for the rest of the thread", async () => {
    let asks = 0;
    const { sdk } = setup({ permissions: () => (asks++, "ask") });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "exec one");
    const r = await request(sdk, t.id);
    await sdk.respond(t.id, r.id, { outcome: "allow", always: true });
    await settle(sdk, t.id);
    await sdk.send(t.id, "exec two");
    const s = await settle(sdk, t.id);
    expect(asks).toBe(1);
    expect(calls(s.items).map((c) => c.status)).toEqual(["completed", "completed"]);
  });

  it("asks about more permissions, and grants them only when allowed", async () => {
    const { sdk } = setup({ permissions: "ask" });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "perms");
    let r = await request(sdk, t.id);
    expect(r).toMatchObject({ type: "permission", name: "permissions", kind: "other", title: "It needs the network.", reason: "It needs the network.", input: { permissions: { network: { enabled: true } } } });
    await sdk.respond(t.id, r.id, { outcome: "allow" });
    let s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(['granted {"network":{"enabled":true}}']);

    await sdk.send(t.id, "perms");
    r = await until(async () => (await sdk.snapshot(t.id)).requests[0]);
    await sdk.respond(t.id, r.id, { outcome: "deny" });
    s = await settle(sdk, t.id);
    expect(texts(s.items)[1]).toBe("granted {}");
  });

  it("asks the policy about MCP tools when Codex elicits approval, and declines forms it can't fill in", async () => {
    const asked: unknown[] = [];
    const { sdk } = setup({
      permissions: (q) => {
        asked.push(q);
        return q.name === "ok" ? "allow" : { deny: "not that one" };
      },
    });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "mcp srv ok\nmcp srv nope\nform");
    const s = await settle(sdk, t.id);
    const [ok, nope] = calls(s.items);
    expect(ok).toMatchObject({ name: "ok", kind: "mcp", server: "srv", input: { x: 1 }, status: "completed", result: { content: "mcp ok" } });
    expect(nope).toMatchObject({ name: "nope", status: "denied", result: { content: "the user rejected it" } });
    expect(asked).toMatchObject([
      { name: "ok", kind: "mcp", server: "srv", toolCallId: ok!.id },
      { name: "nope", kind: "mcp", server: "srv", toolCallId: nope!.id },
    ]);
    expect(texts(s.items)).toEqual(["form decline"]);
  });

  it("asks the user Codex's questions, as a request_user_input call", async () => {
    const { sdk } = setup({ permissions: "deny" }); // questions are always the user's
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "ask");
    const r = await request(sdk, t.id);
    expect(r).toMatchObject({
      type: "question",
      questions: [{ id: "color", question: "Which color?", header: "Color", options: [{ label: "Red", description: "Choose red." }, { label: "Blue", description: "Choose blue." }], allow_other: true }],
    });
    let s = await sdk.snapshot(t.id);
    expect(calls(s.items)[0]).toMatchObject({ id: r.tool_call_id, name: "request_user_input", kind: "other", status: "pending" });
    await sdk.respond(t.id, r.id, { outcome: "answer", answers: { color: ["Blue"] } });
    s = await settle(sdk, t.id);
    expect(calls(s.items)[0]).toMatchObject({ status: "completed", result: { content: "color: Blue" } });
    expect(texts(s.items)).toEqual(['answers {"color":{"answers":["Blue"]}}']);
  });

  it("runs app tools given as dynamic tools, through the policy", async () => {
    const seen: ToolContext[] = [];
    const asked: unknown[] = [];
    const { sdk } = setup({
      tools: [lookupOrder(seen)],
      permissions: (q) => {
        asked.push(q);
        return "ask";
      },
    });
    const t = await sdk.create({ harness: "codex", cwd: tempDir(), metadata: { user: "u1" } });
    await sdk.send(t.id, 'app lookup_order {"order_id":"42"}');
    const r = await request(sdk, t.id);
    expect(r).toMatchObject({ type: "permission", name: "lookup_order", kind: "app", input: { order_id: "42" } });
    await sdk.respond(t.id, r.id, { outcome: "allow" });
    const s = await settle(sdk, t.id);
    const call = calls(s.items)[0]!;
    expect(call).toMatchObject({ name: "lookup_order", kind: "app", status: "completed", result: { content: "Order 42: 3 blue widgets." } });
    expect(seen).toMatchObject([{ threadId: t.id, metadata: { user: "u1" }, toolCallId: call.id }]);
    expect(texts(s.items)).toEqual(["app said Order 42: 3 blue widgets."]);
  });

  it("serves app tools on a loopback MCP server when Codex refuses dynamic tools", async () => {
    const seen: ToolContext[] = [];
    const { sdk, sent, runs } = setup({ tools: [lookupOrder(seen)], env: { MINI_CODEX_NO_DYNAMIC: "1" } });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, 'app lookup_order {"order_id":"7"}');
    const s = await settle(sdk, t.id);
    const [first, second] = sent("thread/start");
    expect(first!.params.dynamicTools).toHaveLength(1);
    expect(second!.params.dynamicTools).toBeUndefined();
    const app = second!.params.config.mcp_servers.app;
    expect(app).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), http_headers: { Authorization: expect.stringMatching(/^Bearer .{20,}/) }, default_tools_approval_mode: "approve" });
    expect(runs()[0]!.notes).toContainEqual({ mcpTools: ["lookup_order"] });
    const call = calls(s.items)[0]!;
    expect(call).toMatchObject({ name: "lookup_order", kind: "app", status: "completed", result: { content: "Order 7: 3 blue widgets." } });
    expect(call.server).toBeUndefined();
    expect(seen[0]).toMatchObject({ toolCallId: call.id });
    expect(texts(s.items)).toEqual(["app said Order 7: 3 blue widgets."]);
    // The server goes with the process.
    await sdk.close();
    await expect(fetch(app.url, { method: "POST", headers: app.http_headers, body: "{}" })).rejects.toThrow();
  });

  it("uses the loopback MCP server when asked to, and applies the policy to its tools", async () => {
    const { sdk, sent } = setup({ tools: [lookupOrder()], permissions: (q) => (q.kind === "app" ? { deny: "no orders" } : "allow"), codex: { appTools: "mcp" } });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, 'app lookup_order {"order_id":"7"}');
    const s = await settle(sdk, t.id);
    expect(sent("thread/start")).toHaveLength(1);
    expect(calls(s.items)[0]).toMatchObject({ kind: "app", status: "denied" });
    expect(texts(s.items)).toEqual(["app said no orders"]);
  });

  it("shows plan updates as one todo call per turn, and web searches", async () => {
    const { sdk } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "plan\nsearch agent threads");
    const s = await settle(sdk, t.id);
    const [plan, search] = calls(s.items);
    expect(plan).toMatchObject({
      name: "update_plan",
      kind: "todo",
      status: "completed",
      todos: [
        { text: "one", status: "completed" },
        { text: "two", status: "in_progress" },
      ],
    });
    expect(search).toMatchObject({ name: "webSearch", kind: "web", status: "completed", query: "agent threads" });
  });

  it("shows a subagent's child thread under its spawnAgent call", async () => {
    const { sdk } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "sub read the notes");
    const s = await settle(sdk, t.id);
    const call = calls(s.items)[0]!;
    expect(call).toMatchObject({ name: "spawnAgent", kind: "subagent", title: "read the notes", status: "completed", result: { content: "child says read the notes" } });
    const child = s.items.filter((i) => i.parent_id === call.id);
    expect(child.map((i) => [i.type, (i as { text?: string }).text])).toEqual([["assistant_message", "child says read the notes"]]);
    expect(texts(s.items.filter((i) => !i.parent_id))).toEqual(["the subagent is done"]);
  });

  it("steers a running turn with turn/steer, and the message joins it when Codex takes it in", async () => {
    const { sdk, sent } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "sleep 300");
    await until(() => sent("turn/start").length);
    await sdk.send(t.id, "also this");
    const s = await settle(sdk, t.id);
    const steer = sent("turn/steer")[0]!;
    expect(steer.params).toMatchObject({ threadId: s.thread.session_id, input: [{ type: "text", text: "also this" }] });
    expect(steer.params.expectedTurnId).toMatch(/^turn-/);
    const m = s.items.find((i): i is UserMessage => i.type === "user_message" && i.text === "also this")!;
    expect(m).toMatchObject({ steered: true });
    expect(m.queued).toBeUndefined();
    expect(results(s.items)).toHaveLength(1);
    expect(texts(s.items)).toEqual(["heard also this"]);
  });

  it("carries a message Codex refused to steer with over to the next turn", async () => {
    const { sdk, sent } = setup({ env: { MINI_CODEX_STEER: "reject" } });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "sleep 200");
    await until(() => sent("turn/start").length);
    await sdk.send(t.id, "reply carried");
    const s = await settle(sdk, t.id);
    expect(sent("turn/start").map((m) => m.params.input[0].text)).toEqual(["sleep 200", "reply carried"]);
    expect(results(s.items)).toHaveLength(2);
    expect(texts(s.items)).toEqual(["carried"]);
    expect(s.thread.status).toBe("idle");
  });

  it("carries a steered message Codex accepted but didn't take in over to the next turn", async () => {
    const { sdk, sent } = setup({ env: { MINI_CODEX_STEER: "never" } });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "sleep 100");
    await until(() => sent("turn/start").length);
    await sdk.send(t.id, "reply later");
    const s = await settle(sdk, t.id);
    expect(sent("turn/steer")).toHaveLength(1);
    expect(sent("turn/start").map((m) => m.params.input[0].text)).toEqual(["sleep 100", "reply later"]);
    expect(texts(s.items)).toEqual(["later"]);
    const m = s.items.find((i): i is UserMessage => i.type === "user_message" && i.text === "reply later")!;
    expect(m.queued).toBeUndefined();
    expect(results(s.items).map((r) => r.ok)).toEqual([true, true]);
  });

  it("interrupts with turn/interrupt", async () => {
    const { sdk, sent } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "exec sleep 100\nslow");
    await until(async () => calls((await sdk.snapshot(t.id)).items)[0]?.status === "completed");
    await sdk.interrupt(t.id);
    const s = await settle(sdk, t.id);
    expect(sent("turn/interrupt")[0]!.params).toMatchObject({ threadId: s.thread.session_id, turnId: expect.stringMatching(/^turn-/) });
    expect(results(s.items)[0]).toMatchObject({ ok: false, interrupted: true });
    expect(s.thread.status).toBe("idle");
  });

  it("reports warnings and retries as notices, and a failed turn's error", async () => {
    const { sdk } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "warn careful\nretry\nfail it broke");
    const s = await settle(sdk, t.id);
    expect(notices(s.items).map((n) => [n.level, n.code, n.text])).toEqual([
      ["warning", undefined, "careful"],
      ["warning", "retry", "Reconnecting... 1/5"],
    ]);
    expect(results(s.items)[0]).toMatchObject({ ok: false, error: "it broke" });
    expect(s.thread).toMatchObject({ status: "error", error: "it broke" });
  });

  it("ends the turn when Codex crashes, and resumes the session in a new process", async () => {
    const { sdk, sent, runs } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply first");
    await settle(sdk, t.id);
    await sdk.send(t.id, "crash");
    let s = await settle(sdk, t.id);
    expect(results(s.items)[1]!.error).toMatch(/Codex exited with code 3 during the turn\.\nmini-codex crashed/);
    expect(s.thread.run).toBeUndefined();
    const session = s.thread.session_id;
    await sdk.send(t.id, "reply back");
    s = await settle(sdk, t.id);
    expect(runs()).toHaveLength(2);
    expect(sent("thread/resume")[0]!.params).toMatchObject({ threadId: session, excludeTurns: true });
    expect(s.thread.session_id).toBe(session);
    expect(texts(s.items)).toEqual(["first", "back"]);
  });

  it("resumes after a restart, and starts a new session (with a notice) when the old one is gone", async () => {
    const { sdk, make, sent, home } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply one");
    let s = await settle(sdk, t.id);
    const session = s.thread.session_id!;
    await sdk.close();

    let next = make();
    await next.send(t.id, "reply two");
    s = await settle(next, t.id);
    expect(sent("thread/resume")[0]!.params.threadId).toBe(session);
    // Codex's totals carry on from the session's, and only the turn's are counted.
    expect(results(s.items)[1]!.usage).toMatchObject({ input_tokens: 60, output_tokens: 10 });
    await next.close();

    rmSync(join(home, "mini-sessions"), { recursive: true });
    next = make();
    await next.send(t.id, "reply three");
    s = await settle(next, t.id);
    expect(sent("thread/start")).toHaveLength(1);
    expect(s.thread.session_id).not.toBe(session);
    expect(notices(s.items)[0]!.text).toMatch(/^Codex couldn't resume its session \(no rollout found for thread id .*\), so this is a new one/);
    expect(texts(s.items)).toEqual(["one", "two", "three"]);
  });

  it("sends /compact as thread/compact/start", async () => {
    const { sdk, sent } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply hi");
    await settle(sdk, t.id);
    await sdk.send(t.id, "/compact");
    const s = await settle(sdk, t.id);
    expect(sent("thread/compact/start")[0]!.params).toEqual({ threadId: s.thread.session_id });
    expect(sent("turn/start")).toHaveLength(1);
    expect(s.items.filter((i) => i.type === "compaction")).toMatchObject([{ type: "compaction", trigger: "manual" }]);
    expect(results(s.items).map((r) => r.ok)).toEqual([true, true]);
  });

  it("starts a new process, resuming the session, when the options change", async () => {
    const { sdk, sent, runs } = setup();
    const t = await sdk.create({ harness: "codex", model: "a", cwd: tempDir() });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    await sdk.setOptions(t.id, { model: "b", permission_mode: "bypass" });
    await sdk.send(t.id, "reply two");
    await settle(sdk, t.id);
    expect(runs()).toHaveLength(2);
    expect(sent("thread/resume")[0]!.params).toMatchObject({ model: "b", approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  it("turns off the user's and the project's skills, keeping the app's and Codex's own", async () => {
    const skill = (root: string, name: string) => {
      mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
      writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      return join(root, ".agents", "skills", name, "SKILL.md");
    };
    const { sdk, sent, userHome } = setup({ skills: [{ name: "app-skill", content: "---\nname: app-skill\n---\n" }] });
    const cwd = tempDir();
    const user = skill(userHome, "user-sentinel");
    const repo = skill(cwd, "repo-sentinel");
    const t = await sdk.create({ harness: "codex", cwd });
    await sdk.send(t.id, "skills");
    const s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(["skills: app-skill,builtin"]);
    expect(sent("skills/list")[0]!.params).toEqual({ cwds: [cwd], forceReload: true });
    expect(sent("thread/start")[0]!.params.config.skills).toEqual({ config: [{ path: user, enabled: false }, { path: repo, enabled: false }] });
  });

  it("leaves the user's skills on with userConfig", async () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir();
    try {
      const { sdk, sent, userHome } = setup({ codex: { userConfig: true } });
      mkdirSync(join(userHome, ".agents", "skills", "user-sentinel"), { recursive: true });
      writeFileSync(join(userHome, ".agents", "skills", "user-sentinel", "SKILL.md"), "---\nname: user-sentinel\n---\n");
      const t = await sdk.create({ harness: "codex", cwd: tempDir() });
      await sdk.send(t.id, "skills");
      const s = await settle(sdk, t.id);
      expect(texts(s.items)).toEqual(["skills: builtin,user-sentinel"]);
      expect(sent("skills/list")).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });

  it("keeps a secret answer out of what's sent and saved, and gives it only to Codex", async () => {
    const { sdk, runs, store } = setup();
    const published: ThreadEvent[] = [];
    sdk.subscribe((e) => published.push(e));
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "secret");
    const r = await request(sdk, t.id);
    expect(r).toMatchObject({ type: "question", questions: [{ id: "password", secret: true }] });
    await sdk.respond(t.id, r.id, { outcome: "answer", answers: { password: ["hunter2-sentinel"] } });
    const s = await settle(sdk, t.id);
    expect(runs()[0]!.notes).toContainEqual({ secretAnswer: { password: { answers: ["hunter2-sentinel"] } } });
    expect(calls(s.items)[0]).toMatchObject({ status: "completed", result: { content: "password: [secret]" } });
    expect(published.find((e) => e.type === "request.resolved")).toMatchObject({ resolution: { outcome: "answer", answers: { password: ["[secret]"] } } });
    await sdk.close();
    const saved = JSON.stringify(await store.readEvents(t.id, { after: 0 }));
    for (const where of [saved, JSON.stringify(published), JSON.stringify(s)]) expect(where).not.toContain("hunter2-sentinel");
  });

  it("asks the policy about the MCP call an elicitation names, not another one running on the server", async () => {
    const asked: PermissionQuery[] = [];
    const { sdk } = setup({
      permissions: (q) => {
        asked.push(q);
        return q.name === "read_status" ? "allow" : { deny: "only reads" };
      },
    });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    // Two calls on one server, then the approval for the first: the destructive one.
    await sdk.send(t.id, 'concurrent db {"calls": [["delete_all", {"all": true}], ["read_status", {"limit": 1}]], "ask": 0}');
    let s = await settle(sdk, t.id);
    const [del] = calls(s.items);
    expect(asked[0]).toMatchObject({ name: "delete_all", kind: "mcp", server: "db", input: { all: true }, toolCallId: del!.id });
    expect(texts(s.items)).toEqual(["asked about delete_all: decline"]);
    expect(del).toMatchObject({ status: "denied" });

    // The same tool with different arguments: the call whose arguments match.
    await sdk.send(t.id, 'concurrent db {"calls": [["read_status", {"limit": 1}], ["read_status", {"limit": 2}]], "ask": 1}');
    s = await settle(sdk, t.id);
    const second = calls(s.items).filter((c) => c.name === "read_status").at(-1)!;
    expect(asked[1]).toMatchObject({ name: "read_status", input: { limit: 2 }, toolCallId: second.id });

    // Two calls it could be: it's asked about without either.
    await sdk.send(t.id, 'concurrent db {"calls": [["delete_all", {"all": true}], ["delete_all", {"all": true}]], "ask": 1}');
    s = await settle(sdk, t.id);
    expect(asked[2]).toMatchObject({ name: "delete_all", input: { all: true } });
    expect(asked[2]!.toolCallId).toBeUndefined();
    expect(texts(s.items).at(-1)).toBe("asked about delete_all: decline");
  });

  it("gives a resumed session the app's tools as they are now, on the MCP server where its own have changed", async () => {
    const tool = (name: string, description = `The ${name} tool.`) => defineTool({ name, description, input: { type: "object" }, run: () => `${name} ran` });
    const { sdk, sent } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir(), tools: [tool("original_tool"), tool("kept_tool")] });
    await sdk.send(t.id, "tools");
    let s = await settle(sdk, t.id);
    expect(texts(s.items).at(-1)).toBe("dynamic: original_tool,kept_tool; mcp: ");

    // Replaced, kept and changed: Codex keeps the dynamic tools it started with, so the new and
    // changed ones are on the MCP server.
    await sdk.configure(t.id, { tools: [tool("replacement_tool"), tool("kept_tool"), tool("changed_tool")] });
    await sdk.send(t.id, "tools");
    s = await settle(sdk, t.id);
    expect(sent("thread/resume")[0]!.params.dynamicTools).toBeUndefined();
    expect(texts(s.items).at(-1)).toBe("dynamic: original_tool,kept_tool; mcp: replacement_tool,changed_tool");
    await sdk.send(t.id, "app replacement_tool {}\napp kept_tool {}\napp original_tool {}");
    s = await settle(sdk, t.id);
    expect(texts(s.items).slice(-3)).toEqual(["app said replacement_tool ran", "app said kept_tool ran", "app said The tool original_tool isn't available any more. The app's other tools are on its app MCP server: replacement_tool, changed_tool."]);

    await sdk.configure(t.id, { tools: [tool("kept_tool", "Now different.")] });
    await sdk.send(t.id, "tools\napp kept_tool {}");
    s = await settle(sdk, t.id);
    expect(texts(s.items).slice(-2)).toEqual(["dynamic: original_tool,kept_tool; mcp: kept_tool", "app said The tool kept_tool has changed: call it on the app MCP server instead."]);
  });

  it("counts usage from a new session's totals when Codex no longer has the old one", async () => {
    const { sdk, make, home } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    await sdk.send(t.id, "reply two");
    await settle(sdk, t.id);
    await sdk.close();
    rmSync(join(home, "mini-sessions"), { recursive: true });

    let next = make();
    await next.send(t.id, "reply three");
    let s = await settle(next, t.id);
    expect(notices(s.items)).toHaveLength(1);
    const per = { input_tokens: 60, cache_read_tokens: 40, output_tokens: 10, cache_write_tokens: 0 };
    expect(results(s.items).map((r) => r.usage)).toEqual([per, per, per]);

    // And so on, across another restart (resuming the new session) and an options change.
    await next.close();
    next = make();
    await next.send(t.id, "reply four");
    await settle(next, t.id);
    await next.setOptions(t.id, { model: "other" });
    await next.send(t.id, "reply five");
    s = await settle(next, t.id);
    expect(results(s.items).map((r) => r.usage)).toEqual([per, per, per, per, per]);
    expect(s.thread.usage).toEqual({ input_tokens: 300, cache_read_tokens: 200, output_tokens: 50, cache_write_tokens: 0 });
  });

  it("gives Codex the app's skills with skills/extraRoots/set", async () => {
    const dir = join(tempDir(), "from-disk");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: from-disk\n---\nOn disk.\n");
    const { sdk, runs } = setup({ skills: [dir, { name: "inline", content: "---\nname: inline\n---\nInline.\n" }] });
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply ok");
    await settle(sdk, t.id);
    const run = runs()[0]!;
    expect(run.sent.map((m) => m.method).slice(0, 5)).toEqual(["initialize", "initialized", "skills/extraRoots/set", "skills/list", "thread/start"]);
    expect(run.notes.find((n) => n.skills)!.skills.sort()).toEqual(["---\nname: from-disk\n---\nOn disk.\n", "---\nname: inline\n---\nInline.\n"]);
  });

  it("sends attachments as images, local images and text", async () => {
    const { sdk, sent } = setup();
    const t = await sdk.create({ harness: "codex", cwd: tempDir() });
    await sdk.send(t.id, "reply ok", {
      attachments: [
        { kind: "image", media_type: "image/png", data: "aGk=" },
        { kind: "image", path: "/pics/cat.png" },
        { kind: "file", name: "notes.md", media_type: "text/markdown", data: Buffer.from("# Notes").toString("base64") },
        { kind: "file", path: "/docs/report.pdf" },
      ],
    });
    await settle(sdk, t.id);
    expect(sent("turn/start")[0]!.params.input).toEqual([
      { type: "text", text: "reply ok", text_elements: [] },
      { type: "image", url: "data:image/png;base64,aGk=" },
      { type: "localImage", path: "/pics/cat.png" },
      { type: "text", text: "Attached file notes.md:\n# Notes", text_elements: [] },
      { type: "text", text: "Attached file: /docs/report.pdf", text_elements: [] },
    ]);
  });
});

describe("CODEX_HOME", () => {
  it("links the user's login into the app's home, once, and leaves a login of its own alone", () => {
    const user = tempDir();
    writeFileSync(join(user, "auth.json"), '{"user":true}');
    const home = join(tempDir(), "app-home");
    expect(prepareCodexHome(home, user)).toBe(home);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(user, "auth.json"));
    prepareCodexHome(home, user);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"user":true}');

    const own = tempDir();
    writeFileSync(join(own, "auth.json"), '{"own":true}');
    prepareCodexHome(own, user);
    expect(readFileSync(join(own, "auth.json"), "utf8")).toBe('{"own":true}');
  });

  it("links the login again when the link has broken, and links none with login: false", () => {
    const user = tempDir();
    const home = tempDir();
    writeFileSync(join(user, "auth.json"), "{}");
    prepareCodexHome(home, user);
    rmSync(join(user, "auth.json"));
    const moved = tempDir();
    writeFileSync(join(moved, "auth.json"), '{"moved":true}');
    prepareCodexHome(home, moved);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"moved":true}');

    const none = tempDir();
    prepareCodexHome(none, false);
    expect(existsSync(join(none, "auth.json"))).toBe(false);
  });
});

describe("the loopback MCP server", () => {
  it("serves the tools to requests with its token, and only those", async () => {
    const calls: unknown[] = [];
    const srv = await serveTools("app", {
      tools: () => [lookupOrder()],
      call: async (name, args) => (calls.push([name, args]), { text: "done", isError: false, structured: { n: 1 } }),
    });
    try {
      const post = (body: unknown, token = srv.token) =>
        fetch(srv.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
      expect((await fetch(srv.url, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(srv.url, { headers: { Authorization: `Bearer ${srv.token}` } })).status).toBe(405);

      const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
      expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "app" } } });
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
      expect(list.result.tools).toEqual([{ name: "lookup_order", description: "Looks up an order.", inputSchema: lookupOrder().input }]);
      const [call, unknown] = (await (
        await post([
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup_order", arguments: { order_id: "1" } } },
          { jsonrpc: "2.0", id: 4, method: "nope" },
        ])
      ).json()) as any[];
      expect(call).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "done" }], structuredContent: { n: 1 } } });
      expect(unknown).toMatchObject({ id: 4, error: { code: -32601 } });
      expect(calls).toEqual([["lookup_order", { order_id: "1" }]]);
    } finally {
      await srv.close();
    }
  });
});

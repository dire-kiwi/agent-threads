// What the recorded fixtures don't cover, against a scriptable fake `claude` (mini-claude.mjs):
// steering that outlives a turn, policies, failures, restarts, option changes and stopping.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Item, ThreadEvent, ToolCall, TurnResult, UserMessage } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads, CommandError, type AgentThreadsOptions } from "../agent-threads.js";
import { claudeCode, type ClaudeCodeOptions } from "../claude/driver.js";
import type { Store } from "../store.js";
import { FileStore } from "../stores/file.js";
import { MemoryStore } from "../stores/memory.js";
import { SqliteStore } from "../stores/sqlite.js";
import { defineTool, type ToolContext } from "../tools.js";
import { tempDir } from "./spec.js";

const mini = fileURLToPath(new URL("./mini-claude.mjs", import.meta.url));

let open: AgentThreads[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

function setup(options: AgentThreadsOptions & { claude?: ClaudeCodeOptions; steer?: "now" | "late" | "never" } = {}) {
  const log = join(tempDir(), "log.jsonl");
  const { claude, steer = "now", ...rest } = options;
  const events: ThreadEvent[] = [];
  const make = (store: Store = rest.store ?? new MemoryStore()) => {
    const sdk = new AgentThreads({
      permissions: "allow",
      ...rest,
      store,
      harnesses: { claude: claudeCode({ bin: mini, env: { MINI_CLAUDE_LOG: log, MINI_CLAUDE_STEER: steer }, ...claude }) },
      onError: (e) => {
        throw e;
      },
    });
    sdk.subscribe((e) => events.push(e));
    open.push(sdk);
    return sdk;
  };
  const sdk = make();
  /** What each run was started with and sent. */
  const runs = () => {
    if (!existsSync(log)) return [];
    const out: { argv: string[]; sent: { type: string; [k: string]: unknown }[] }[] = [];
    for (const l of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const v = JSON.parse(l);
      if (v.argv) out.push({ argv: v.argv, sent: [] });
      else out[out.length - 1]!.sent.push(v);
    }
    return out;
  };
  return { sdk, make, events, runs };
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
    if (s.thread.status === "idle" || s.thread.status === "error") return s;
    if (Date.now() > deadline) throw new Error(`thread ${id} is still ${s.thread.status}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const results = (items: Item[]) => items.filter((i): i is TurnResult => i.type === "turn_result");
const texts = (items: Item[]) => items.filter((i) => i.type === "assistant_message").map((i) => (i as { text: string }).text);

describe("the Claude driver", () => {
  it("runs turns in one process, and sets the session id", async () => {
    const { sdk, runs } = setup();
    const t = await sdk.create({ model: "mini" });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    await sdk.send(t.id, "reply two");
    const s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(["one", "two"]);
    expect(s.thread.session_id).toMatch(/^sess-/);
    expect(s.thread.usage).toEqual({ input_tokens: 2, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.002 });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.argv).toEqual(expect.arrayContaining(["--model", "mini", "--setting-sources", "", "--strict-mcp-config"]));
  });

  it("starts the next turn with a steered message Claude takes in after its turn ends", async () => {
    const { sdk, events } = setup({ steer: "late" });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(() => events.some((e) => e.type === "thread.updated" && e.thread.session_id));
    await sdk.send(t.id, "reply steered", { client_id: "c2" });
    await sdk.interrupt(t.id);
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 2 && s.thread.status === "idle" ? s : undefined;
    });
    const steered = s.items.find((i): i is UserMessage => i.type === "user_message" && i.client_id === "c2")!;
    expect(steered.queued).toBeUndefined();
    expect(steered.steered).toBe(true);
    const [first, second] = results(s.items);
    expect(first).toMatchObject({ ok: false, interrupted: true });
    expect(second).toMatchObject({ ok: true });
    // It moved to the turn it started.
    expect(steered.turn_id).toBe(second!.turn_id);
    expect(texts(s.items)).toEqual(["steered"]);
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
  });

  it("restarts Claude with a steered message it never takes in", async () => {
    const { sdk, runs } = setup({ steer: "never", claude: { steerGraceMs: 100, closeGraceMs: 100 } });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    // Sent while a turn runs, so it's steered; this Claude ignores it.
    await sdk.send(t.id, "reply a");
    await sdk.interrupt(t.id);
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return texts(s.items).includes("a") && s.thread.status === "idle" ? s : undefined;
    });
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    const all = runs();
    expect(all).toHaveLength(2);
    expect(all[1]!.argv).toEqual(expect.arrayContaining(["--resume", s.thread.session_id!]));
  });

  it("asks the policy, and remembers an answer given `always`", async () => {
    const seen: string[] = [];
    const { sdk, events } = setup({
      permissions: (q) => {
        seen.push(q.name);
        return q.kind === "read" ? "allow" : q.name === "WebFetch" ? { deny: "No web." } : "ask";
      },
    });
    const t = await sdk.create();
    await sdk.send(t.id, 'tool Read {"file_path":"a.txt"}');
    let s = await settle(sdk, t.id);
    expect(s.items.find((i): i is ToolCall => i.type === "tool_call")).toMatchObject({ name: "Read", kind: "read", path: "a.txt", status: "completed" });

    await sdk.send(t.id, 'tool WebFetch {"url":"https://example.com"}');
    s = await settle(sdk, t.id);
    expect(texts(s.items)).toContain("denied: No web.");
    expect(s.items.filter((i): i is ToolCall => i.type === "tool_call")[1]).toMatchObject({ kind: "web", status: "denied" });

    await sdk.send(t.id, 'tool Bash {"command":"ls"}');
    const req = await until(() => events.find((e) => e.type === "request.opened"));
    expect(req.type === "request.opened" && req.request).toMatchObject({ type: "permission", name: "Bash", kind: "shell", title: "ls" });
    await sdk.handle({ type: "respond", thread_id: t.id, request_id: req.type === "request.opened" ? req.request.id : "", resolution: { outcome: "allow", always: true } });
    await settle(sdk, t.id);

    await sdk.send(t.id, 'tool Bash {"command":"pwd"}');
    s = await settle(sdk, t.id);
    expect(events.filter((e) => e.type === "request.opened")).toHaveLength(1);
    expect(seen).toEqual(["Read", "WebFetch", "Bash"]);
    expect(texts(s.items).at(-1)).toBe('ran with {"command":"pwd"}');
  });

  it("runs app tools with the thread's id, metadata and call", async () => {
    let ctx: ToolContext | undefined;
    const lookup = defineTool<{ id: string }>({
      name: "lookup",
      description: "Looks a thing up.",
      input: { type: "object", properties: { id: { type: "string" } } },
      run: (args, c) => {
        ctx = c;
        return `thing ${args.id}`;
      },
    });
    const { sdk, runs } = setup();
    const t = await sdk.create({ tools: [lookup], metadata: { user: "u1" } });
    await sdk.send(t.id, 'app lookup {"id":"7"}');
    const s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(["app said thing 7"]);
    const call = s.items.find((i): i is ToolCall => i.type === "tool_call")!;
    expect(call).toMatchObject({ name: "lookup", kind: "app", status: "completed", result: { content: "thing 7" } });
    expect(ctx).toMatchObject({ threadId: t.id, metadata: { user: "u1" }, toolCallId: call.id });
    const init = runs()[0]!.sent.find((m) => m.type === "control_request")!;
    expect(init).toMatchObject({ request: { subtype: "initialize", sdkMcpServers: ["app"] } });
  });

  it("fails the turn when Claude can't be started, and tries again on the next send", async () => {
    const { sdk } = setup({ claude: { bin: "/nonexistent/claude" } });
    const t = await sdk.create();
    await sdk.send(t.id, "reply hi");
    const s = await settle(sdk, t.id);
    expect(s.thread.status).toBe("error");
    expect(s.thread.error).toMatch(/couldn't be started/);
    expect(results(s.items)).toHaveLength(1);
  });

  it("fails the turn when Claude exits during it, with what it said on stderr", async () => {
    const { sdk } = setup();
    const t = await sdk.create();
    await sdk.send(t.id, "crash");
    const s = await settle(sdk, t.id);
    expect(s.thread).toMatchObject({ status: "error" });
    expect(s.thread.error).toMatch(/exited with code 3[\s\S]*something broke/);
    expect(s.thread.run).toBeUndefined();
    // The next message starts a new process, which resumes the session.
    await sdk.send(t.id, "reply again");
    expect((await settle(sdk, t.id)).thread.status).toBe("idle");
  });

  it("stops Claude when an interrupt doesn't end the turn", async () => {
    const { sdk } = setup({ claude: { stopGraceMs: 100, closeGraceMs: 100 } });
    const t = await sdk.create();
    await sdk.send(t.id, "stubborn");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.interrupt(t.id);
    const s = await settle(sdk, t.id);
    expect(s.thread.status).toBe("idle");
    expect(results(s.items)).toEqual([expect.objectContaining({ ok: false, interrupted: true })]);
  });

  it("restarts Claude with new options for the next turn", async () => {
    const { sdk, runs } = setup();
    const t = await sdk.create({ model: "a" });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    await sdk.handle({ type: "set_options", thread_id: t.id, model: "b", permission_mode: "accept_edits", effort: "high" });
    expect((await sdk.snapshot(t.id)).thread).toMatchObject({ model: "b", permission_mode: "accept_edits", effort: "high" });
    await sdk.send(t.id, "reply two");
    const s = await settle(sdk, t.id);
    const [, second] = runs();
    expect(second!.argv).toEqual(expect.arrayContaining(["--model", "b", "--permission-mode", "acceptEdits", "--effort", "high", "--resume", s.thread.session_id!]));
  });

  it("passes skills, MCP servers and the system prompt, isolated from the user's config", async () => {
    const skillDir = join(tempDir(), "support");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: support\n---\nBe kind.");
    const { sdk, runs } = setup({ skills: [skillDir], mcpServers: { docs: { url: "https://example.com/mcp" } }, systemPrompt: "You help." });
    const t = await sdk.create({ skills: [{ name: "greet", content: "Say hi." }], mcpServers: { echo: { command: "node", args: ["echo.mjs"] } } });
    await sdk.send(t.id, "reply hi");
    await settle(sdk, t.id);
    const argv = runs()[0]!.argv;
    const flag = (name: string) => argv[argv.indexOf(name) + 1]!;
    const skills = join(flag("--add-dir"), ".claude", "skills");
    expect(readFileSync(join(skills, "support", "SKILL.md"), "utf8")).toMatch(/Be kind/);
    expect(readFileSync(join(skills, "greet", "SKILL.md"), "utf8")).toBe("Say hi.");
    expect(JSON.parse(flag("--mcp-config"))).toEqual({
      mcpServers: { docs: { type: "http", url: "https://example.com/mcp" }, echo: { type: "stdio", command: "node", args: ["echo.mjs"] } },
    });
    expect(flag("--append-system-prompt")).toBe("You help.");
    expect(flag("--setting-sources")).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    // The generated skills directory goes when the thread's harness stops.
    await sdk.close();
    expect(existsSync(skills)).toBe(false);
  });

  it("lets an app opt in to the user's own settings", async () => {
    const { sdk, runs } = setup({ claude: { userSettings: true } });
    const t = await sdk.create();
    await sdk.send(t.id, "reply hi");
    await settle(sdk, t.id);
    expect(runs()[0]!.argv).not.toContain("--setting-sources");
    expect(runs()[0]!.argv).not.toContain("--strict-mcp-config");
  });

  it("reports commands it can't carry out", async () => {
    const { sdk } = setup();
    await expect(sdk.handle({ type: "send", thread_id: "nope", text: "hi" })).rejects.toBeInstanceOf(CommandError);
    await expect(sdk.handle({ type: "dance", thread_id: "nope" } as never)).rejects.toBeInstanceOf(CommandError);
    await expect(sdk.create({ harness: "codex" })).rejects.toThrow(/no harness/);
  });
});

describe.each([
  ["FileStore", () => new FileStore(tempDir())],
  ["SqliteStore", () => new SqliteStore(join(tempDir(), "t.db"))],
])("AgentThreads on a %s", (_, makeStore) => {
  it("saves events, and picks a thread up again after a restart", async () => {
    const store = makeStore();
    const { sdk, make, events } = setup({ store });
    const t = await sdk.create({ title: "kept" });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    const saved = events.filter((e) => e.type !== "delta");
    expect(await sdk.eventsSince(t.id, 0)).toEqual(saved);
    expect(await sdk.eventsSince(t.id, saved.length - 2)).toEqual(saved.slice(-2));
    await sdk.close();
    open = open.filter((s) => s !== sdk);
    const before = await sdk.snapshot(t.id);

    const again = make(store);
    expect(await again.snapshot(t.id)).toEqual(before);
    expect(before.thread.run).toBeUndefined();
    await again.send(t.id, "reply two");
    expect(texts((await settle(again, t.id)).items)).toEqual(["one", "two"]);
    expect((await again.list()).map((x) => x.title)).toEqual(["kept"]);
  });
});

describe("AgentThreads", () => {
  it("ends a turn that was running when the backend stopped", async () => {
    const store = new MemoryStore();
    const { sdk, make } = setup({ store });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    // As if the backend died: nothing is closed, and the thread is left running in the store.
    const crashed = structuredClone(store.state);
    await sdk.close();
    open = open.filter((s) => s !== sdk);

    const again = make(new MemoryStore(crashed));
    const s = await again.snapshot(t.id);
    expect(s.thread).toMatchObject({ status: "error", error: expect.stringMatching(/stopped/) });
    expect(s.thread.run).toBeUndefined();
    expect(results(s.items)).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("deletes a thread", async () => {
    const { sdk } = setup();
    const t = await sdk.create();
    await sdk.send(t.id, "reply hi");
    await settle(sdk, t.id);
    expect(await sdk.delete(t.id)).toBe(true);
    expect(await sdk.get(t.id)).toBeNull();
    await expect(sdk.snapshot(t.id)).rejects.toBeInstanceOf(CommandError);
  });
});

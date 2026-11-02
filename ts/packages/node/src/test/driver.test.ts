// What the recorded fixtures don't cover, against a scriptable fake `claude` (mini-claude.mjs):
// steering that outlives a turn, policies, failures, restarts, option changes and stopping.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvents, initialState, openRequests, type Item, type ThreadEvent, type ToolCall, type TurnResult, type UserMessage } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads, CommandError, ControlError, type AgentThreadsOptions } from "../agent-threads.js";
import type { HarnessMessage } from "../harness.js";
import { claudeCode, type ClaudeCodeOptions } from "../claude/driver.js";
import type { LaunchOptions } from "../harness.js";
import { shim } from "../shim.js";
import type { Store } from "../store.js";
import { FileStore } from "../stores/file.js";
import { MemoryStore } from "../stores/memory.js";
import { SqliteStore } from "../stores/sqlite.js";
import { defineTool, type ToolContext } from "../tools.js";
import { shimPath, tempDir } from "./spec.js";

const mini = fileURLToPath(new URL("./mini-claude.mjs", import.meta.url));

let open: AgentThreads[] = [];
/** File stores, which are the app's to close (left open, their files are closed when they're collected, which fails). */
const fileStores: FileStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  await Promise.all(fileStores.splice(0).map((s) => s.close()));
});

function fileStore(): FileStore {
  const store = new FileStore(tempDir());
  fileStores.push(store);
  return store;
}

interface Setup extends AgentThreadsOptions {
  claude?: ClaudeCodeOptions;
  steer?: "now" | "late" | "never" | "hold";
  /** Resumed processes fail: always, or while this file exists. */
  failResume?: boolean | string;
  /** More of mini-claude's environment. */
  env?: { [k: string]: string };
}

function setup(options: Setup = {}) {
  const log = join(tempDir(), "log.jsonl");
  const { claude, steer = "now", failResume, env, ...rest } = options;
  const events: ThreadEvent[] = [];
  const make = (store: Store = rest.store ?? new MemoryStore()) => {
    const sdk = new AgentThreads({
      permissions: "allow",
      ...rest,
      store,
      harnesses: { claude: claudeCode({ bin: mini, env: { MINI_CLAUDE_LOG: log, MINI_CLAUDE_STEER: steer, ...(failResume ? { MINI_CLAUDE_FAIL_RESUME: failResume === true ? "1" : failResume } : {}), ...env }, ...claude }) },
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
  const sdk = make();
  /** What each run was started with and sent. */
  const runs = () => {
    if (!existsSync(log)) return [];
    // Its CLAUDE_CONFIG_DIR, and the variables MINI_LOG_ENV names (null if unset).
    const out: { argv: string[]; configDir?: string; env: { [k: string]: string | null }; sent: { type: string; [k: string]: unknown }[] }[] = [];
    for (const l of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const v = JSON.parse(l);
      if (v.argv) out.push({ argv: v.argv, ...(v.configDir !== undefined ? { configDir: v.configDir } : {}), env: v.env ?? {}, sent: [] });
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

/**
 * Nothing happened outside a turn the SDK tracks: every assistant message, tool call and turn
 * result was added while its turn was open, and every result Claude sent ended one (a turn ended
 * by a result has its usage; one ended otherwise, e.g. by its process exiting, has none).
 */
function expectTracked(events: ThreadEvent[], runs: { sent: { [k: string]: unknown }[] }[]) {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type === "turn.started") open.add(e.turn_id);
    else if (e.type === "turn.completed") open.delete(e.turn_id);
    else if (e.type === "item.added" && ["assistant_message", "reasoning", "tool_call", "turn_result"].includes(e.item.type)) {
      expect(!!e.item.turn_id && open.has(e.item.turn_id), `outside a turn: ${JSON.stringify(e.item)}`).toBe(true);
    }
  }
  const sent = runs.flatMap((r) => r.sent).filter((m) => "result" in m).length;
  const ended = events.filter((e) => e.type === "item.added" && e.item.type === "turn_result" && e.item.usage).length;
  expect(ended, "results Claude sent that ended a turn").toBe(sent);
}

/** After events[from], the thread went idle only once the reply `text` was in. */
function expectIdleAfter(events: ThreadEvent[], from: number, text: string) {
  const later = events.slice(from);
  const idle = later.findIndex((e) => e.type === "thread.updated" && (e.thread.status === "idle" || e.thread.status === "error"));
  const reply = later.findIndex((e) => (e.type === "item.added" || e.type === "item.updated") && JSON.stringify(e).includes(JSON.stringify(text)));
  expect(reply, `the reply ${text}`).toBeGreaterThanOrEqual(0);
  expect(idle, "going idle").toBeGreaterThan(reply);
  expect(later[idle]).toMatchObject({ thread: { status: "idle" } });
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

  it("runs a carried-over turn with options changed during the turn before", async () => {
    const { sdk, runs } = setup({ steer: "late" });
    const t = await sdk.create({ model: "old-model" });
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "reply steered");
    await sdk.setOptions(t.id, { model: "new-model" });
    await sdk.interrupt(t.id);
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 2 && s.thread.status === "idle" ? s : undefined;
    });
    expect(texts(s.items)).toEqual(["steered"]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    const [first, second] = runs();
    expect(first!.argv).toEqual(expect.arrayContaining(["--model", "old-model"]));
    expect(second!.argv).toEqual(expect.arrayContaining(["--model", "new-model", "--resume", s.thread.session_id!]));
  });

  it("stops carrying a steered message over to a harness that keeps failing, and keeps it for a retry that works", async () => {
    const broken = join(tempDir(), "broken");
    writeFileSync(broken, "");
    const { sdk, events, runs } = setup({ failResume: broken });
    const t = await sdk.create();
    await sdk.send(t.id, "sleepcrash 300");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "reply steered", { client_id: "s" });
    // The first process crashes; the turn it carries over to fails too, and that's where it stops.
    let s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 2 && s.thread.status === "error" ? s : undefined;
    });
    const count = { runs: runs().length, events: events.length };
    expect(count.runs).toBe(2);
    await new Promise((r) => setTimeout(r, 500));
    expect({ runs: runs().length, events: events.length }).toEqual(count);
    expect((await sdk.snapshot(t.id)).thread.status).toBe("error");
    const steered = () => s.items.find((i): i is UserMessage => i.type === "user_message" && i.client_id === "s")!;
    expect(steered().queued).toBe(true);
    expect(s.items.at(-1)).toMatchObject({ type: "notice", level: "warning", code: "undelivered" });

    // An explicit retry that fails too leaves it queued, and stops there.
    await sdk.send(t.id, "reply again", { client_id: "a" });
    s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 3 && s.thread.status === "error" ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(runs()).toHaveLength(3);
    expect(results((await sdk.snapshot(t.id)).items)).toHaveLength(3);
    expect(steered().queued).toBe(true);

    // Once the harness works, the next message takes it along, and it's taken in.
    // They go as one message, so Claude makes one turn of them.
    rmSync(broken);
    const from = events.length;
    await sdk.send(t.id, "reply ok", { client_id: "o" });
    s = await settle(sdk, t.id);
    const fourth = runs()[3]!.sent.filter((m) => m.type === "user") as unknown as { message: { content: { text: string }[] } }[];
    expect(fourth.map((m) => m.message.content.map((b) => b.text))).toEqual([["reply steered", "reply ok"]]);
    expect(steered().queued).toBeUndefined();
    expect(texts(s.items).slice(-2)).toEqual(["steered", "ok"]);
    expect(s.thread.status).toBe("idle");
    expectIdleAfter(events, from, "ok");
    expectTracked(events, runs());
    await sdk.close();
  });

  it("stops a live process holding a message it gives up on, after two interrupts", async () => {
    const { sdk, events, runs } = setup({ steer: "hold", claude: { closeGraceMs: 100 } });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "reply steered", { client_id: "s" });
    await sdk.interrupt(t.id);
    // The steered message is carried over to a turn that the live process holds it for...
    await until(() => events.filter((e) => e.type === "turn.started").length === 2);
    // ...which is interrupted too: that's enough, and the process is stopped so it can't run it.
    await sdk.interrupt(t.id);
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 2 && s.thread.status === "idle" && !s.thread.run ? s : undefined;
    });
    expect(results(s.items).map((r) => r.interrupted)).toEqual([true, true]);
    expect(s.items.find((i): i is UserMessage => i.type === "user_message" && i.client_id === "s")!.queued).toBe(true);
    expect(s.items.at(-1)).toMatchObject({ type: "notice", code: "undelivered" });
    const count = events.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(count);
    expect(runs()).toHaveLength(1);

    // The next message takes it to a new process, in one turn with it.
    const from = events.length;
    await sdk.send(t.id, "reply next");
    const after = await settle(sdk, t.id);
    expect(texts(after.items)).toEqual(["steered", "next"]);
    expect(after.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    expectIdleAfter(events, from, "next");
    expectTracked(events, runs());
  });

  it("keeps everything in a turn when a carried-over turn Claude has started is interrupted too", async () => {
    const { sdk, events, runs } = setup({ steer: "late", claude: { closeGraceMs: 100 } });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "sleep 2000 steered", { client_id: "s" });
    await sdk.interrupt(t.id);
    // Claude takes the steered message in after the first turn's result, as a turn of its own...
    await until(async () => (await sdk.snapshot(t.id)).items.some((i) => i.type === "user_message" && i.client_id === "s" && !i.queued));
    // ...which is interrupted.
    await sdk.interrupt(t.id);
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 2 && s.thread.status === "idle" ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(results((await sdk.snapshot(t.id)).items)).toHaveLength(2);
    expect(results(s.items).map((r) => r.interrupted)).toEqual([true, true]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    const from = events.length;
    await sdk.send(t.id, "reply after");
    await settle(sdk, t.id);
    expectIdleAfter(events, from, "after");
    expectTracked(events, runs());
    expect(runs()).toHaveLength(1);
  });

  it("carries a message over again after a failed result while the process holds it", async () => {
    const { sdk, runs } = setup({ steer: "late", env: { MINI_CLAUDE_IDLE_ERRORS: "1" } });
    const t = await sdk.create();
    await sdk.send(t.id, "sleep 200 first");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "reply steered", { client_id: "s" });
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 3 && s.thread.status === "idle" ? s : undefined;
    });
    expect(results(s.items).map((r) => r.ok)).toEqual([true, false, true]);
    expect(texts(s.items)).toEqual(["first", "steered"]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    expect(runs()).toHaveLength(1);
  });

  it("gives up after too many failed results, stopping the process that holds the message", async () => {
    const { sdk, events, runs } = setup({ steer: "late", env: { MINI_CLAUDE_IDLE_ERRORS: "10" }, claude: { closeGraceMs: 100 } });
    const t = await sdk.create();
    await sdk.send(t.id, "sleep 200 first");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "reply steered", { client_id: "s" });
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return results(s.items).length === 4 && s.thread.status === "error" && !s.thread.run ? s : undefined;
    });
    const count = events.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(count);
    expect(runs()).toHaveLength(1);
    expect(texts(s.items)).toEqual(["first"]);
    expect(s.items.find((i): i is UserMessage => i.type === "user_message" && i.client_id === "s")!.queued).toBe(true);
    expect(s.items.at(-1)).toMatchObject({ type: "notice", code: "undelivered" });
  });

  it("keeps the text streamed so far when the process exits before finishing it", async () => {
    const store = new MemoryStore();
    const { sdk, make } = setup({ store });
    const t = await sdk.create();
    await sdk.send(t.id, "streamcrash half a thought");
    const s = await settle(sdk, t.id);
    expect(s.thread.status).toBe("error");
    expect(texts(s.items)).toEqual(["half a thought "]);
    await sdk.close();
    open = open.filter((x) => x !== sdk);
    expect(texts((await make(store).snapshot(t.id)).items)).toEqual(["half a thought "]);
  });

  it("keeps the text streamed so far when the backend shuts down mid-message", async () => {
    const store = new MemoryStore();
    const { sdk, make } = setup({ store });
    const t = await sdk.create();
    await sdk.send(t.id, "streamhang cut short");
    await until(async () => texts((await sdk.snapshot(t.id)).items)[0] === "cut short ");
    await sdk.close();
    open = open.filter((x) => x !== sdk);
    const s = await make(store).snapshot(t.id);
    expect(texts(s.items)).toEqual(["cut short "]);
    expect(results(s.items)).toEqual([expect.objectContaining({ ok: false, interrupted: true })]);
  });

  it("doesn't restart Claude while it works through steered messages for longer than the grace", async () => {
    const { sdk, events, runs } = setup({ steer: "late", claude: { steerGraceMs: 150 } });
    const t = await sdk.create();
    await sdk.send(t.id, "sleep 100 first");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    // Both wait for the first turn's result; Claude makes a turn of each, and the first of those
    // runs longer than the grace.
    await sdk.send(t.id, "sleep 500 second", { client_id: "a" });
    await sdk.send(t.id, "reply third", { client_id: "b" });
    const from = events.length;
    const s = await until(async () => {
      const s = await sdk.snapshot(t.id);
      return texts(s.items).includes("third") && s.thread.status === "idle" ? s : undefined;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(texts((await sdk.snapshot(t.id)).items)).toEqual(["first", "second", "third"]);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    expect(runs()).toHaveLength(1);
    expectIdleAfter(events, from, "third");
    expectTracked(events, runs());
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
    const commands: (string | undefined)[] = [];
    const { sdk, events } = setup({
      permissions: (q) => {
        seen.push(q.name);
        if (q.kind === "shell") commands.push(q.command);
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
    expect(commands).toEqual(["ls"]);
    await sdk.handle({ type: "respond", thread_id: t.id, request_id: req.type === "request.opened" ? req.request.id : "", resolution: { outcome: "allow", always: true } });
    await settle(sdk, t.id);

    // The answered request stays, with its answer.
    expect((await sdk.snapshot(t.id)).requests).toEqual([{ ...req.request, resolution: { outcome: "allow", always: true } }]);

    await sdk.send(t.id, 'tool Bash {"command":"pwd"}');
    s = await settle(sdk, t.id);
    expect(events.filter((e) => e.type === "request.opened")).toHaveLength(1);
    expect(seen).toEqual(["Read", "WebFetch", "Bash"]);
    expect(texts(s.items).at(-1)).toBe('ran with {"command":"pwd"}');
  });

  it("keeps a background subagent's calls and requests after its turn, and runs the turn Claude starts when it ends", async () => {
    const { sdk, events, runs } = setup({ permissions: (q) => (q.kind === "shell" ? "ask" : "allow") });
    const t = await sdk.create({ model: "mini" });
    await sdk.send(t.id, "background 0 apple");
    // The turn ends with the subagent's call waiting for the user, who's still asked.
    const req = await until(() => events.find((e) => e.type === "request.opened"));
    await until(() => events.some((e) => e.type === "turn.completed"));
    let s = await sdk.snapshot(t.id);
    expect(s.thread.status).toBe("waiting");
    expect(openRequests(s)).toHaveLength(1);
    let [agent, bash] = s.items.filter((i): i is ToolCall => i.type === "tool_call");
    expect(agent).toMatchObject({ name: "Agent", kind: "subagent", status: "completed", subagent: { status: "running", background: true, agent_type: "general-purpose", model: "mini-1" } });
    expect(bash).toMatchObject({ name: "Bash", status: "pending", parent_id: agent!.id });

    await sdk.handle({ type: "respond", thread_id: t.id, request_id: req.type === "request.opened" ? req.request.id : "", resolution: { outcome: "allow" } });
    s = await until(async () => {
      const x = await sdk.snapshot(t.id);
      return results(x.items).length === 2 && x.thread.status === "idle" && x;
    });
    [agent, bash] = s.items.filter((i): i is ToolCall => i.type === "tool_call");
    expect(agent!.subagent).toEqual({ status: "completed", background: true, agent_type: "general-purpose", model: "mini-1", activity: "Running true", tool_uses: 1, summary: "apple" });
    expect(bash).toMatchObject({ status: "completed", result: { content: "done" } });
    expect(runs()[0]!.sent).toContainEqual(expect.objectContaining({ type: "control_response", response: expect.objectContaining({ response: expect.objectContaining({ behavior: "allow" }) }) }));
    // Claude's own turn has no message of the user's.
    const [, second] = results(s.items);
    expect(s.items.filter((i) => i.type === "user_message" && i.turn_id === second!.turn_id)).toEqual([]);
    expect(texts(s.items).at(-1)).toBe("the subagent said apple");
    expectTracked(events, runs());
  });

  for (const change of ["new_session", "rewind"] as const) {
    it(`stops the process when ${change} changes the session, so a background subagent's turn can't bring the old one back`, async () => {
      const { sdk, events, runs } = setup();
      const t = await sdk.create({ model: "mini" });
      await sdk.send(t.id, "background 500 apple");
      await until(() => events.some((e) => e.type === "turn.completed"));
      let s = await sdk.snapshot(t.id);
      expect(s.thread.session_id).toBeTruthy();
      const agent = s.items.find((i): i is ToolCall => i.type === "tool_call" && i.name === "Agent")!;
      expect(agent.subagent?.status).toBe("running");
      if (change === "new_session") await sdk.newSession(t.id);
      else await sdk.rewind(t.id, results(s.items)[0]!.turn_id!);
      // Long enough for the subagent to have ended, and Claude's turn about it to have come.
      await new Promise((r) => setTimeout(r, 1000));
      s = await sdk.snapshot(t.id);
      expect(s.thread.session_id).toBeUndefined();
      expect(s.thread.status).toBe("idle");
      expect(s.items.at(-1)).toMatchObject({ type: "notice", code: change === "new_session" ? "session.new" : "rewind" });
      expect(texts(s.items)).not.toContain("the subagent said apple");
      if (change === "new_session") expect(s.items.find((i) => i.id === agent.id)).toMatchObject({ subagent: { status: "stopped" } });
      expect(runs()).toHaveLength(1);
      // The next message starts a new process, in a new session.
      await sdk.send(t.id, "reply fresh");
      s = await settle(sdk, t.id);
      expect(texts(s.items).at(-1)).toBe("fresh");
      expect(runs()[1]!.argv).not.toContain("--resume");
    });
  }

  it("keeps a turn of the user's going past a turn Claude makes by itself before taking the user's message in", async () => {
    const { sdk, events } = setup({ env: { MINI_CLAUDE_NOTIFY_FIRST: "1" } });
    const t = await sdk.create({ model: "mini" });
    await sdk.send(t.id, "background 300 apple");
    await until(() => events.some((e) => e.type === "turn.completed"));
    // Sent before the subagent is done: Claude reports the subagent first, then takes this in.
    const from = events.length;
    await sdk.send(t.id, "reply hi");
    const s = await until(async () => {
      const x = await sdk.snapshot(t.id);
      return texts(x.items).at(-1) === "hi" && x.thread.status === "idle" && x;
    });
    expectIdleAfter(events, from, "hi");
    const [, second] = results(s.items);
    expect(results(s.items)).toHaveLength(2);
    // The user's turn has its message, both replies, and both results' usage.
    expect(s.items.filter((i) => i.turn_id === second!.turn_id && i.type !== "turn_result").map((i) => (i.type === "user_message" || i.type === "assistant_message" ? i.text : i.type))).toEqual([
      "reply hi",
      "the subagent said apple",
      "hi",
    ]);
    expect(second!.usage).toMatchObject({ input_tokens: 2, output_tokens: 4 });
  });

  it("keeps a background subagent's app tool's structured output for the result that comes after its turn", async () => {
    const lookup = defineTool({ name: "lookup", description: "Looks it up.", input: { type: "object" }, run: () => ({ text: "42", structured: { answer: 42 } }) });
    const { sdk } = setup({ tools: [lookup], env: { MINI_CLAUDE_BACKGROUND_APP: "lookup" } });
    const t = await sdk.create({ model: "mini" });
    await sdk.send(t.id, "background 200 apple");
    const s = await until(async () => {
      const x = await sdk.snapshot(t.id);
      return results(x.items).length === 2 && x.thread.status === "idle" && x;
    });
    const call = s.items.find((i): i is ToolCall => i.type === "tool_call" && i.name === "lookup");
    expect(call).toMatchObject({ status: "completed", result: { content: "42", structured: { answer: 42 } } });
  });

  it("stops a run's subagents when it ends, and cancels what they were doing", async () => {
    const { sdk, events } = setup();
    const t = await sdk.create({ model: "mini" });
    await sdk.send(t.id, "background 60000 apple");
    await until(async () => {
      const x = await sdk.snapshot(t.id);
      return x.thread.status === "idle" && x.items.some((i) => i.type === "tool_call" && i.name === "Bash" && i.status === "running");
    });
    await sdk.close();
    const [agent, bash] = applyEvents(initialState(t), events).items.filter((i): i is ToolCall => i.type === "tool_call");
    expect(agent).toMatchObject({ status: "completed", subagent: { status: "stopped", background: true } });
    expect(bash).toMatchObject({ status: "cancelled", parent_id: agent!.id });
  });

  it("gives a window of a thread's last items, and pages of the items before it", async () => {
    const { sdk } = setup();
    const t = await sdk.create();
    for (const n of ["one", "two", "three"]) {
      await sdk.send(t.id, `reply ${n}`);
      await settle(sdk, t.id);
    }
    const whole = await sdk.snapshot(t.id);
    // A user message, the reply and the turn's result, for each turn.
    expect(whole.items).toHaveLength(9);
    expect(whole).not.toHaveProperty("start");
    expect(await sdk.snapshot(t.id, { limit: 20 })).toEqual(whole);
    const window = await sdk.snapshot(t.id, { limit: 4 });
    expect(window).toMatchObject({ start: 5, seq: whole.seq, thread: whole.thread });
    expect(window.items).toEqual(whole.items.slice(5));
    const page = await sdk.itemsBefore(t.id, 5, 3);
    expect(page).toEqual({ thread_id: t.id, items: whole.items.slice(2, 5), requests: [], start: 2, context: [], seq: whole.seq });
    expect((await sdk.itemsBefore(t.id, 2, 3)).items).toEqual(whole.items.slice(0, 2));
    await expect(sdk.itemsBefore("nope", 2, 3)).rejects.toThrow();
  });

  it("runs app tools with the thread's id, metadata and call, and keeps their structured output", async () => {
    let ctx: ToolContext | undefined;
    const lookup = defineTool<{ id: string }>({
      name: "lookup",
      description: "Looks a thing up.",
      input: { type: "object", properties: { id: { type: "string" } } },
      run: (args, c) => {
        ctx = c;
        return { text: `thing ${args.id}`, structured: { id: args.id } };
      },
    });
    const { sdk, runs } = setup();
    const t = await sdk.create({ tools: [lookup], metadata: { user: "u1" } });
    await sdk.send(t.id, 'app lookup {"id":"7"}');
    const s = await settle(sdk, t.id);
    expect(texts(s.items)).toEqual(["app said thing 7"]);
    const call = s.items.find((i): i is ToolCall => i.type === "tool_call")!;
    expect(call).toMatchObject({ name: "lookup", kind: "app", status: "completed", result: { content: "thing 7", structured: { id: "7" } } });
    expect(ctx).toMatchObject({ threadId: t.id, metadata: { user: "u1" }, toolCallId: call.id });
    const init = runs()[0]!.sent.find((m) => m.type === "control_request")!;
    expect(init).toMatchObject({ request: { subtype: "initialize", sdkMcpServers: ["app"] } });
  });

  it("leaves raw out unless it's turned on, and passes the app every line", async () => {
    const messages: HarnessMessage[] = [];
    const { sdk, events } = setup({ onHarnessMessage: (m) => messages.push(m) });
    const t = await sdk.create();
    await sdk.send(t.id, "reply hi");
    const s = await settle(sdk, t.id);
    expect(events.some((e) => "raw" in e || (e.type === "item.added" && "raw" in e.item))).toBe(false);
    expect(s.items.some((i) => "raw" in i)).toBe(false);
    const types = messages.map((m) => (m.message as { type?: string }).type);
    expect(types).toEqual(expect.arrayContaining(["control_response", "system", "assistant", "result"]));
    expect(messages.every((m) => m.threadId === t.id && m.harness === "claude" && m.runId === s.thread.run?.id && JSON.parse(m.line).type)).toBe(true);
  });

  it("sends control requests to the running process, and fails them when it can't", async () => {
    const { sdk, runs } = setup();
    const t = await sdk.create();
    await expect(sdk.control(t.id, { subtype: "get_context_usage" })).rejects.toThrow(CommandError);
    await sdk.send(t.id, "reply hi");
    await settle(sdk, t.id);
    await expect(sdk.control(t.id, { subtype: "get_context_usage" })).resolves.toEqual({});
    await expect(sdk.control(t.id, "get_context_usage")).rejects.toThrow(CommandError);
    // One the process exits before answering.
    const pending = sdk.control(t.id, { subtype: "never_answered" }).catch((e: unknown) => e);
    await until(() => runs()[0]?.sent.some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "never_answered"));
    await sdk.close();
    expect(await pending).toBeInstanceOf(ControlError);
    await expect(sdk.control(t.id, { subtype: "get_context_usage" })).rejects.toThrow(CommandError);
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
    // A plugin, which Claude finds even with --setting-sources "".
    const plugin = flag("--plugin-dir");
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "app" });
    const skills = join(plugin, "skills");
    expect(readFileSync(join(skills, "support", "SKILL.md"), "utf8")).toMatch(/Be kind/);
    expect(readFileSync(join(skills, "greet", "SKILL.md"), "utf8")).toBe("Say hi.");
    expect(JSON.parse(flag("--mcp-config"))).toEqual({
      mcpServers: { docs: { type: "http", url: "https://example.com/mcp" }, echo: { type: "stdio", command: "node", args: ["echo.mjs"] } },
    });
    expect(flag("--append-system-prompt")).toBe("You help.");
    expect(flag("--setting-sources")).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    // The generated plugin goes when the process that used it stops.
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

  it("takes in steered messages with attachments, and ones with the same text", async () => {
    const { sdk, runs } = setup();
    const t = await sdk.create();
    await sdk.send(t.id, "sleep 300 done");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    const pdf = Buffer.from("%PDF-1.4 not really").toString("base64");
    await sdk.send(t.id, "read these", {
      client_id: "a",
      attachments: [
        { kind: "file", name: "notes.txt", media_type: "text/plain", data: Buffer.from("line one\nline two").toString("base64") },
        { kind: "file", name: "report.pdf", media_type: "application/pdf", data: pdf },
        { kind: "file", path: "/srv/data.csv" },
        { kind: "image", media_type: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    await sdk.send(t.id, "again", { client_id: "b" });
    await sdk.send(t.id, "again", { client_id: "c" });
    const s = await settle(sdk, t.id);
    expect(s.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    expect(results(s.items)).toHaveLength(1);
    expect(runs()).toHaveLength(1);

    const sent = runs()[0]!.sent.filter((m) => m.type === "user") as unknown as { message: { content: { type: string; text?: string }[] } }[];
    const blocks = sent[1]!.message.content;
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "text", "text", "image"]);
    expect(blocks[1]!.text).toBe("Attached file notes.txt:\nline one\nline two");
    // A binary file is written out, and Claude is told where.
    const path = /: (\/.*)$/.exec(blocks[2]!.text!)![1]!;
    expect(readFileSync(path).toString("base64")).toBe(pdf);
    expect(blocks[3]!.text).toBe("Attached file: /srv/data.csv");
  });

  it("keeps a standing answer to the tool it was given for", async () => {
    const asked: string[] = [];
    const { sdk, events } = setup({
      permissions: (q) => {
        asked.push(`${q.server}/${q.name}`);
        return "ask";
      },
    });
    const t = await sdk.create();
    const respondTo = async (n: number, resolution: { outcome: "allow" | "deny"; always?: boolean }) => {
      const req = await until(() => events.filter((e) => e.type === "request.opened")[n]);
      await sdk.respond(t.id, req.type === "request.opened" ? req.request.id : "", resolution);
    };
    await sdk.send(t.id, "tool mcp__safe__execute {}");
    await respondTo(0, { outcome: "allow", always: true });
    await settle(sdk, t.id);
    await sdk.send(t.id, "tool mcp__safe__execute {}");
    await settle(sdk, t.id);
    // Another server's tool of the same name, and a built-in one, are asked about.
    await sdk.send(t.id, "tool mcp__danger__execute {}");
    await respondTo(1, { outcome: "deny" });
    await settle(sdk, t.id);
    await sdk.send(t.id, "tool execute {}");
    await respondTo(2, { outcome: "deny" });
    const s = await settle(sdk, t.id);
    expect(asked).toEqual(["safe/execute", "danger/execute", "undefined/execute"]);
    expect(texts(s.items).filter((x) => x.startsWith("denied"))).toHaveLength(2);
  });

  it("drops a policy's answer that comes after Claude stopped asking", async () => {
    let answer!: (d: "ask" | "allow") => void;
    const { sdk, runs } = setup({ permissions: () => new Promise((r) => (answer = r)) });
    const t = await sdk.create();
    await sdk.send(t.id, "cancelled Bash");
    await settle(sdk, t.id);
    answer("ask");
    await new Promise((r) => setTimeout(r, 50));
    const s = await sdk.snapshot(t.id);
    expect(s.thread.status).toBe("idle");
    expect(openRequests(s)).toEqual([]);
    expect(s.items.find((i): i is ToolCall => i.type === "tool_call")!.status).toBe("failed");
    expect(runs()[0]!.sent.filter((m) => m.type === "control_response")).toEqual([]);
  });

  it("makes the skills plugin again when the thread's skills change", async () => {
    const { sdk, runs } = setup();
    const t = await sdk.create({ skills: [{ name: "style", content: "old" }] });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    const first = runs()[0]!.argv;
    const firstPlugin = first[first.indexOf("--plugin-dir") + 1]!;
    expect(readFileSync(join(firstPlugin, "skills", "style", "SKILL.md"), "utf8")).toBe("old");

    await sdk.configure(t.id, { skills: [{ name: "style", content: "new" }, { name: "tone", content: "calm" }] });
    await sdk.send(t.id, "reply two");
    await settle(sdk, t.id);
    const second = runs()[1]!.argv;
    const plugin = second[second.indexOf("--plugin-dir") + 1]!;
    expect(readFileSync(join(plugin, "skills", "style", "SKILL.md"), "utf8")).toBe("new");
    expect(readFileSync(join(plugin, "skills", "tone", "SKILL.md"), "utf8")).toBe("calm");
    // The first run's plugin went with it.
    expect(existsSync(firstPlugin)).toBe(false);
  });

  it("refuses a malformed command before it changes anything", async () => {
    const { sdk, events, runs } = setup({ permissions: "ask" });
    const t = await sdk.create();
    await sdk.send(t.id, 'tool Bash {"command":"ls"}');
    const opened = await until(() => events.find((e) => e.type === "request.opened"));
    const requestId = opened.type === "request.opened" ? opened.request.id : "";
    const before = { snapshot: await sdk.snapshot(t.id), events: events.length, runs: runs().length };
    const bad: unknown[] = [
      { type: "send", thread_id: t.id, text: "hi", attachments: [{ kind: "video" }] },
      { type: "send", thread_id: t.id, text: "hi", attachments: [{ kind: "file", data: "not base64!" }] },
      { type: "send", thread_id: t.id, text: "hi", attachments: "a.txt" },
      { type: "send", thread_id: t.id, text: "hi", client_id: 5 },
      { type: "send", thread_id: t.id, text: 7 },
      { type: "respond", thread_id: t.id, request_id: requestId, resolution: { outcome: "answer", answers: { q: "Blue" } } },
      { type: "respond", thread_id: t.id, request_id: requestId, resolution: { outcome: "yes" } },
      { type: "respond", thread_id: t.id, request_id: requestId, resolution: { outcome: "allow", always: "please" } },
      { type: "respond", thread_id: t.id, request_id: requestId },
      { type: "set_options", thread_id: t.id, permission_mode: "yolo" },
      { type: "set_options", thread_id: t.id, model: 4 },
      { type: "set_options", thread_id: t.id, model: "fine", effort: ["high"] },
      { type: "interrupt", thread_id: 1 },
      { type: "dance", thread_id: t.id },
      "send",
      null,
    ];
    for (const command of bad) await expect(sdk.handle(command as never), JSON.stringify(command)).rejects.toBeInstanceOf(CommandError);
    // The same from code.
    await expect(sdk.respond(t.id, requestId, { outcome: "maybe" } as never)).rejects.toBeInstanceOf(CommandError);
    await expect(sdk.setOptions(t.id, { permission_mode: "yolo" } as never)).rejects.toBeInstanceOf(CommandError);

    expect({ snapshot: await sdk.snapshot(t.id), events: events.length, runs: runs().length }).toEqual(before);
    // The request is still open, and a valid answer to it works.
    await sdk.handle({ type: "respond", thread_id: t.id, request_id: requestId, resolution: { outcome: "allow" } });
    expect((await settle(sdk, t.id)).thread.status).toBe("idle");
  });

  it("starts no process for a malformed command to a thread that has none", async () => {
    const { sdk, events, runs } = setup();
    const t = await sdk.create();
    await expect(sdk.handle({ type: "send", thread_id: t.id, text: "reply hi", attachments: [{ kind: "file", path: 3 }] } as never)).rejects.toBeInstanceOf(CommandError);
    await new Promise((r) => setTimeout(r, 100));
    expect(runs()).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("refuses commands after close()", async () => {
    const { sdk } = setup();
    const t = await sdk.create();
    await sdk.close();
    for (const op of [
      () => sdk.snapshot(t.id),
      () => sdk.send(t.id, "hi"),
      () => sdk.interrupt(t.id),
      () => sdk.respond(t.id, "r", { outcome: "allow" }),
      () => sdk.setOptions(t.id, { model: "x" }),
      () => sdk.handle({ type: "interrupt", thread_id: t.id }),
      () => sdk.configure(t.id, {}),
      () => sdk.delete(t.id),
      () => sdk.create(),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(CommandError);
    }
    // Reading the store still works.
    expect((await sdk.get(t.id))?.id).toBe(t.id);
    expect(await sdk.eventsSince(t.id, 0)).toHaveLength(1);
  });

  it("reports commands it can't carry out", async () => {
    const { sdk } = setup();
    await expect(sdk.handle({ type: "send", thread_id: "nope", text: "hi" })).rejects.toBeInstanceOf(CommandError);
    await expect(sdk.handle({ type: "dance", thread_id: "nope" } as never)).rejects.toBeInstanceOf(CommandError);
    await expect(sdk.create({ harness: "codex" })).rejects.toThrow(/no harness/);
  });
});

describe.each([
  ["FileStore", () => fileStore()],
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
    // Everything it sent, folded, which a new instance must load from the store.
    const before = applyEvents(initialState(t), events);

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

  it("recovers a lost turn's queued message without starting a process, and sends it with the next, configured again", async () => {
    const store = new MemoryStore();
    const { sdk, make, runs, events } = setup({ store });
    const t = await sdk.create();
    await sdk.send(t.id, "slow");
    await until(async () => (await sdk.snapshot(t.id)).thread.session_id);
    await sdk.send(t.id, "app lookup {}", { client_id: "s" });
    await sdk.eventsSince(t.id, 0); // saved
    // As if the backend died now, with the steered message queued.
    const crashed = structuredClone(store.state);
    await sdk.close();
    open = open.filter((x) => x !== sdk);
    const before = runs().length;

    const again = make(new MemoryStore(crashed));
    const s = await again.snapshot(t.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs()).toHaveLength(before);
    expect(s.thread).toMatchObject({ status: "error" });
    expect(s.thread.run).toBeUndefined();
    expect(results(s.items)).toHaveLength(1);
    expect(s.items.find((i): i is UserMessage => i.type === "user_message" && i.client_id === "s")!.queued).toBe(true);
    expect(s.items.at(-1)).toMatchObject({ type: "notice", code: "undelivered" });

    // The app gives the thread its tools again; the next message takes the queued one along.
    const lookup = defineTool({ name: "lookup", description: "Looks up.", input: { type: "object" }, run: () => "found it" });
    await again.configure(t.id, { tools: [lookup] });
    const from = events.length;
    await again.send(t.id, "reply next");
    const done = await settle(again, t.id);
    expect(texts(done.items)).toEqual(["app said found it", "next"]);
    expect(done.items.filter((i) => i.type === "user_message" && i.queued)).toEqual([]);
    expectIdleAfter(events, from, "next");
    // The thread's own history (the old instance's events after the crash aren't in it).
    expectTracked(await again.eventsSince(t.id, 0), runs());
    const last = runs().at(-1)!;
    expect(last.argv).toEqual(expect.arrayContaining(["--resume", s.thread.session_id!]));
    expect(last.sent.find((m) => m.type === "control_request")).toMatchObject({ request: { sdkMcpServers: ["app"] } });
  });

  it("keeps events a store failed to append, and saves them in order once it can", async () => {
    const inner = new MemoryStore();
    let failures = 0;
    let wrote = 0;
    // The first append fails; the second is written but reported as failed.
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "appendEvents") {
          return async (id: string, events: ThreadEvent[]) => {
            wrote++;
            if (wrote === 2) throw new Error("the disk is full");
            if (wrote === 3) {
              await target.appendEvents(id, events);
              throw new Error("timed out (but it happened)");
            }
            return target.appendEvents(id, events);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MemoryStore;
    const errors: unknown[] = [];
    const { sdk, events } = setup({ store, onError: (e) => errors.push(e) });
    const t = await sdk.create();
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    await until(async () => (await inner.lastSeq(t.id)) === events.filter((e) => e.type !== "delta").length, 10_000);
    const saved = await inner.readEvents(t.id);
    expect(saved).toEqual(events.filter((e) => e.type !== "delta"));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    failures = errors.length;
    await sdk.close();
    // The snapshot is never ahead of the events.
    const snap = await inner.loadSnapshot(t.id);
    expect(snap!.seq).toBe(await inner.lastSeq(t.id));
    expect(failures).toBe(errors.length);
  });

  it("fails close() while events can't be saved, and saves them when it's called again", async () => {
    const inner = new MemoryStore();
    let broken = false;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "appendEvents") {
          return async (id: string, events: ThreadEvent[]) => {
            if (broken) throw new Error("the disk is full");
            return target.appendEvents(id, events);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MemoryStore;
    const { sdk, make } = setup({ store, onError: () => {} });
    const t = await sdk.create();
    broken = true;
    await sdk.setOptions(t.id, { model: "unsaved-model" });
    await expect(sdk.close()).rejects.toBeInstanceOf(AggregateError);
    expect(await inner.lastSeq(t.id)).toBe(1);
    await expect(sdk.send(t.id, "reply hi")).rejects.toBeInstanceOf(CommandError);

    broken = false;
    await sdk.close();
    open = open.filter((s) => s !== sdk);
    expect((await make(inner).snapshot(t.id)).thread.model).toBe("unsaved-model");
  });

  it("fails eventsSince while the store can't take the thread's events", async () => {
    const inner = new MemoryStore();
    let broken = false;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "appendEvents") {
          return async (id: string, events: ThreadEvent[]) => {
            if (broken) throw new Error("the disk is full");
            return target.appendEvents(id, events);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MemoryStore;
    const { sdk } = setup({ store, onError: () => {} });
    const t = await sdk.create();
    broken = true;
    await sdk.setOptions(t.id, { model: "other" });
    await expect(sdk.eventsSince(t.id, 0)).rejects.toThrow(/disk is full/);
    broken = false;
    expect((await sdk.eventsSince(t.id, 0)).map((e) => e.seq)).toEqual([1, 2]);
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

/** The values `flag` is given in `argv`, in order. */
const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag && i + 1 < argv.length ? [argv[i + 1]!] : []));

describe("a thread's launch options", () => {
  const first: LaunchOptions = {
    args: ["--allowedTools", "Read Edit", "--settings", '{"a":1}'],
    env: { AT_SET: "a b", AT_GONE: null },
    addDirs: ["/one", "/two"],
    configDir: "/profile-a",
  };

  it("start Claude with them, stored with the thread but not sent to clients, after setOptions changes them and after a restart", async () => {
    const store = fileStore();
    const { sdk, make, events, runs } = setup({
      store,
      claude: { args: ["--own"], configDir: "/instance-config" },
      env: { MINI_LOG_ENV: "AT_SET,AT_GONE,AT_KEPT", AT_KEPT: "kept", AT_GONE: "instance" },
    });
    const t = await sdk.create({ launch: first });
    expect(t).not.toHaveProperty("launch");
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    const run = runs()[0]!;
    expect(flagValues(run.argv, "--add-dir")).toEqual(["/one", "/two"]);
    // After the driver's arguments and the harness options'.
    expect(run.argv.slice(-5)).toEqual(["--own", "--allowedTools", "Read Edit", "--settings", '{"a":1}']);
    expect(run.configDir).toBe("/profile-a");
    expect(run.env).toEqual({ AT_SET: "a b", AT_GONE: null, AT_KEPT: "kept" });
    // Stored with the thread, as the other backends store them, and never sent to clients.
    expect(((await store.getThread(t.id)) as { launch?: unknown }).launch).toEqual({
      args: ["--allowedTools", "Read Edit", "--settings", '{"a":1}'],
      env: { AT_GONE: null, AT_SET: "a b" },
      add_dirs: ["/one", "/two"],
      config_dir: "/profile-a",
    });
    expect(events.some((e) => JSON.stringify(e).includes("profile-a"))).toBe(false);
    expect((await sdk.snapshot(t.id)).thread).not.toHaveProperty("launch");
    expect(await sdk.get(t.id)).not.toHaveProperty("launch");

    // Changed: the next turn's process has the new ones.
    const second: LaunchOptions = { args: ["--disallowedTools", "Bash"], env: { AT_SET: "b" }, addDirs: ["/three"], configDir: "/profile-b" };
    await sdk.setOptions(t.id, { launch: second });
    await sdk.send(t.id, "reply two");
    const s = await settle(sdk, t.id);
    expect(runs()).toHaveLength(2);
    const changed = runs()[1]!;
    expect(flagValues(changed.argv, "--add-dir")).toEqual(["/three"]);
    expect(changed.argv.slice(-2)).toEqual(["--disallowedTools", "Bash"]);
    expect(changed.argv).not.toContain("--allowedTools");
    expect(changed.configDir).toBe("/profile-b");
    expect(changed.env).toEqual({ AT_SET: "b", AT_GONE: "instance", AT_KEPT: "kept" });
    expect(((await store.getThread(t.id)) as { launch?: { config_dir?: string } }).launch?.config_dir).toBe("/profile-b");

    // A new backend on the same store resumes the thread with them; a client sees none of them.
    await sdk.close();
    open = open.filter((x) => x !== sdk);
    const again = make(store);
    expect(await again.get(t.id)).not.toHaveProperty("launch");
    expect((await again.list())[0]).not.toHaveProperty("launch");
    expect((await again.snapshot(t.id)).thread).not.toHaveProperty("launch");
    await again.send(t.id, "reply three");
    await settle(again, t.id);
    expect(runs()).toHaveLength(3);
    const resumed = runs()[2]!;
    expect(flagValues(resumed.argv, "--resume")).toEqual([s.thread.session_id]);
    expect(flagValues(resumed.argv, "--add-dir")).toEqual(["/three"]);
    expect(resumed.argv.slice(-2)).toEqual(["--disallowedTools", "Bash"]);
    expect(resumed.configDir).toBe("/profile-b");
    expect(resumed.env.AT_SET).toBe("b");
    expect(events.some((e) => JSON.stringify(e).includes("profile-b"))).toBe(false);
  });

  it("are changed by setOptions only when they're different, and never by the set_options command", async () => {
    const store = new MemoryStore();
    const { sdk, runs } = setup({ store });
    const t = await sdk.create({ launch: first });
    await sdk.send(t.id, "reply one");
    await settle(sdk, t.id);
    // The same ones, given in another order: nothing to change, so the process carries on.
    await sdk.setOptions(t.id, { launch: { configDir: "/profile-a", addDirs: ["/one", "/two"], env: { AT_GONE: null, AT_SET: "a b" }, args: first.args! } });
    // A client can't set them.
    await sdk.handle({ type: "set_options", thread_id: t.id, launch: { args: ["--evil"] } } as never);
    await sdk.send(t.id, "reply two");
    await settle(sdk, t.id);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.argv).not.toContain("--evil");
    expect(((await store.getThread(t.id)) as { launch?: { args?: string[] } }).launch?.args).toEqual(first.args);
    // Cleared: the next process has none of them, and the stored thread has no launch.
    await sdk.setOptions(t.id, { launch: {} });
    await sdk.send(t.id, "reply three");
    await settle(sdk, t.id);
    expect(runs()).toHaveLength(2);
    expect(runs()[1]!.argv).not.toContain("--add-dir");
    expect(runs()[1]!.configDir).toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(await store.getThread(t.id)).not.toHaveProperty("launch");
  });

  it.skipIf(process.platform === "win32")("start Claude under the shim with them too", async () => {
    const { sdk, runs } = setup({ spawner: shim(shimPath(), { runsDir: tempDir(), pollMs: 20 }), env: { MINI_LOG_ENV: "AT_SET" } });
    open = open.filter((x) => x !== sdk);
    try {
      const t = await sdk.create({ launch: { args: ["--settings", "{}"], env: { AT_SET: "x y" }, addDirs: ["/one"], configDir: "/profile" } });
      await sdk.send(t.id, "reply one");
      expect(texts((await settle(sdk, t.id)).items)).toEqual(["one"]);
      const run = runs()[0]!;
      expect(flagValues(run.argv, "--add-dir")).toEqual(["/one"]);
      expect(run.argv.slice(-2)).toEqual(["--settings", "{}"]);
      expect(run.configDir).toBe("/profile");
      expect(run.env).toEqual({ AT_SET: "x y" });
    } finally {
      await sdk.close({ stop: true });
    }
  });
});

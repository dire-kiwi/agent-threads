// Runs that survive a backend restart: a backend (backend.mjs, in a process of its own) runs a
// fixture's turn under the shim, and is killed with SIGKILL partway through it. A new backend
// recovers, and the thread finishes as if nothing had happened: the store has exactly the fixture's
// events (with a notice that the run was picked up again), none lost and none twice.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Command, Snapshot, ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { FileStore } from "../stores/file.js";
import { readJsonl, shimPath, specDir, tempDir } from "./spec.js";

const { compare } = (await import(pathToFileURL(join(specDir, "tools/check-events.mjs")).href)) as {
  compare: (expected: unknown[], actual: unknown[]) => { ok: true } | { ok: false; error: string };
};

const pkg = fileURLToPath(new URL("../../", import.meta.url));
const fakeCli = join(specDir, "tools/fake-cli.mjs");

/** A backend process, and what it has said. */
class Backend {
  readonly proc: ChildProcess;
  readonly events: ThreadEvent[] = [];
  #replies = new Map<number, (r: { result?: unknown; error?: string }) => void>();
  #next = 1;
  readonly exited: Promise<void>;

  constructor(env: { [k: string]: string }) {
    this.proc = spawn(process.execPath, [join(pkg, "src/test/backend.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    this.exited = new Promise((r) => this.proc.on("exit", () => r()));
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.event) this.events.push(msg.event);
      else this.#replies.get(msg.reply)?.(msg);
    });
  }

  async call<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
    const id = this.#next++;
    const reply = new Promise<{ result?: unknown; error?: string }>((r) => this.#replies.set(id, r));
    this.proc.stdin!.write(JSON.stringify({ id, op, args }) + "\n");
    const r = await reply;
    if (r.error) throw new Error(r.error);
    return r.result as T;
  }

  /** Waits for an event like `pattern` (field by field). */
  async waitFor(pattern: unknown, ms = 15_000): Promise<ThreadEvent> {
    const deadline = Date.now() + ms;
    for (;;) {
      const e = this.events.find((x) => matches(x, pattern));
      if (e) return e;
      if (Date.now() > deadline) throw new Error(`no event like ${JSON.stringify(pattern)}; got:\n${this.events.map((x) => JSON.stringify(x).slice(0, 200)).join("\n")}`);
      await sleep(10);
    }
  }

  /** Kills it as a crash would: no chance to save anything or stop anything. */
  async crash(): Promise<void> {
    this.proc.kill("SIGKILL");
    await this.exited;
  }
}

function matches(v: unknown, p: unknown): boolean {
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return !!v && typeof v === "object" && Object.entries(p).every(([k, x]) => matches((v as Record<string, unknown>)[k], x));
  }
  return JSON.stringify(v) === JSON.stringify(p);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

/** A fixture's scene: the directories and environment its backends share. */
function scene(fixture: string, extra: { [k: string]: string } = {}) {
  const dirs = { store: tempDir(), runs: tempDir(), state: tempDir(), cwd: tempDir() };
  const env = {
    STORE: dirs.store,
    RUNS: dirs.runs,
    SHIM: shimPath(),
    FAKE_CLI: fakeCli,
    AGENT_THREADS_FIXTURE: join(specDir, "fixtures", fixture),
    AGENT_THREADS_FIXTURE_STATE: dirs.state,
    ...extra,
  };
  const fixtureJson = JSON.parse(readFileSync(join(specDir, "fixtures", fixture, "fixture.json"), "utf8"));
  return { dirs, env, fixture: fixtureJson, start: () => new Backend(env) };
}

/** The store's events for the thread, read once the backends are done. */
async function savedEvents(storeDir: string, threadId: string): Promise<ThreadEvent[]> {
  const store = new FileStore(storeDir);
  try {
    return await store.readEvents(threadId);
  } finally {
    await store.close();
  }
}

/**
 * Checks the saved events are the fixture's expected events (without deltas, which aren't saved),
 * plus the notices that the run was picked up again, and that the fake CLI got what it should.
 */
function checkThread(fixture: string, saved: ThreadEvent[], stateDir: string, reattached: number): void {
  const notices = saved.filter((e) => e.type === "item.added" && e.item.type === "notice" && e.item.code === "run.reattached");
  expect(notices).toHaveLength(reattached);
  // Without them, renumbered, the events must be exactly the fixture's.
  let seq = 0;
  const rest = saved.filter((e) => !notices.includes(e)).map((e) => ({ ...e, seq: ++seq }));
  const expected = readJsonl(`fixtures/${fixture}/expected.jsonl`).filter((e) => (e as ThreadEvent).type !== "delta");
  const r = compare(expected, rest);
  if (!r.ok) expect.fail(`${r.error}\n\nSaved events:\n${saved.map((e) => JSON.stringify(e).slice(0, 300)).join("\n")}`);
  const reports = readdirSync(stateDir).filter((f) => /^run-\d+\.json$/.test(f));
  expect(reports).toEqual(["run-1.json"]);
  expect(JSON.parse(readFileSync(join(stateDir, "run-1.json"), "utf8"))).toMatchObject({ ok: true });
}

describe.skipIf(process.platform === "win32")("a backend restart", () => {
  beforeAll(() => {
    // The backend process runs the built package: build it as it is now.
    execFileSync(join(pkg, "../../node_modules/.bin/tsc"), ["-p", join(pkg, "tsconfig.build.json")], { stdio: "inherit" });
    shimPath();
  }, 120_000);

  it("while the turn waits on the user: the request is still open after, and answering it finishes the turn", { timeout: 60_000 }, async () => {
    const s = scene("claude/permission-allow", { POLICY: "ask" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
    await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
    await a.waitFor({ type: "request.opened" });
    await a.crash();

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    const snap = await b.call<Snapshot>("snapshot", thread.id);
    expect(snap.thread.status).toBe("waiting");
    expect(snap.thread.run?.reattached_at).toBeDefined();
    expect(snap.requests).toHaveLength(1);
    await b.call("handle", { type: "respond", thread_id: thread.id, request_id: snap.requests[0]!.id, resolution: { outcome: "allow" } } satisfies Command);
    await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
    await b.call("close", { stop: true });
    await b.exited;

    checkThread("claude/permission-allow", await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
  });

  it("while output streams in: the new backend carries on reading from where the last left off", { timeout: 60_000 }, async () => {
    // Replayed at a fifth of the recorded pace, so the backend is killed partway through the turn.
    const s = scene("claude/tool-calls", { AGENT_THREADS_FIXTURE_SPEED: "0.2" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
    await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
    // The first of its three tool calls; text streams in after it.
    await a.waitFor({ type: "item.added", item: { type: "tool_call" } });
    await sleep(100);
    await a.crash();

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    // The rest of the turn includes a permission the policy answers.
    await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
    await b.call("close", { stop: true });
    await b.exited;

    checkThread("claude/tool-calls", await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
  });

  it("when the run ends while it's down: the new backend reads the rest and finishes the turn", { timeout: 60_000 }, async () => {
    const s = scene("claude/subagent", { AGENT_THREADS_FIXTURE_SPEED: "0.2" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
    await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
    await a.waitFor({ type: "item.added", item: { type: "tool_call" } });
    await a.crash();

    // While it's down, the turn finishes and the run ends (its input closed, as a backend would).
    const [runId] = readdirSync(s.dirs.runs);
    const runDir = join(s.dirs.runs, runId!);
    await until(() => readFileSync(join(runDir, "out.jsonl"), "utf8").includes('"type":"result"'));
    writeFileSync(join(runDir, "input.closed"), "");
    await until(() => existsSync(join(runDir, "exit")));

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
    // The run's over, and the backend is done with it.
    await until(() => b.events.some((e) => e.type === "thread.updated" && e.thread.status === "idle" && !e.thread.run));
    await b.call("close");
    await b.exited;

    checkThread("claude/subagent", await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
    const store = new FileStore(s.dirs.store);
    expect(await store.activeRuns()).toEqual([]);
    expect((await store.getRun(runId!))?.offset).toBe(readFileSync(join(runDir, "out.jsonl")).length);
    await store.close();
  });

  it("when it's shut down: close() leaves the run going, and recover() picks it up again", { timeout: 60_000 }, async () => {
    const s = scene("claude/permission-allow", { POLICY: "ask" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
    await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
    await a.waitFor({ type: "request.opened" });
    await a.call("close");
    await a.exited;

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    const snap = await b.call<Snapshot>("snapshot", thread.id);
    await b.call("handle", { type: "respond", thread_id: thread.id, request_id: snap.requests[0]!.id, resolution: { outcome: "allow" } } satisfies Command);
    await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
    await b.call("close", { stop: true });
    await b.exited;

    checkThread("claude/permission-allow", await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
  });
});

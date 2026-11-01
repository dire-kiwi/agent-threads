// Runs that survive a backend restart: a backend (backend.mjs, in a process of its own) runs a
// fixture's turn under the shim, and is killed with SIGKILL partway through it. A new backend
// recovers, and the thread finishes as if nothing had happened: the store has exactly the fixture's
// events (with a notice that the run was picked up again), none lost and none twice.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { applyEvents, initialState, type Command, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { FileStore } from "../stores/file.js";
import { shim } from "../shim.js";
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
    CODEX_HOME_DIR: tempDir(),
    SHIM: shimPath(),
    FAKE_CLI: fakeCli,
    AGENT_THREADS_FIXTURE: join(specDir, "fixtures", fixture),
    AGENT_THREADS_FIXTURE_STATE: dirs.state,
    ...extra,
  };
  const fixtureJson = JSON.parse(readFileSync(join(specDir, "fixtures", fixture, "fixture.json"), "utf8"));
  // The fixture's permission policy, unless the test says.
  const all = { POLICY: fixtureJson.permissions ?? "allow", ...env };
  return { dirs, env: all, fixture: fixtureJson, start: () => new Backend(all) };
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

  // The same with each harness: a fixture whose turn waits on the user, one that streams (with
  // approvals the policy answers), and one that needs no input after it starts, which can end
  // while the backend is down; and what marks its end in its output.
  const harnesses = {
    claude: { waits: "claude/permission-allow", streams: "claude/tool-calls", ends: "claude/subagent", partway: { type: "item.added", item: { type: "tool_call" } }, ended: '"type":"result"' },
    codex: { waits: "codex/permission-allow", streams: "codex/tool-calls", ends: "codex/plain-reply", partway: { type: "delta" }, ended: '"method":"turn/completed"' },
  };

  describe.each(Object.entries(harnesses))("with %s", (_harness, f) => {
    it("while the turn waits on the user: the request is still open after, and answering it finishes the turn", { timeout: 60_000 }, async () => {
      const s = scene(f.waits);
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

      checkThread(f.waits, await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
    });

    it("while output streams in: the new backend carries on reading from where the last left off", { timeout: 60_000 }, async () => {
      // Replayed at a fifth of the recorded pace, so the backend is killed partway through the turn.
      const s = scene(f.streams, { AGENT_THREADS_FIXTURE_SPEED: "0.2" });
      const a = s.start();
      const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
      await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
      // The first of its tool calls; more comes after it.
      await a.waitFor({ type: "item.added", item: { type: "tool_call" } });
      await sleep(100);
      await a.crash();

      const b = s.start();
      expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
      // The rest of the turn includes approvals the policy answers.
      await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
      await b.call("close", { stop: true });
      await b.exited;

      checkThread(f.streams, await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
    });

    it("when the run ends while it's down: the new backend reads the rest and finishes the turn", { timeout: 60_000 }, async () => {
      const s = scene(f.ends, { AGENT_THREADS_FIXTURE_SPEED: "0.2" });
      const a = s.start();
      const thread = await a.call<{ id: string }>("create", { ...s.fixture.thread, cwd: s.dirs.cwd });
      await a.call("handle", { ...s.fixture.steps[0].command, thread_id: thread.id });
      // Partway through the turn.
      await a.waitFor(f.partway);
      await a.crash();

      // While it's down, the turn finishes and the run ends (its input closed, as a backend would).
      const [runId] = readdirSync(s.dirs.runs);
      const runDir = join(s.dirs.runs, runId!);
      expect(readFileSync(join(runDir, "out.jsonl"), "utf8")).not.toContain(f.ended);
      await until(() => readFileSync(join(runDir, "out.jsonl"), "utf8").includes(f.ended));
      writeFileSync(join(runDir, "input.closed"), "");
      await until(() => existsSync(join(runDir, "exit")));

      const b = s.start();
      expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
      await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
      // The run's over, and the backend is done with it.
      await until(() => b.events.some((e) => e.type === "thread.updated" && e.thread.status === "idle" && !e.thread.run));
      await b.call("close");
      await b.exited;

      checkThread(f.ends, await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
      const store = new FileStore(s.dirs.store);
      expect(await store.activeRuns()).toEqual([]);
      expect((await store.getRun(runId!))?.offset).toBe(readFileSync(join(runDir, "out.jsonl")).length);
      await store.close();
    });

    it("when it's shut down: close() leaves the run going, and recover() picks it up again", { timeout: 60_000 }, async () => {
      const s = scene(f.waits);
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

      checkThread(f.waits, await savedEvents(s.dirs.store, thread.id), s.dirs.state, 1);
    });
  });

  // With mini-claude.mjs as Claude (and mini-codex.mjs as Codex), for what the recordings don't cover.
  const mini = (extra: { [k: string]: string } = {}) => {
    const log = join(tempDir(), "log.jsonl");
    return {
      ...scene("claude/plain-reply", { CLAUDE_BIN: join(pkg, "src/test/mini-claude.mjs"), CODEX_BIN: join(pkg, "src/test/mini-codex.mjs"), MINI_CLAUDE_LOG: log, ...extra }),
      log,
    };
  };

  it.each([
    ["claude", "died"],
    ["codex", "died"],
    ["claude", "shut down"],
    ["codex", "shut down"],
  ])("with %s, doesn't run an app tool again that was running when the backend %s", { timeout: 60_000 }, async (harness, how) => {
    const marker = join(tempDir(), "marker");
    const s = mini({ TOOL_MARKER: marker, TOOL_HANG: "1", MINI_CLAUDE_TOOL_DELAY: "300", MINI_CODEX_TOOL_DELAY: "300" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { harness, cwd: s.dirs.cwd });
    await a.call("handle", { type: "send", thread_id: thread.id, text: "app lookup {}" } satisfies Command);
    // It has done what it does, and hasn't returned.
    await until(() => existsSync(marker));
    if (how === "died") await a.crash();
    else {
      // Shutting down aborts it, which it returns on: it isn't answered, but left for the next.
      await a.call("close");
      await a.exited;
    }

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    await b.waitFor({ type: "thread.updated", thread: { status: "idle" } });
    const snap = await b.call<Snapshot>("snapshot", thread.id);
    await b.call("close", { stop: true });
    await b.exited;
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    // The agent was told it may have finished.
    const said = snap.items.filter((i) => i.type === "assistant_message").map((i) => (i.type === "assistant_message" ? i.text : ""));
    expect(said.join("\n")).toMatch(/may or may not have finished/);
  });

  it("keeps the text streamed before it died, also when the run ends while it's down before finishing its message", { timeout: 60_000 }, async () => {
    const s = mini();
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { harness: "claude", cwd: s.dirs.cwd });
    await a.call("handle", { type: "send", thread_id: thread.id, text: "streamhang the streamed words" } satisfies Command);
    const text = () => a.events.filter((e) => e.type === "delta").map((e) => (e.type === "delta" ? e.text : "")).join("");
    await until(() => text() === "the streamed words ");
    // The item, and the offset past all its deltas, are saved.
    await a.call("saved", thread.id);
    await a.crash();

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    const snap = await b.call<Snapshot>("snapshot", thread.id);
    expect(snap.items.find((i) => i.type === "assistant_message")).toMatchObject({ text: "the streamed words " });
    await b.call("close");
    await b.exited;

    // The run ends while nothing follows it, without the final message: what streamed is kept.
    const [runId] = readdirSync(s.dirs.runs);
    writeFileSync(join(s.dirs.runs, runId!, "input.closed"), "");
    await until(() => existsSync(join(s.dirs.runs, runId!, "exit")));
    const c = s.start();
    await c.call("recover");
    await c.waitFor({ type: "turn.completed" });
    await c.call("close");
    await c.exited;
    const saved = await savedEvents(s.dirs.store, thread.id);
    const first = saved[0]!;
    const final = applyEvents(initialState(first.type === "thread.updated" ? first.thread : ({} as never)), saved);
    expect(final.items.find((i) => i.type === "assistant_message")).toMatchObject({ text: "the streamed words " });
  });

  it("starts a new process for the next turn after a restart if the options changed, as it would have", { timeout: 60_000 }, async () => {
    const s = mini();
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { harness: "claude", model: "old", cwd: s.dirs.cwd });
    await a.call("handle", { type: "send", thread_id: thread.id, text: "reply one" } satisfies Command);
    await a.waitFor({ type: "turn.completed" });
    await a.call("handle", { type: "set_options", thread_id: thread.id, model: "new" } satisfies Command);
    await a.waitFor({ type: "thread.updated", thread: { model: "new" } });
    await a.call("saved", thread.id);
    await a.crash();

    const b = s.start();
    await b.call("recover");
    await b.call("handle", { type: "send", thread_id: thread.id, text: "reply two" } satisfies Command);
    await until(() => b.events.filter((e) => e.type === "turn.completed").length === 1);
    await b.call("close", { stop: true });
    await b.exited;
    const argvs = readFileSync(s.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.argv).map((l) => l.argv as string[]);
    expect(argvs.map((v) => v[v.indexOf("--model") + 1])).toEqual(["old", "new"]);
  });

  it("carries on stopping a run's process group after the backend that was stopping it exits, or is killed", { timeout: 60_000 }, async () => {
    const runsDir = tempDir();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // A backend stops a run whose program exits at SIGTERM, leaving a child that ignores it; then
    // the backend goes, before the SIGKILL is due: exiting (`exit`), or killed (`kill`).
    const stopThenGo = (runId: string, how: "exit" | "kill") => {
      const script = `
        import { shim } from ${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)};
        const spawner = shim(${JSON.stringify(shimPath())}, { runsDir: ${JSON.stringify(runsDir)}, killGraceMs: 1000, pollMs: 20 });
        const proc = spawner.spawn({ command: "sh", args: ["-c", \`sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait\`], threadId: "th", runId: ${JSON.stringify(runId)} }, {
          line: (l) => {
            console.log(l);
            proc.kill("SIGTERM");
          },
          stderr: () => {},
          exit: () => ${how === "kill" ? "process.kill(process.pid, 'SIGKILL')" : "proc.detach()"},
        });`;
      return new Promise<{ child: number; at: number }>((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
        let child = 0;
        p.stdout!.on("data", (d) => (child ||= Number(String(d).trim())));
        p.on("exit", () => (child ? resolve({ child, at: Date.now() }) : reject(new Error("no child"))));
      });
    };

    // Exiting, it waits for the SIGKILL first.
    const started = Date.now();
    const exited = await stopThenGo("run_exit", "exit");
    expect(exited.at - started).toBeGreaterThan(900);
    expect(alive(exited.child)).toBe(false);

    // Killed, the next backend does it, though the run has exited and the store has it as ended.
    const killed = await stopThenGo("run_kill", "kill");
    expect(existsSync(join(runsDir, "run_kill", "exit"))).toBe(true);
    expect(alive(killed.child)).toBe(true);
    const store = new FileStore(tempDir());
    await shim(shimPath(), { runsDir, killGraceMs: 1000 }).prune!(store);
    await until(() => !alive(killed.child), 5000);
    expect(existsSync(join(runsDir, "run_kill", "stopping"))).toBe(false);
    await store.close();
  });

  it("with Codex, serves the app's tools where Codex was told they are after two restarts in a row", { timeout: 60_000 }, async () => {
    // Without dynamic tools, so the app's tools are on the loopback MCP server.
    const marker = join(tempDir(), "marker");
    const s = mini({ TOOL_MARKER: marker, MINI_CODEX_NO_DYNAMIC: "1" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { harness: "codex", cwd: s.dirs.cwd });
    await a.call("handle", { type: "send", thread_id: thread.id, text: "reply hi" } satisfies Command);
    await a.waitFor({ type: "turn.completed" });
    await a.call("saved", thread.id);
    await a.crash();

    // The next backend can't serve them where they were (the port's taken meanwhile), and is
    // killed before it's served them again: what's saved must still say where they are.
    const store = new FileStore(s.dirs.store);
    const [runId] = readdirSync(s.dirs.runs);
    const { port } = ((await store.getRun(runId!))!.data as { state: { mcp: { port: number } } }).state.mcp;
    await store.close();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    await until(() => b.events.some((e) => e.type === "item.added" && e.item.type === "notice" && /aren't available/.test(e.item.text)));
    await b.call("saved", thread.id);
    await b.crash();
    await new Promise((r) => blocker.close(r));

    const c = s.start();
    expect(await c.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    await c.call("handle", { type: "send", thread_id: thread.id, text: "app lookup {}" } satisfies Command);
    await c.waitFor({ type: "turn.completed" });
    const snap = await c.call<Snapshot>("snapshot", thread.id);
    await c.call("close", { stop: true });
    await c.exited;
    const said = snap.items.map((i) => (i.type === "assistant_message" ? i.text : "")).join("\n");
    expect(said).toMatch(/app said found it/);
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
  });

  it("doesn't send a message again that it sent before it died, though what led it to is read again", { timeout: 60_000 }, async () => {
    // Claude says nothing about the message for a while after it's sent, so nothing's saved after
    // it: the checkpoint is from before Claude answered initialize, which is what sends it.
    const s = mini({ MINI_CLAUDE_START_DELAY: "1500" });
    const a = s.start();
    const thread = await a.call<{ id: string }>("create", { harness: "claude", cwd: s.dirs.cwd });
    await a.call("handle", { type: "send", thread_id: thread.id, text: "reply hello" } satisfies Command);
    const input = () => {
      const [runId] = readdirSync(s.dirs.runs);
      return runId ? readFileSync(join(s.dirs.runs, runId, "input.jsonl"), "utf8") : "";
    };
    await until(() => input().includes("reply hello"));
    await a.crash();

    const b = s.start();
    expect(await b.call("recover")).toEqual({ reattached: [thread.id], lost: [] });
    await b.waitFor({ type: "turn.completed" });
    await sleep(300);
    const snap = await b.call<Snapshot>("snapshot", thread.id);
    await b.call("close", { stop: true });
    await b.exited;
    // Sent once, and answered once.
    expect(input().split("reply hello").length - 1).toBe(1);
    const sent = readFileSync(s.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user");
    expect(sent).toHaveLength(1);
    expect(snap.items.filter((i) => i.type === "turn_result")).toHaveLength(1);
    expect(snap.items.filter((i) => i.type === "assistant_message").map((i) => (i.type === "assistant_message" ? i.text : ""))).toEqual(["hello"]);
  });
});

// The spawners: lines out, exit after the last one, and stopping everything a process started;
// and for the shim, reading whole lines from an offset, re-attaching, and noticing a run that's gone.

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { identityForTests, shim, type ShimOptions } from "../shim.js";
import { direct, type ExitStatus, type HarnessProcess, type Spawner } from "../spawner.js";
import { MemoryStore } from "../stores/memory.js";
import { shimPath, tempDir } from "./spec.js";

function spawn(script: string) {
  const lines: string[] = [];
  let exited: ExitStatus | undefined;
  const proc = direct().spawn(
    { command: "sh", args: ["-c", script], threadId: "th", runId: "run" },
    { line: (l) => lines.push(l), stderr: () => {}, exit: (s) => (exited = s) },
  );
  return { proc, lines, exit: () => exited };
}

const wait = async (what: () => unknown, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

describe.skipIf(process.platform === "win32")("direct()", () => {
  it("passes lines through, and says how it exited after the last", async () => {
    const p = spawn("read x; echo got $x; echo bye; exit 3");
    p.proc.write("hi");
    expect(await wait(p.exit)).toBe(true);
    expect(p.lines).toEqual(["got hi", "bye"]);
    expect(p.exit()).toMatchObject({ code: 3 });
  });

  it("stops what a process started, after the process itself has exited", async () => {
    // The shell exits at once, leaving a sleep that holds its stdout open.
    const p = spawn("sleep 30 & echo started");
    expect(await wait(() => p.lines.length)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(p.exit()).toBeUndefined();
    p.proc.kill("SIGKILL");
    expect(await wait(p.exit)).toBe(true);
  });
});

/** A process of the shim spawner's (or one it re-attached to), and what it has said. */
function follow(start: (h: Parameters<Spawner["spawn"]>[1]) => HarnessProcess) {
  const lines: string[] = [];
  const stderr: string[] = [];
  let exited: ExitStatus | undefined;
  const proc = start({ line: (l) => lines.push(l), stderr: (l) => stderr.push(l), exit: (s) => (exited = s) });
  return { proc, lines, stderr, exit: () => exited };
}

describe.skipIf(process.platform === "win32")("shim()", () => {
  const setup = () => {
    const runsDir = tempDir();
    const spawner = shim(shimPath(), { runsDir, pollMs: 20, killGraceMs: 500 });
    const run = (script: string, runId = "run_1") =>
      follow((h) => spawner.spawn({ command: "sh", args: ["-c", script], threadId: "th", runId }, h));
    return { runsDir, spawner, run };
  };

  it("passes whole lines through, with the offset after each, and says how it exited after the last", async () => {
    const { runsDir, run } = setup();
    // The last line has no newline: it counts once the run is over.
    const p = run("read x; echo got $x; printf 'part'; sleep 0.3; printf 'ial\\nlast'; echo oops >&2; exit 3");
    p.proc.write("hi");
    expect(await wait(() => p.lines.length === 1)).toBe(true);
    expect(p.lines).toEqual(["got hi"]);
    await new Promise((r) => setTimeout(r, 150));
    // Half a line isn't given, nor counted.
    expect(p.lines).toEqual(["got hi"]);
    expect(p.proc.offset).toBe("got hi\n".length);
    expect(await wait(p.exit)).toBe(true);
    expect(p.lines).toEqual(["got hi", "partial", "last"]);
    expect(p.stderr).toEqual(["oops"]);
    expect(p.exit()).toMatchObject({ code: 3, signal: null });
    expect(p.proc.offset).toBe(readFileSync(join(runsDir, "run_1", "out.jsonl")).length);
    expect(JSON.parse(readFileSync(join(runsDir, "run_1", "run.json"), "utf8"))).toMatchObject({ format: 1, run_id: "run_1", thread_id: "th", command: "sh" });
  });

  it("re-attaches from an offset, and leaves a run going when it detaches", async () => {
    const { spawner, run } = setup();
    const a = run("while read -r x; do echo \"got $x\"; done; echo bye");
    a.proc.write("one");
    expect(await wait(() => a.lines.length === 1)).toBe(true);
    const offset = a.proc.offset!;
    a.proc.write("two");
    a.proc.detach!();
    // What it says while nothing follows it is read by what re-attaches.
    await new Promise((r) => setTimeout(r, 200));
    expect(a.lines).toEqual(["got one"]);
    const b = follow((h) => spawner.attach!({ id: "run_1", thread_id: "th", spawner: "shim", offset, started_at: "" }, h));
    expect(await wait(() => b.lines.length === 1)).toBe(true);
    expect(b.lines).toEqual(["got two"]);
    b.proc.write("three");
    b.proc.closeInput();
    expect(await wait(b.exit)).toBe(true);
    expect(b.lines).toEqual(["got two", "got three", "bye"]);
    expect(b.exit()).toMatchObject({ code: 0 });
    expect(a.exit()).toBeUndefined();
  });

  it("stops the run's whole process group", async () => {
    const { runsDir, run } = setup();
    const p = run("sleep 30 & echo $!; wait");
    expect(await wait(() => p.lines.length === 1)).toBe(true);
    const sleeper = Number(p.lines[0]);
    p.proc.kill("SIGTERM");
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()).toMatchObject({ code: null, signal: "SIGTERM" });
    expect(await wait(() => !alive(sleeper))).toBe(true);
    expect(readdirSync(join(runsDir, "run_1"))).toContain("exit");
  });

  it("signals a run it's stopped before the shim has started it, once it has", async () => {
    const { run } = setup();
    const p = run("sleep 30");
    p.proc.kill("SIGKILL");
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()).toMatchObject({ signal: "SIGKILL" });
  });

  it("notices a shim that went away without saying how its run ended", async () => {
    const { runsDir, run } = setup();
    const p = run("echo started; exec sleep 30");
    expect(await wait(() => p.lines.length === 1)).toBe(true);
    const dir = join(runsDir, "run_1");
    process.kill(Number(readFileSync(join(dir, "shim.pid"), "utf8")), "SIGKILL");
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()?.error?.message).toMatch(/agent-threads-shim\) went away/);
    expect(JSON.parse(readFileSync(join(dir, "exit"), "utf8"))).toMatchObject({ code: null, error: expect.stringMatching(/went away/) });
    // With nothing left to stop it, the program it ran is stopped.
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(await wait(() => !alive(pid))).toBe(true);
  });

  it("stops what's left of the group after the program exits, with SIGKILL for what ignores SIGTERM", async () => {
    const { run } = setup();
    // The child says its pid once it ignores SIGTERM.
    const p = run(`sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait`);
    expect(await wait(() => p.lines.length === 1)).toBe(true);
    const stubborn = Number(p.lines[0]);
    p.proc.kill("SIGTERM");
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()).toMatchObject({ signal: "SIGTERM" });
    expect(alive(stubborn)).toBe(true);
    expect(await wait(() => !alive(stubborn))).toBe(true);
  });

  it("stops a run nothing follows once the shim has started it, though it hadn't when it was asked to", async () => {
    const { runsDir, spawner, run } = setup();
    const p = run("sleep 30");
    p.proc.detach!();
    spawner.stop!({ id: "run_1", thread_id: "th", spawner: "shim", offset: 0, started_at: "" });
    const dir = join(runsDir, "run_1");
    expect(await wait(() => existsSync(join(dir, "exit")))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "exit"), "utf8"))).toMatchObject({ signal: 15 });
  });

  it("never signals a process that only has the run's old pid", async () => {
    const { runsDir, spawner } = setup();
    // An unrelated process, leading a group of its own, with the pid a dead run recorded.
    const other = spawnChild("sleep", ["30"], { detached: true, stdio: "ignore" });
    const dir = join(runsDir, "stale");
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(other.pid));
    writeFileSync(join(dir, "shim.pid"), "999999999");
    const record = { id: "stale", thread_id: "th", spawner: "shim", offset: 0, started_at: "", data: { dir } };
    try {
      // Recorded before that process started (the pid was given to it after the run's was gone),
      // and before the machine last started.
      for (const ago of [60, uptime() + 3600]) {
        const at = new Date(Date.now() - ago * 1000);
        utimesSync(join(dir, "pid"), at, at);
        rmSync(join(dir, "exit"), { force: true });
        spawner.stop!(record);
        const p = follow((h) => spawner.attach!(record, h));
        expect(await wait(p.exit)).toBe(true);
        p.proc.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 700)); // past the kill grace
        expect(alive(other.pid!)).toBe(true);
      }
      // With its shim gone, it's recorded as over.
      expect(JSON.parse(readFileSync(join(dir, "exit"), "utf8"))).toMatchObject({ error: expect.stringMatching(/went away/) });
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("never signals a group that only has the run's old id, though its leader has gone", async () => {
    const { runsDir, spawner } = setup();
    const dir = join(runsDir, "reused");
    mkdirSync(dir);
    // Recorded a minute ago, by a run whose program is long gone.
    writeFileSync(join(dir, "pid"), "1");
    writeFileSync(join(dir, "shim.pid"), "999999999");
    const ago = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "pid"), ago, ago);
    // Since then the id went to another group, whose leader has gone and left a child.
    const other = spawnChild("sh", ["-c", "sleep 30 & echo $!; exec sleep 0.2"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const child = Number(await new Promise<string>((r) => other.stdout!.once("data", (d) => r(String(d)))));
    await new Promise((r) => other.once("exit", r));
    writeFileSync(join(dir, "pid"), String(other.pid));
    utimesSync(join(dir, "pid"), ago, ago);
    try {
      expect(alive(other.pid!)).toBe(false);
      expect(alive(child)).toBe(true);
      spawner.stop!({ id: "reused", thread_id: "th", spawner: "shim", offset: 0, started_at: "", data: { dir } });
      await new Promise((r) => setTimeout(r, 700)); // past the kill grace
      expect(alive(child)).toBe(true);
    } finally {
      process.kill(child, "SIGKILL");
    }
  });

  it("takes a shim whose pid has gone to another process for gone", async () => {
    const { runsDir, spawner } = setup();
    const dir = join(runsDir, "reused-shim");
    mkdirSync(dir);
    // The shim's pid, recorded a minute ago, is now another process's.
    const other = spawnChild("sleep", ["30"], { detached: true, stdio: "ignore" });
    writeFileSync(join(dir, "shim.pid"), String(other.pid));
    const ago = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "shim.pid"), ago, ago);
    try {
      const p = follow((h) => spawner.attach!({ id: "reused-shim", thread_id: "th", spawner: "shim", offset: 0, started_at: "", data: { dir } }, h));
      expect(await wait(p.exit)).toBe(true);
      expect(p.exit()?.error?.message).toMatch(/went away/);
      expect(alive(other.pid!)).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("takes a shim whose pid goes to another process after it was checked for gone, at the next look", async () => {
    const { runsDir, run } = setup();
    const p = run("echo started; exec sleep 30", "reused-later");
    const dir = join(runsDir, "reused-later");
    expect(await wait(() => p.lines.length === 1)).toBe(true);
    const shimPid = Number(readFileSync(join(dir, "shim.pid"), "utf8"));
    // The shim's checked (and found to be the run's) at least once.
    let checked = 0;
    let reused = false;
    identityForTests.startTime = (pid, real) => {
      if (pid !== shimPid) return real(pid);
      checked++;
      // Then its pid is another process's: one that started after shim.pid was written.
      return reused ? Date.now() : real(pid);
    };
    try {
      expect(await wait(() => checked > 0)).toBe(true);
      expect(p.exit()).toBeUndefined();
      reused = true;
      expect(await wait(p.exit)).toBe(true);
      // Taken for gone, the run ended, and its program (which would have run for 30s) was stopped.
      // (The test's shim is really still there, and records the SIGTERM over the backend's exit.)
      const exit = p.exit()!;
      expect(exit.error?.message.match(/went away/) ?? exit.signal).toBeTruthy();
      expect(exit.code).toBeNull();
    } finally {
      identityForTests.startTime = undefined;
      // Stopped already, with its shim gone; in case it isn't.
      for (const pid of [-Number(readFileSync(join(dir, "pid"), "utf8")), shimPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    }
  });

  it("follows runs to their end when a process's start can't be told (no /proc, no ps)", async () => {
    const path = process.env.PATH;
    identityForTests.noProc = true;
    // No ps on the PATH the backend looks in; the run itself has the usual one.
    process.env.PATH = tempDir();
    try {
      const p = follow((h) =>
        shim(shimPath(), { runsDir: tempDir(), pollMs: 20 }).spawn({ command: "/bin/sh", args: ["-c", "echo hi; sleep 2.5; echo bye"], env: { PATH: path }, threadId: "th", runId: "nops" }, h),
      );
      expect(await wait(p.exit, 10_000)).toBe(true);
      expect(p.exit()).toMatchObject({ code: 0 });
      expect(p.exit()?.error).toBeUndefined();
      expect(p.lines).toEqual(["hi", "bye"]);
    } finally {
      process.env.PATH = path;
      identityForTests.noProc = false;
    }
  });

  it.skipIf(process.platform !== "linux").each([
    [false, true],
    [true, false],
  ])("doesn't take a shim for gone when its start is read another way than when it was checked (without /proc: %s, then %s)", { timeout: 20_000 }, async (before, after) => {
    const { run } = setup();
    identityForTests.noProc = before;
    const p = run("echo started; exec sleep 30", "switch");
    try {
      expect(await wait(() => p.lines.length === 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 1200)); // checked, and found to be the run's
      // /proc has the start to the clock tick, and ps to the second: they don't agree.
      identityForTests.noProc = after;
      await new Promise((r) => setTimeout(r, 2500)); // checked again, twice
      expect(p.exit()).toBeUndefined();
    } finally {
      identityForTests.noProc = false;
      p.proc.kill("SIGKILL");
      await wait(p.exit);
    }
  });

  // A shim nothing reaps, after it's killed: its parent is a subreaper that doesn't wait for it.
  const python = (() => {
    try {
      execFileSync("python3", ["-c", "import ctypes"], { stdio: "ignore" });
      return process.platform === "linux";
    } catch {
      return false;
    }
  })();
  it.skipIf(!python).each([["/proc"], ["ps"]])("takes a shim that has exited but isn't reaped for gone (from %s)", { timeout: 20_000 }, async (from) => {
    const runsDir = tempDir();
    const dir = join(runsDir, "zombie");
    mkdirSync(dir);
    const script = [
      "import ctypes, subprocess, sys, time",
      "ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)",
      `subprocess.Popen([${JSON.stringify(shimPath())}, ${JSON.stringify(dir)}, "--", "sleep", "30"]).wait()`,
      "time.sleep(60)",
    ].join("\n");
    const parent = spawnChild("python3", ["-c", script], { stdio: "ignore" });
    identityForTests.noProc = from === "ps";
    try {
      expect(await wait(() => existsSync(join(dir, "pid")))).toBe(true);
      const spawner = shim(shimPath(), { runsDir, pollMs: 20, killGraceMs: 500 });
      const p = follow((h) => spawner.attach!({ id: "zombie", thread_id: "th", spawner: "shim", offset: 0, started_at: "", data: { dir } }, h));
      await new Promise((r) => setTimeout(r, 1200)); // checked, and found to be the run's
      expect(p.exit()).toBeUndefined();
      const shimPid = Number(readFileSync(join(dir, "shim.pid"), "utf8"));
      const program = Number(readFileSync(join(dir, "pid"), "utf8"));
      process.kill(shimPid, "SIGKILL");
      expect(await wait(() => readFileSync(`/proc/${shimPid}/stat`, "utf8").split(") ")[1]!.startsWith("Z"))).toBe(true);
      expect(await wait(p.exit)).toBe(true);
      expect(p.exit()?.error?.message).toMatch(/went away/);
      // And the program it ran is stopped (and left unreaped too, by the same subreaper).
      const over = () => {
        try {
          return /^[ZX]/.test(readFileSync(`/proc/${program}/stat`, "utf8").split(") ")[1]!);
        } catch {
          return true;
        }
      };
      expect(await wait(over)).toBe(true);
    } finally {
      identityForTests.noProc = false;
      parent.kill("SIGKILL");
    }
  });

  it("stops what an orphan ran when its shim is gone too, and keeps its directory until then", { timeout: 20_000 }, async () => {
    const { runsDir, spawner, run } = setup();
    const store = new MemoryStore();
    await store.createThread({ id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" });
    // A run its backend gave up on as it died, whose shim has gone since, leaving what it ran.
    const p = run("sleep 30", "orphan2");
    const dir = join(runsDir, "orphan2");
    expect(await wait(() => existsSync(join(dir, "pid")))).toBe(true);
    p.proc.detach!();
    await store.putRun({ id: "orphan2", thread_id: "th", spawner: "shim", offset: 0, started_at: "2026-11-01T00:00:00Z", ended_at: new Date().toISOString() });
    const program = Number(readFileSync(join(dir, "pid"), "utf8"));
    process.kill(Number(readFileSync(join(dir, "shim.pid"), "utf8")), "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(program)).toBe(true);

    await spawner.prune!(store);
    expect(await wait(() => !alive(program))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "exit"), "utf8"))).toMatchObject({ error: expect.stringMatching(/went away/) });
  });

  it("needs a runs directory of the store's own", () => {
    expect(() => shim(shimPath(), {} as ShimOptions)).toThrow(/runsDir/);
  });

  it("resolves the runs directory and the shim's path against the backend's working directory", async () => {
    const runsDir = tempDir();
    const spawner = shim(relative(process.cwd(), shimPath()), { runsDir: relative(process.cwd(), runsDir), pollMs: 20 });
    // The thread runs elsewhere.
    const p = follow((h) => spawner.spawn({ command: "sh", args: ["-c", "pwd"], cwd: tempDir(), threadId: "th", runId: "rel" }, h));
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()).toMatchObject({ code: 0 });
    expect(p.lines).toHaveLength(1);
    expect(existsSync(join(runsDir, "rel", "out.jsonl"))).toBe(true);
  });

  it("says why a run couldn't be started", async () => {
    const runsDir = tempDir();
    const p = follow((h) => shim("/nonexistent/agent-threads-shim", { runsDir }).spawn({ command: "sh", args: [], threadId: "th", runId: "r" }, h));
    expect(await wait(p.exit)).toBe(true);
    expect(p.exit()?.error?.message).toMatch(/couldn't be started/);
    const q = setup().run("true");
    expect(await wait(q.exit)).toBe(true);
    expect(q.exit()).toMatchObject({ code: 0 });
  });

  it("prunes runs the backend finished with a while ago, and stops runs nothing follows", async () => {
    const { runsDir, spawner, run } = setup();
    const store = new MemoryStore();
    await store.createThread({ id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" });
    const done = (id: string, endedDaysAgo: number | null) => {
      const dir = join(runsDir, id);
      mkdirSync(dir);
      writeFileSync(join(dir, "exit"), '{"code":0,"signal":null}');
      const ended_at = endedDaysAgo === null ? undefined : new Date(Date.now() - endedDaysAgo * 86_400_000).toISOString();
      return store.putRun({ id, thread_id: "th", spawner: "shim", offset: 0, started_at: "2026-11-01T00:00:00Z", ...(ended_at ? { ended_at } : {}) });
    };
    await done("old", 20);
    await done("recent", 1);
    await done("active", null);
    // No record, finished long ago (a backend that died before saving it), and one just made.
    mkdirSync(join(runsDir, "stray"));
    writeFileSync(join(runsDir, "stray", "exit"), "{}");
    const hourAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(runsDir, "stray"), hourAgo, hourAgo);
    mkdirSync(join(runsDir, "new"));
    // Running, but the store has it as ended: its backend gave up on it.
    const orphan = run("sleep 30", "orphan");
    expect(await wait(() => existsSync(join(runsDir, "orphan", "pid")))).toBe(true);
    orphan.proc.detach!();
    await store.putRun({ id: "orphan", thread_id: "th", spawner: "shim", offset: 0, started_at: "2026-11-01T00:00:00Z", ended_at: new Date().toISOString() });

    expect(await spawner.prune!(store)).toBe(2);
    expect(readdirSync(runsDir).sort()).toEqual(["active", "new", "orphan", "recent"]);
    expect(await wait(() => existsSync(join(runsDir, "orphan", "exit")))).toBe(true);
    expect(JSON.parse(readFileSync(join(runsDir, "orphan", "exit"), "utf8"))).toMatchObject({ signal: 15 });
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

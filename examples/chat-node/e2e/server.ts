// Starts the chat server for a test, on a free port with a data directory of its own. It's
// chat-node's own unless CHAT_E2E_SERVER gives another's command,
// with CHAT_E2E_SUPERVISED for running it under its supervisor (`$CHAT_E2E_SERVER supervise` by
// default). Words are split on spaces. See examples/PROTOCOL.md for what such a server must do.
//
// It runs in a process group of its own, so that stopping it stops it all: the supervisor and the
// server it runs, and whatever else they started.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "../../spec/fixtures");
export const SHIM = join(ROOT, "../../shim/target/debug/agent-threads-shim");

export interface Server {
  url: string;
  env: { [k: string]: string };
  /** Resolves each time the server says it's listening (again, after a restart). */
  listening(): Promise<void>;
  /**
   * Stops the server and waits until everything in its process group has exited, then stops the
   * shim's runs it left (which a server leaves running, for the next one to re-attach to). Rejects
   * if any of it had to be killed, once it has.
   */
  stop(): Promise<void>;
  /** What of it is still running (none once stop() has resolved): its process group, its port, its runs. */
  remains(): Promise<string[]>;
}

/** The process groups of the servers that are running, killed if the tests' process exits first. */
const groups = new Set<number>();
process.on("exit", () => {
  for (const g of groups) signal(-g, "SIGKILL");
});

export async function startServer(env: { [k: string]: string }, { supervised = false, port: given }: { supervised?: boolean; port?: number } = {}): Promise<Server> {
  const port = given ?? (await freePort());
  const data = env.CHAT_DATA ?? mkdtempSync(join(tmpdir(), "chat-e2e-"));
  const all = { ...env, PORT: String(port), CHAT_DATA: data };
  const [bin, ...args] = command(supervised);
  const proc: ChildProcess = spawn(bin!, args, { env: { ...process.env, ...all }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const group = proc.pid!;
  groups.add(group);
  let waiting: (() => boolean)[] = [];
  let starts = 0;
  // A server says it's listening with a line starting `chat-<name> on`, on stdout or stderr.
  for (const input of [proc.stdout!, proc.stderr!])
    createInterface({ input }).on("line", (line) => {
      process.stdout.write(`[server] ${line}\n`);
      if (/^chat-\S+ on /.test(line)) {
        starts++;
        waiting = waiting.filter((w) => !w());
      }
    });
  const exited = new Promise<void>((r) => proc.on("exit", () => r()));
  let seen = 0;
  const server: Server = {
    url: `http://127.0.0.1:${port}`,
    env: all,
    listening: () => {
      // The next start after the last one waited for.
      const want = ++seen;
      return starts >= want ? Promise.resolve() : new Promise((r) => waiting.push(() => starts >= want && (r(), true)));
    },
    stop: async () => {
      const problems: string[] = [];
      // The supervisor passes it on to the server, and exits once that has.
      proc.kill("SIGTERM");
      if (!(await until(() => !alive(-group), 15_000))) {
        problems.push("the server didn't stop within 15s of SIGTERM: killed it");
        signal(-group, "SIGKILL");
        await until(() => !alive(-group), 5_000);
      }
      await exited;
      groups.delete(group);
      problems.push(...(await stopRuns(data)));
      if (problems.length) throw new Error(problems.join("; "));
    },
    remains: async () => {
      const left = alive(-group) ? [`its process group (${group})`] : [];
      if (await fetch(server.url).then(() => true, () => false)) left.push(`${server.url}, which still answers`);
      for (const r of runs(data)) {
        const pids = r.left();
        if (pids === undefined ? !r.over() : pids.length) left.push(`its run ${r.id} (${pids?.join(", ") ?? "its processes can't be told apart here"})`);
      }
      return left;
    },
  };
  // Not for ever: say why if it doesn't start.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    server.listening(),
    exited.then(() => Promise.reject(new Error("the server exited before it was listening"))),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the server didn't start within 20s")), 20_000))),
  ])
    .catch((e) => {
      signal(-group, "SIGKILL");
      groups.delete(group);
      throw e;
    })
    .finally(() => clearTimeout(timer));
  return server;
}

/** The command that runs the server (under its supervisor, which restarts it when asked to). */
function command(supervised: boolean): string[] {
  const other = process.env.CHAT_E2E_SERVER?.trim();
  if (!other) return [process.execPath, join(ROOT, supervised ? "server/supervise.ts" : "server/main.ts")];
  return (supervised ? process.env.CHAT_E2E_SUPERVISED?.trim() || `${other} supervise` : other).split(/\s+/);
}

/** Where a run's processes are told from: /proc (Linux), or ps (elsewhere, and in the tests of this). */
export type ProcessSource = "proc" | "ps";
const SOURCE: ProcessSource = process.platform === "linux" ? "proc" : "ps";

/** A run's metadata that's older than this, or a process that started before it, isn't the run's. */
const SLACK_MS = 2_000;

/** The shim's runs in a data directory (see spec/RUNDIR.md), which a server keeps in runs/. */
export function runs(data: string, source: ProcessSource = SOURCE) {
  const dir = join(data, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((id) => {
    const file = (name: string) => join(dir, id, name);
    /** A pid file's pid and when it was written, if it was written since the machine started. */
    const pidFile = (name: string) => {
      if (!existsSync(file(name))) return undefined;
      const at = statSync(file(name)).mtimeMs;
      return at > bootTime() ? { pid: Number(readFileSync(file(name), "utf8")), at } : undefined;
    };
    /**
     * What's left of it: its shim, and what's in its program's process group (the program, and what
     * it started). Not just till it has `exit`, which only says the program has gone. Undefined if
     * that can't be told here: nothing is signalled then.
     *
     * Told as a backend tells them (spec/RUNDIR.md), so that a pid or group id given to another
     * process since isn't taken for the run's: the shim is the process in `shim.pid`, if it leads its
     * own session and started before the file was written; the program is the one in `pid`, if it
     * started between that and `pid` being written; the rest of its group must be in the shim's
     * session, and have started since the shim did.
     *
     * A pid isn't given to a new process while it's still a session's or a group's id. So a process
     * that has the shim's pid but isn't the shim means the run's session has gone, and all that's in
     * a session with that id now is another's; and likewise for the program's pid and its group.
     * Even if it has exited: one that isn't reaped yet still has its ids, and its start.
     */
    const left = (): number[] | undefined => {
      const shim = pidFile("shim.pid");
      if (!shim) return [];
      const all = processes(source);
      if (!all) return undefined;
      const since = (p: Proc, at: number) => p.start >= at - SLACK_MS;
      const before = (p: Proc, at: number) => p.start <= at + SLACK_MS;
      const leader = all.find((p) => p.pid === shim.pid);
      if (leader && !(leader.sid === shim.pid && since(leader, shim.at) && before(leader, shim.at))) return [];
      const running = (ps: Proc[]) => ps.filter((p) => !p.exited).map((p) => p.pid);
      const ours = running(leader ? [leader] : []);
      const program = pidFile("pid");
      if (!program || program.pid === shim.pid) return ours;
      const inSession = (p: Proc) => p.sid === shim.pid && since(p, shim.at);
      const group = all.filter((p) => p.pgrp === program.pid);
      const head = group.find((p) => p.pid === program.pid);
      if (head && !(inSession(head) && before(head, program.at))) return ours;
      // The program, if it's still there, and what it started that's still in its group.
      return [...ours, ...running(group.filter(inSession))];
    };
    return {
      id,
      over: () => existsSync(file("exit")),
      /** The program's pid, which is its process group's too. */
      program: () => pidFile("pid")?.pid,
      shim: () => pidFile("shim.pid")?.pid,
      /** The pids of its processes that are still there, or undefined if that can't be told. */
      left,
      running: () => (left()?.length ?? 0) > 0,
    };
  });
}

/**
 * Stops the runs in a data directory that are still running, as a backend does (spec/RUNDIR.md):
 * SIGTERM to what's in the program's group, and SIGKILL to whatever is left of it 5s later, even
 * once the program has gone (something it started may ignore SIGTERM). What went wrong, if anything
 * did.
 */
export async function stopRuns(data: string, source: ProcessSource = SOURCE): Promise<string[]> {
  const problems: string[] = [];
  await Promise.all(
    runs(data, source).map(async (run) => {
      if (run.left() === undefined) {
        // Nothing is signalled that may not be the run's.
        if (!run.over()) problems.push(`run ${run.id}'s processes can't be told apart here (ps gives no sessions): it's left as it is`);
        return;
      }
      if (!run.running()) return;
      // One its server was starting when it stopped may have no program yet.
      if (!(await until(() => run.program() !== undefined || !run.running(), 5_000))) return problems.push(`run ${run.id} didn't start its program`);
      // Its processes one by one, not its group: only those that are still the run's. The shim
      // isn't signalled: it exits once the program has.
      const kill = (sig: NodeJS.Signals) => run.left()?.forEach((p) => p !== run.shim() && signal(p, sig));
      kill("SIGTERM");
      if (await until(() => !run.running(), 5_000)) return;
      // Again each time, for any it starts meanwhile.
      if (await until(() => (kill("SIGKILL"), !run.running()), 5_000)) return;
      problems.push(`run ${run.id} didn't end, even with SIGKILL: ${run.left()?.join(", ")} left`);
    }),
  );
  return problems;
}

interface Proc {
  pid: number;
  pgrp: number;
  sid: number;
  /** When it started, in ms since the epoch: to the jiffy from /proc, to the second from ps. */
  start: number;
  /** It has exited, but isn't reaped yet (a zombie): it's not running, but its ids are still its. */
  exited: boolean;
}

/**
 * The processes there are, with their process group, session and start, and whether they've exited
 * (zombies): from /proc, or from ps. Undefined if ps doesn't give them (macOS's has no session ids).
 */
function processes(source: ProcessSource): Proc[] | undefined {
  if (source === "ps") {
    let out: string;
    try {
      out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "sid=", "-o", "stat=", "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
    const all: Proc[] = [];
    for (const line of out.trim().split("\n")) {
      const [pid, pgrp, sid, stat, ...lstart] = line.trim().split(/\s+/);
      const p = { pid: Number(pid), pgrp: Number(pgrp), sid: Number(sid), start: Date.parse(`${lstart.join(" ")} UTC`), exited: /^[ZX]/.test(stat ?? "") };
      if (![p.pid, p.pgrp, p.sid, p.start].every(Number.isFinite)) return undefined;
      all.push(p);
    }
    return all;
  }
  const all: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // Gone meanwhile.
    }
    // After the name in parentheses (which may have spaces and parentheses in it): state (field 3),
    // ppid, pgrp, session, ... starttime (field 22, in clock ticks since the machine started).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, , pgrp, sid] = fields;
    const start = bootTime() + (Number(fields[19]) / clockTicks()) * 1000;
    all.push({ pid: Number(name), pgrp: Number(pgrp), sid: Number(sid), start, exited: state === "Z" || state === "X" });
  }
  return all;
}

/** When the machine started, in ms since the epoch: to the second on Linux (/proc/stat's btime). */
const bootTime = once(() => {
  const btime = existsSync("/proc/stat") && /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
  return btime ? Number(btime[1]) * 1000 : Date.now() - uptime() * 1000;
});

/** /proc's clock ticks a second. */
const clockTicks = once(() => {
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" })) || 100;
  } catch {
    return 100;
  }
});

function once<T>(f: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: f() }).v;
}

/** Whether a process (or with a negative pid, a process group) is there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Gone already.
  }
}

/** Waits until done() says so, or ms have gone by: whether it did. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await sleep(50)) if (Date.now() > end) return false;
  return true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

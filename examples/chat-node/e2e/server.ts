// Starts the chat server for a test, on a free port with a data directory of its own. It's
// chat-node's own unless CHAT_E2E_SERVER gives another's command (e.g. the Go or Rust example's),
// with CHAT_E2E_SUPERVISED for running it under its supervisor (`$CHAT_E2E_SERVER supervise` by
// default). Words are split on spaces. See examples/PROTOCOL.md for what such a server must do.
//
// It runs in a process group of its own, so that stopping it stops it all: the supervisor and the
// server it runs, and whatever else they started.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
      return [...left, ...runs(data).filter((r) => r.running()).map((r) => `its run ${r.id} (${r.left().join(", ")})`)];
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

/** The shim's runs in a data directory (see spec/RUNDIR.md), which all three servers keep in runs/. */
export function runs(data: string) {
  const dir = join(data, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((id) => {
    const file = (name: string) => join(dir, id, name);
    const pid = (name: string) => (existsSync(file(name)) ? Number(readFileSync(file(name), "utf8")) : undefined);
    /**
     * What's left of it: its shim, and what's in its program's process group (the program, and what
     * it started). Not just till it has `exit`, which only says the program has gone. They're told
     * the run's as a backend tells them (spec/RUNDIR.md): the shim leads a session of its own, whose
     * id is its pid, and everything the run starts is in that session; so a pid or group id given
     * to another since isn't taken for the run's.
     */
    const left = () => {
      const shim = pid("shim.pid");
      if (shim === undefined) return [];
      const program = pid("pid");
      return processes().filter((p) => (p.sid ?? shim) === shim && (p.pid === shim || (program !== undefined && p.pgrp === program)));
    };
    return {
      id,
      /** The program's pid, which is its process group's too. */
      program: () => pid("pid"),
      /** The pids of its processes that are still there. */
      left: () => left().map((p) => p.pid),
      running: () => left().length > 0,
    };
  });
}

/**
 * Stops the runs in a data directory that are still running, as a backend does (spec/RUNDIR.md):
 * SIGTERM to what's in the program's group, and SIGKILL to whatever is left of it 5s later, even
 * once the program has gone (something it started may ignore SIGTERM). What went wrong, if anything
 * did.
 */
export async function stopRuns(data: string): Promise<string[]> {
  const problems: string[] = [];
  await Promise.all(
    runs(data).map(async (run) => {
      if (!run.running()) return;
      // One its server was starting when it stopped may have no program yet.
      if (!(await until(() => run.program() !== undefined || !run.running(), 5_000))) return problems.push(`run ${run.id} didn't start its program`);
      // Its processes one by one, not its group: only those that are still the run's. The shim
      // isn't signalled: it exits once the program has.
      const shim = Number(readFileSync(join(data, "runs", run.id, "shim.pid"), "utf8"));
      const kill = (sig: NodeJS.Signals) => run.left().forEach((p) => p !== shim && signal(p, sig));
      kill("SIGTERM");
      if (await until(() => !run.running(), 5_000)) return;
      // Again each time, for any it starts meanwhile.
      if (await until(() => (kill("SIGKILL"), !run.running()), 5_000)) return;
      problems.push(`run ${run.id} didn't end, even with SIGKILL: ${run.left().join(", ")} left`);
    }),
  );
  return problems;
}

/**
 * The processes that are running (not zombies), with their process group and session: from /proc
 * on Linux; elsewhere from ps, which doesn't give sessions everywhere, so without them.
 */
function processes(): { pid: number; pgrp: number; sid?: number }[] {
  if (process.platform !== "linux")
    return execFileSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter(([, , stat]) => !/^[ZX]/.test(stat ?? ""))
      .map(([pid, pgrp]) => ({ pid: Number(pid), pgrp: Number(pgrp) }));
  const all = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // Gone meanwhile.
    }
    // After the name in parentheses (which may have spaces and parentheses in it): state, ppid,
    // pgrp, session.
    const [state, , pgrp, sid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (state !== "Z" && state !== "X") all.push({ pid: Number(name), pgrp: Number(pgrp), sid: Number(sid) });
  }
  return all;
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

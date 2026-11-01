// The shim spawner: harness processes run under agent-threads-shim (../../../../shim), detached
// from the backend, and everything between them goes through files in the run's directory, as
// spec/RUNDIR.md says. The backend appends its input to input.jsonl and follows out.jsonl, and
// the offset it has read to is saved with the events it made of the lines (see Spawner.durable),
// so a backend that restarts re-attaches (attach()) and carries on from exactly there.

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { constants, uptime } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { direct, type ExitStatus, type HarnessProcess, type ProcessHandlers, type SpawnOptions, type Spawner } from "./spawner.js";
import type { RunRecord, Store } from "./store.js";

/** The run-directory format this backend writes and reads (spec/RUNDIR.md). */
export const RUN_FORMAT = 1;

export interface ShimOptions {
  /**
   * Where run directories go. It must be this store's alone: pruning stops and removes the runs in
   * it that the store doesn't follow, so two stores sharing one would stop each other's runs.
   */
  runsDir: string;
  /** How long a finished run's directory is kept, for debugging. 14 days by default. */
  keepDays?: number;
  /** How long a run that's stopped has to exit after SIGTERM before it's sent SIGKILL. 10s by default. */
  killGraceMs?: number;
  /** How often the output is read when nothing says it changed. 200ms by default. */
  pollMs?: number;
}

/** The data a shim run keeps in its RunRecord. */
export interface ShimRunData {
  /** The run's directory. */
  dir: string;
  [k: string]: unknown;
}

/** How long a finished run's directory with no record, or a dead run's, is kept: it may be a run being started. */
const KEEP_UNKNOWN_MS = 3600_000;
/** How long the shim may take to record its pid after it's launched. */
const START_TIMEOUT_MS = 10_000;
/** How much of err.log a re-attached run's stderr starts with. */
const STDERR_TAIL = 4096;
const CHUNK = 1 << 20;

/**
 * Runs harness processes under agent-threads-shim (`path`, the binary: a path, or a name looked for
 * on the PATH), so they survive the backend. On Windows, which the shim doesn't run on, it's
 * `direct()`.
 */
export function shim(path: string, options: ShimOptions): Spawner {
  if (process.platform === "win32") return direct();
  if (!options?.runsDir) throw new TypeError("shim() needs a runsDir: a directory for this store's runs alone");
  // Made absolute here, as the shim starts in the thread's working directory.
  const runsDir = resolve(options.runsDir);
  const bin = path.includes("/") && !isAbsolute(path) ? resolve(path) : path;
  const keepMs = (options.keepDays ?? 14) * 86_400_000;
  const grace = options.killGraceMs ?? 10_000;
  const poll = options.pollMs ?? 200;
  /** Runs this backend follows, which pruning leaves alone. */
  const live = new Map<string, ShimProcess>();

  const follow = (id: string, dir: string, offset: number, handlers: ProcessHandlers, launched: boolean, input?: number): ShimProcess => {
    const proc = new ShimProcess(dir, offset, handlers, { poll, grace, launched, input, done: () => live.delete(id) });
    live.set(id, proc);
    return proc;
  };

  return {
    name: "shim",
    durable: true,

    spawn(o: SpawnOptions, handlers: ProcessHandlers): HarnessProcess {
      const dir = join(runsDir, o.runId);
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      mkdirSync(dir, { mode: 0o700 });
      const run = { format: RUN_FORMAT, run_id: o.runId, thread_id: o.threadId, command: o.command, started_at: new Date().toISOString() };
      writeFileSync(join(dir, "run.json"), JSON.stringify(run) + "\n");
      writeFileSync(join(dir, "input.jsonl"), "");
      const proc = follow(o.runId, dir, 0, handlers, true);
      // The shim forks and its first process exits at once; the run is the fork's.
      const launcher = spawnChild(bin, [dir, "--", o.command, ...o.args], { cwd: o.cwd, env: o.env, stdio: "ignore", detached: true });
      launcher.on("error", (e) => proc.launchFailed(`agent-threads-shim couldn't be started: ${e.message}`));
      launcher.on("exit", (code, signal) => {
        if (code === 0) proc.launched();
        else proc.launchFailed(`agent-threads-shim ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`);
      });
      launcher.unref();
      return proc;
    },

    attach(run: RunRecord, handlers: ProcessHandlers): HarnessProcess {
      const dir = runDir(run) ?? join(runsDir, run.id);
      const input = (run.data as { input?: unknown } | undefined)?.input;
      const proc = follow(run.id, dir, run.offset ?? 0, handlers, false, typeof input === "number" ? input : undefined);
      const format = readFormat(dir);
      if (format > RUN_FORMAT) {
        stopDir(dir, grace);
        proc.fail(`the run was started by a newer backend (run directory format ${format}), which this one can't follow`);
      }
      return proc;
    },

    stop(run: RunRecord): void {
      stopDir(runDir(run) ?? join(runsDir, run.id), grace);
    },

    async prune(store: Store): Promise<number> {
      let names: string[];
      try {
        names = readdirSync(runsDir);
      } catch {
        return 0;
      }
      let removed = 0;
      const now = Date.now();
      for (const id of names) {
        const dir = join(runsDir, id);
        let st;
        try {
          st = statSync(dir);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        // A run being stopped when a backend went: whatever's left of it is stopped still.
        if (stoppingAt(dir) !== undefined) {
          escalate(dir);
          continue;
        }
        if (live.has(id)) continue;
        const record = await store.getRun(id);
        if (record && record.ended_at == null) continue; // A run the backend will follow.
        // Its shim, or (with the shim gone) what it ran, which nothing would stop.
        const running = (!existsSync(join(dir, "exit")) && shimAlive(dir)) || liveGroup(dir) !== undefined;
        if (running) {
          // Nothing follows it, so nothing will stop it: a run its backend gave up on (and was
          // stopping when it went), or one started by a backend that died before saving it.
          if (record || now - st.mtimeMs > START_TIMEOUT_MS) stopDir(dir, grace);
          continue;
        }
        const since = record ? Date.parse(String(record.ended_at)) : st.mtimeMs;
        if (now - since > (record ? keepMs : KEEP_UNKNOWN_MS)) {
          try {
            rmSync(dir, { recursive: true, force: true });
            removed++;
          } catch {
            // Tried again next time.
          }
        }
      }
      return removed;
    },
  };
}

/** A run's directory, as its record has it. */
function runDir(run: RunRecord): string | undefined {
  const dir = (run.data as ShimRunData | undefined)?.dir;
  return typeof dir === "string" ? dir : undefined;
}

/** One run under the shim, followed through its directory. */
class ShimProcess implements HarnessProcess {
  readonly dir: string;
  #offset: number;
  #handlers: ProcessHandlers;
  #out: Tail;
  #err: Tail;
  #poll: number;
  #grace: number;
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #wake = false;
  #pid: number | undefined;
  #inputClosed = false;
  /** Signals to send once the program's pid is known. */
  #signals: NodeJS.Signals[] = [];
  /** Launched by this backend: when the launcher came back, or why it failed. */
  #launch: { at: number; error?: string } | undefined;
  #launchedHere: boolean;
  #since = Date.now();
  #checked = 0;
  /** input.jsonl's size, as written. */
  #input = 0;
  /**
   * Lines in input.jsonl after the checkpoint it was re-attached from (and where each starts), in
   * order, that reading the output again hasn't written again yet.
   */
  #delivered: { text: string; at: number }[] = [];
  /** How much of out.jsonl there was when it was re-attached to: once that's read, nothing's written again. */
  #outAtAttach = 0;
  /** The shim's identity, once it's been checked to be the run's. */
  #shim: { identity?: Identity } = {};
  #over = false;
  #onDone: () => void;

  constructor(dir: string, offset: number, handlers: ProcessHandlers, o: { poll: number; grace: number; launched: boolean; done: () => void; input?: number }) {
    this.dir = dir;
    if (!o.launched) {
      // What's been written, and what of it came after the checkpoint (input: where it was then).
      try {
        const all = readFileSync(join(dir, "input.jsonl"));
        this.#input = all.length;
        if (o.input !== undefined) {
          let at = Math.min(o.input, all.length);
          for (const text of all.subarray(at).toString("utf8").split(/(?<=\n)/)) {
            if (text.endsWith("\n")) this.#delivered.push({ text, at });
            at += Buffer.byteLength(text);
          }
        }
        this.#outAtAttach = statSync(join(dir, "out.jsonl")).size;
      } catch {
        // None.
      }
    }
    this.#offset = offset;
    this.#handlers = handlers;
    this.#poll = o.poll;
    this.#grace = o.grace;
    this.#launchedHere = o.launched;
    this.#onDone = o.done;
    this.#out = new Tail(join(dir, "out.jsonl"), offset);
    // A re-attached run's stderr starts with the end of what it wrote before.
    let errStart = 0;
    if (!o.launched) {
      try {
        errStart = Math.max(0, statSync(join(dir, "err.log")).size - STDERR_TAIL);
      } catch {
        // None yet.
      }
    }
    this.#err = new Tail(join(dir, "err.log"), errStart, errStart > 0);
    try {
      this.#watcher = watch(dir, () => this.#nudge());
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      // Polling does it.
    }
    this.#schedule(0);
  }

  get pid(): number | undefined {
    this.#pid ??= readPid(this.dir, "pid");
    return this.#pid;
  }

  get offset(): number {
    return this.#offset;
  }

  /** How much of input.jsonl is written (bytes): a checkpoint keeps it, as of the driver's state. */
  get inputOffset(): number {
    // Not past a line that's to be written again (and isn't): a restart before it is must know it's
    // there.
    return this.#delivered[0]?.at ?? this.#input;
  }

  write(line: string): void {
    if (this.#over || this.#inputClosed) return;
    const text = line.endsWith("\n") ? line : line + "\n";
    // Written already, after the checkpoint this run was re-attached from: what's read again since
    // writes it again, and it isn't.
    // The first (in order) of those it's the same as.
    const at = this.#delivered.findIndex((d) => d.text === text);
    if (at >= 0) return void this.#delivered.splice(at, 1);
    try {
      // One write, so the shim never relays half a line.
      appendFileSync(join(this.dir, "input.jsonl"), text);
      this.#input += Buffer.byteLength(text);
    } catch {
      // The run's gone; its exit says how.
    }
  }

  closeInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    try {
      writeFileSync(join(this.dir, "input.closed"), "");
    } catch {
      // As above.
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.pid === undefined) {
      // The shim hasn't started it yet: it's signalled once it has.
      if (!this.#over) this.#signals.push(signal);
      return;
    }
    // Its group, even once the program has exited: what it started may still be running.
    terminate(this.dir, this.#grace, signal);
  }

  detach(): void {
    this.#end();
  }

  /** The launcher came back: the shim has forked, and records the run's pid next. */
  launched(): void {
    this.#launch ??= { at: Date.now() };
  }

  launchFailed(error: string): void {
    this.#launch = { at: Date.now(), error };
    this.#nudge();
  }

  /** Ends the run with an error, without reading it further (a run this backend can't follow). */
  fail(error: string): void {
    if (this.#over) return;
    this.#end();
    queueMicrotask(() => this.#handlers.exit({ code: null, signal: null, error: new Error(error) }));
  }

  #end(): void {
    this.#over = true;
    clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#out.close();
    this.#err.close();
    this.#onDone();
  }

  #nudge(): void {
    if (this.#over || this.#wake) return;
    this.#wake = true;
    clearTimeout(this.#timer);
    this.#schedule(0);
  }

  #schedule(ms: number): void {
    if (this.#over) return;
    this.#timer = setTimeout(() => {
      this.#wake = false;
      this.#tick();
    }, ms);
  }

  #tick(): void {
    if (this.#over) return;
    // Looked for first, so all the output written before it is read below.
    const exited = existsSync(join(this.dir, "exit"));
    for (const { line } of this.#err.lines(exited)) {
      this.#handlers.stderr(line);
      if (this.#over) return;
    }
    for (const { line, end } of this.#out.lines(exited)) {
      this.#offset = end;
      if (line) this.#handlers.line(line);
      if (this.#over) return;
    }
    // What was there when it was re-attached to is read again, and what that writes is written (in
    // the same tick, or the next): lines written before that aren't written again now.
    if (this.#delivered.length && this.#offset >= this.#outAtAttach) setImmediate(() => (this.#delivered = []));
    if (this.#signals.length && this.pid !== undefined) for (const s of this.#signals.splice(0)) terminate(this.dir, this.#grace, s);
    if (exited) return this.#exited(readExit(this.dir));
    const gone = this.#gone();
    if (gone) {
      // Recorded as the shim would have, unless it did after all.
      if (!existsSync(this.dir)) return this.#exited({ code: null, signal: null, error: new Error(gone) });
      writeExit(this.dir, { code: null, signal: null, error: gone });
      // With its shim gone, nothing would stop the program, which may well still be running.
      terminate(this.dir, this.#grace);
      return this.#schedule(0);
    }
    this.#schedule(this.#poll);
  }

  /** Why the run is gone though it has no exit file, if it is. */
  #gone(): string | undefined {
    if (!existsSync(this.dir)) return "the run's directory was removed";
    if (this.#launch?.error) return this.#launch.error;
    // Not every time: it's a few system calls.
    const now = Date.now();
    if (now - this.#checked < 1000) return undefined;
    this.#checked = now;
    if (readPid(this.dir, "shim.pid") !== undefined) return shimAlive(this.dir, this.#shim) || existsSync(join(this.dir, "exit")) ? undefined : "its supervisor (agent-threads-shim) went away";
    // No shim.pid: one still starting, or one that never started.
    const since = this.#launchedHere ? this.#launch?.at : this.#since;
    if (since !== undefined && now - since > START_TIMEOUT_MS) return "agent-threads-shim didn't start the run";
    return undefined;
  }

  #exited(status: ExitStatus): void {
    this.#end();
    this.#handlers.exit(status);
  }
}

/** Reads a file's whole lines as they're appended, from an offset. */
class Tail {
  #path: string;
  #fd: number | undefined;
  /** Where `#pending` starts in the file. */
  #at: number;
  #pending = Buffer.alloc(0);
  #buf: Buffer | undefined;
  /** Drop what comes before the first newline (a tail started mid-line). */
  #skip: boolean;

  constructor(path: string, offset: number, skipPartial = false) {
    this.#path = path;
    this.#at = offset;
    this.#skip = skipPartial;
  }

  /**
   * The whole lines appended since the last call, each with the offset after it. Once the writer
   * is done (`final`), a last line with no newline counts too.
   */
  *lines(final: boolean): Generator<{ line: string; end: number }> {
    this.#read();
    let start = 0;
    for (let nl = this.#pending.indexOf(10); nl >= 0; nl = this.#pending.indexOf(10, start)) {
      const line = this.#pending.subarray(start, nl).toString("utf8");
      start = nl + 1;
      if (this.#skip) {
        this.#skip = false;
        continue;
      }
      yield { line: line.endsWith("\r") ? line.slice(0, -1) : line, end: this.#at + start };
    }
    if (final && start < this.#pending.length && !this.#skip) {
      const line = this.#pending.subarray(start).toString("utf8");
      start = this.#pending.length;
      yield { line, end: this.#at + start };
    }
    this.#at += start;
    this.#pending = this.#pending.subarray(start);
  }

  #read(): void {
    if (this.#fd === undefined) {
      try {
        this.#fd = openSync(this.#path, "r");
      } catch {
        return; // Not there yet.
      }
    }
    const chunks = [this.#pending];
    let pos = this.#at + this.#pending.length;
    // One buffer, read into each time (most reads find nothing new), and copied out of.
    const buf = (this.#buf ??= Buffer.allocUnsafe(CHUNK));
    for (;;) {
      const n = readSync(this.#fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    if (chunks.length > 1) this.#pending = Buffer.concat(chunks);
  }

  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
  }
}

/** The pid in a run directory's `pid` or `shim.pid`. */
function readPid(dir: string, name: string): number | undefined {
  try {
    const n = Number(readFileSync(join(dir, name), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function readFormat(dir: string): number {
  try {
    const f = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).format;
    return typeof f === "number" ? f : 1;
  } catch {
    return 1;
  }
}

/** A run directory's `exit`, as an ExitStatus. */
function readExit(dir: string): ExitStatus {
  let e: { code?: unknown; signal?: unknown; error?: unknown };
  try {
    e = JSON.parse(readFileSync(join(dir, "exit"), "utf8"));
  } catch (err) {
    return { code: null, signal: null, error: new Error(`the run's exit file can't be read: ${err instanceof Error ? err.message : String(err)}`) };
  }
  const code = typeof e.code === "number" ? e.code : null;
  const signal = typeof e.signal === "number" ? signalName(e.signal) : typeof e.signal === "string" ? e.signal : null;
  return { code, signal, ...(typeof e.error === "string" ? { error: new Error(e.error) } : {}) };
}

/** Writes a run directory's file whole, as the shim does. */
function writeAtomic(dir: string, name: string, content: string): void {
  try {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, content);
    renameSync(tmp, join(dir, name));
  } catch {
    // The directory's gone.
  }
}

/** Writes `exit` atomically, as the shim does. */
function writeExit(dir: string, exit: { code: number | null; signal: number | null; error?: string }): void {
  try {
    const tmp = join(dir, `.exit.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(exit));
    if (existsSync(join(dir, "exit"))) rmSync(tmp, { force: true });
    else renameSync(tmp, join(dir, "exit"));
  } catch {
    // The directory's gone.
  }
}

function signalName(n: number): string {
  for (const [name, v] of Object.entries(constants.signals)) if (v === n) return name;
  return String(n);
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Its group's gone.
  }
}

/** When the machine started (ms since the epoch), give or take a second. */
const bootTime = (): number => Date.now() - uptime() * 1000;

/** When a run directory's file was written, if it was since the machine started (before, its pid is stale). */
function writtenThisBoot(dir: string, name: string): number | undefined {
  try {
    const at = statSync(join(dir, name)).mtimeMs;
    return at >= bootTime() - 1000 ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A process's identity: its pid, when it started (which a pid given to another process differs
 * in), and where that was read, since /proc and `ps` don't tell it alike.
 */
interface Identity {
  pid: number;
  start: number;
  source: "proc" | "ps";
}

/**
 * Whether the run's shim is alive: the process in `shim.pid` (written since the machine started)
 * is running (not a zombie), and is the shim, which started before `shim.pid` was written (not
 * another process given the same pid since). `known` keeps the identity found the first time,
 * which the process with the pid must still have each time after: if it hasn't, the shim has
 * gone. When that can't be told (no /proc and no `ps`, say, or its start is read another way
 * than the first time), a running process with the pid counts as the shim, and it's checked again
 * next time.
 */
function shimAlive(dir: string, known?: { identity?: Identity }): boolean {
  const pid = readPid(dir, "shim.pid");
  const written = writtenThisBoot(dir, "shim.pid");
  if (pid === undefined || written === undefined || !alive(pid)) return false;
  const info = procInfo(pid);
  if (!info) return true;
  if (info.zombie) return false;
  const id = known?.identity;
  // /proc and ps agree on a start to within a second (ps has it to the second).
  if (id?.pid === pid) return id.source === info.source ? id.start === info.start : Math.abs(id.start - info.start) < 1000;
  const ours = info.start <= written + 1000;
  if (ours && known) known.identity = { pid, start: info.start, source: info.source };
  return ours;
}

/** What's known of a running process: when it started, whether it has exited unreaped, and where that was read. */
interface ProcInfo {
  start: number;
  zombie: boolean;
  source: "proc" | "ps";
}

/** For the tests: how a process's start is told, in place of /proc and `ps` (or without /proc). */
export const identityForTests: { startTime?: (pid: number, real: (pid: number) => number | undefined) => number | undefined; noProc?: boolean } = {};

/**
 * A process's start (ms since the epoch) and state, if it's running and that can be told: from
 * /proc on Linux (cheap, and to the clock tick), or from `ps` (to the second) elsewhere.
 */
function procInfo(pid: number): ProcInfo | undefined {
  const real = realProcInfo(pid);
  if (!identityForTests.startTime) return real;
  const start = identityForTests.startTime(pid, (p) => realProcInfo(p)?.start);
  return start === undefined ? undefined : { zombie: false, source: "ps", ...real, start };
}

function realProcInfo(pid: number): ProcInfo | undefined {
  if (process.platform === "linux" && !identityForTests.noProc) {
    const info = procStat(pid);
    if (info) return info;
  }
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(out);
    const at = m ? Date.parse(m[2]!) : NaN;
    return m && !Number.isNaN(at) ? { start: at, zombie: /^[ZX]/.test(m[1]!), source: "ps" } : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of /proc/<pid>/stat after the command (the first is field 3, the state). */
function procFields(pid: number | string): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After the command, which is in parentheses and may have spaces or parentheses in it.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
}

/** When the machine started (/proc/stat's btime, ms since the epoch), read once. */
let btime: number | null | undefined;

/** Clock ticks a second, as /proc counts them (USER_HZ: 100 on Linux, whatever the kernel's HZ). */
const CLOCK_TICKS = 100;

/** A process's start and state from /proc/<pid>/stat (clock ticks after boot) and /proc/stat's btime. */
function procStat(pid: number): ProcInfo | undefined {
  try {
    if (btime === undefined) {
      const m = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
      btime = m ? Number(m[1]) * 1000 : null;
    }
  } catch {
    btime = null;
  }
  const fields = procFields(pid);
  if (btime === null || !fields) return undefined;
  // starttime is field 22; fields[0] here is field 3 (state).
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks)) return undefined;
  return { start: btime + (ticks * 1000) / CLOCK_TICKS, zombie: fields[0] === "Z" || fields[0] === "X", source: "proc" };
}

/** The session ids of the processes in process group `pgid`, if `ps` can say (Linux's can). */
function groupSessions(pgid: number): number[] | undefined {
  if (process.platform === "linux" && !identityForTests.noProc) {
    try {
      const sids: number[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        // pgrp is field 5 and session field 6.
        const f = procFields(name);
        if (f && Number(f[2]) === pgid) sids.push(Number(f[3]));
      }
      return sids;
    } catch {
      // Then ps.
    }
  }
  try {
    const out = execFileSync("ps", ["-e", "-o", "pgid=", "-o", "sid="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const sids: number[] = [];
    for (const line of out.split("\n")) {
      const [g, sid] = line.trim().split(/\s+/).map(Number);
      if (g === pgid && Number.isInteger(sid)) sids.push(sid!);
    }
    return sids;
  } catch {
    return undefined;
  }
}

/**
 * The run's process group (the program's pid), if it's still the run's and anything in it is
 * running: never a group whose id the system has since given to another process. When that can't
 * be told, it's none.
 */
function liveGroup(dir: string): number | undefined {
  const pid = readPid(dir, "pid");
  const written = writtenThisBoot(dir, "pid");
  // Written before the machine restarted: the pid means nothing now.
  if (pid === undefined || written === undefined) return undefined;
  const leader = alive(pid) ? procInfo(pid) : undefined;
  if (alive(pid) && !leader) return undefined; // Can't tell whose it is.
  if (leader && !leader.zombie) {
    // The program, if it started before its pid was written; not a new process given the same pid.
    return leader.start <= written + 1000 ? pid : undefined;
  }
  // The program's gone. What's left in a group with its id is the run's only if it's in the run's
  // session, which the shim leads (its pid is the session's id): the id may have gone to another
  // group since, whose leader has gone too.
  const shim = readPid(dir, "shim.pid");
  if (shim === undefined || writtenThisBoot(dir, "shim.pid") === undefined) return undefined;
  const sids = groupSessions(pid);
  return sids?.length && sids.every((sid) => sid === shim) ? pid : undefined;
}

/** Whether anything is left in process group `pgid` (whoever's it is). */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When a run being stopped gets SIGKILL (its `stopping` file), if it's being stopped. */
function stoppingAt(dir: string): number | undefined {
  try {
    const at = JSON.parse(readFileSync(join(dir, "stopping"), "utf8")).kill_at;
    return typeof at === "number" ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signals the run's process group, if it's still the run's; after SIGTERM (or another signal),
 * SIGKILL to whatever is left of it after `grace`, even if the program itself has exited. That's
 * written down (`stopping`), so a backend that restarts before then carries on with it.
 */
function terminate(dir: string, grace: number, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = liveGroup(dir);
  if (pid === undefined) return;
  if (signal !== "SIGKILL" && stoppingAt(dir) === undefined) writeAtomic(dir, "stopping", JSON.stringify({ kill_at: Date.now() + grace }));
  signalGroup(pid, signal);
  if (signal !== "SIGKILL") escalate(dir);
}

/** Runs whose groups this backend is waiting to SIGKILL. */
const escalating = new Set<string>();

/**
 * Waits for a run's group that's being stopped (it has `stopping`) to go, and SIGKILLs what's
 * left of it at its deadline. Its timers keep the backend running until then, so shutting down
 * doesn't leave it; a backend killed meanwhile carries on after it restarts (in prune()).
 */
function escalate(dir: string): void {
  if (escalating.has(dir)) return;
  escalating.add(dir);
  const done = () => {
    rmSync(join(dir, "stopping"), { force: true });
    escalating.delete(dir);
  };
  const step = (): void => {
    const at = stoppingAt(dir);
    const pid = readPid(dir, "pid");
    if (at === undefined) return void escalating.delete(dir);
    if (pid === undefined || !groupExists(pid)) return done();
    if (Date.now() >= at) {
      const group = liveGroup(dir);
      if (group !== undefined) signalGroup(group, "SIGKILL");
      return done();
    }
    setTimeout(step, Math.min(100, at - Date.now()));
  };
  step();
}

/**
 * Stops the run in `dir`, which nothing follows: ends its input, then SIGTERM to its group and
 * SIGKILL after `grace`. A run its shim hasn't started yet is stopped once it has; one whose shim
 * has gone gets the `exit` the shim would have written.
 */
function stopDir(dir: string, grace: number): void {
  try {
    writeFileSync(join(dir, "input.closed"), "");
  } catch {
    return; // Its directory's gone.
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  const step = (): void => {
    const exited = existsSync(join(dir, "exit"));
    const shim = shimAlive(dir);
    if (readPid(dir, "pid") === undefined) {
      // Not started yet: waited for while the shim may still start it.
      const never = exited || (readPid(dir, "shim.pid") !== undefined && !shim) || Date.now() > deadline || !existsSync(dir);
      if (!never) setTimeout(step, 50);
      return;
    }
    if (!exited && !shim) writeExit(dir, { code: null, signal: null, error: "its supervisor (agent-threads-shim) went away" });
    terminate(dir, grace);
  };
  step();
}

// How harness processes are started. `direct` runs them as child processes, which end with the
// backend; `shim` (shim.ts) runs them under agent-threads-shim, so they outlive it and a restarted
// backend re-attaches to them.

import { spawn as spawnChild } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunRecord, Store } from "./store.js";

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The thread the process runs, and the run's id, for spawners that keep records. */
  threadId: string;
  runId: string;
}

export interface ExitStatus {
  code: number | null;
  signal: string | null;
  /** Why it couldn't be started, if it couldn't. */
  error?: Error;
}

export interface ProcessHandlers {
  /** A line of its stdout. */
  line(line: string): void;
  /** A line of its stderr. */
  stderr(line: string): void;
  /** It ended (or never started), after its last line. */
  exit(status: ExitStatus): void;
  /**
   * The ids of its requests the driver has yet to answer (Claude's control requests'
   * `request_id`s, Codex's JSON-RPC request ids), for a process that outlives the backend: after a
   * restart, an answer it was given before isn't given again while the driver may still answer.
   */
  unanswered?(): Iterable<string | number>;
}

export interface HarnessProcess {
  readonly pid: number | undefined;
  /**
   * How far into its output the lines given so far go (bytes, whole lines only), for a process
   * that outlives the backend: the backend saves it with the events it made of those lines.
   */
  readonly offset?: number;
  /**
   * How much of its input has been written (bytes), for a process that outlives the backend: saved
   * with the driver's state, so input written after it isn't written again when what led to it is
   * read again after a restart.
   */
  readonly inputOffset?: number;
  /** Writes a line to its stdin. */
  write(line: string): void;
  /** Closes its stdin. */
  closeInput(): void;
  /** Signals it, and whatever it started (its process group, where there is one). */
  kill(signal?: NodeJS.Signals): void;
  /**
   * Stops it: closes its stdin, then SIGTERM in `grace` ms (at once with `now`) and SIGKILL in
   * twice that, unless it has gone. A process that outlives the backend writes that down first,
   * so a backend that restarts meanwhile carries on with it. Without this, the driver does it with
   * closeInput() and kill().
   */
  stop?(grace: number, now?: boolean): void;
  /**
   * Stops following it and leaves it running, for a backend that's shutting down and will
   * re-attach (a process that outlives the backend only). No handler is called after this.
   */
  detach?(): void;
}

export interface Spawner {
  readonly name: "direct" | "shim";
  spawn(options: SpawnOptions, handlers: ProcessHandlers): HarnessProcess;
  /**
   * Its processes outlive the backend. The backend then saves each run (its offset and what's
   * needed to carry on reading it) with the thread's events, and re-attaches after a restart.
   */
  readonly durable?: boolean;
  /** Follows a run started before a restart, from the offset saved with it. */
  attach?(run: RunRecord, handlers: ProcessHandlers): HarnessProcess;
  /**
   * Stops a run nothing will follow (its thread has gone on without it, or can't re-attach): ends
   * its input and signals its process group, escalating to SIGKILL.
   */
  stop?(run: RunRecord): void;
  /**
   * Removes what's left of runs the backend is done with (their directories), after the time it
   * keeps them, and stops runs that aren't the store's (their backend died before saving them).
   * The number removed.
   */
  prune?(store: Store): Promise<number>;
}

/** Runs harness processes as children of the backend, each in its own process group. */
export function direct(): Spawner {
  return {
    name: "direct",
    spawn(options, handlers) {
      const unix = process.platform !== "win32";
      const child = spawnChild(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: unix,
      });
      let inputOpen = true;
      // Writing to a process that has gone fails with EPIPE; its exit says what happened.
      child.stdin.on("error", () => {
        inputOpen = false;
      });
      let error: Error | undefined;
      child.on("error", (e) => {
        error = e;
      });
      const out = createInterface({ input: child.stdout });
      const err = createInterface({ input: child.stderr });
      out.on("line", (l) => handlers.line(l));
      err.on("line", (l) => handlers.stderr(l));
      // 'close' comes after the process exits and its stdio ends, so after the last line. Until then
      // something it started may still hold its stdio, so its group can still be signalled.
      let closed = false;
      child.on("close", (code, signal) => {
        closed = true;
        handlers.exit({ code, signal, ...(error ? { error } : {}) });
      });
      return {
        get pid() {
          return child.pid;
        },
        write(line) {
          if (inputOpen && child.stdin.writable) child.stdin.write(line.endsWith("\n") ? line : line + "\n");
        },
        closeInput() {
          if (!inputOpen) return;
          inputOpen = false;
          child.stdin.end();
        },
        kill(signal = "SIGTERM") {
          if (closed || child.pid === undefined) return;
          if (unix) {
            try {
              // The group outlives its leader while anything in it runs.
              process.kill(-child.pid, signal);
              return;
            } catch {
              // No group (it's gone): signal the child itself, below.
            }
          }
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        },
      };
    },
  };
}

// How harness processes are started. `direct` runs them as child processes, which end with the
// backend; a `shim` spawner that runs them detached and survives a restart comes later, behind the
// same interface.

import { spawn as spawnChild } from "node:child_process";
import { createInterface } from "node:readline";

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
}

export interface HarnessProcess {
  readonly pid: number | undefined;
  /** Writes a line to its stdin. */
  write(line: string): void;
  /** Closes its stdin. */
  closeInput(): void;
  /** Signals it, and whatever it started (its process group, where there is one). */
  kill(signal?: NodeJS.Signals): void;
}

export interface Spawner {
  readonly name: "direct" | "shim";
  spawn(options: SpawnOptions, handlers: ProcessHandlers): HarnessProcess;
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
      // 'close' comes after the process exits and its stdio ends, so after the last line.
      child.on("close", (code, signal) => handlers.exit({ code, signal, ...(error ? { error } : {}) }));
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
          if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
          try {
            if (unix) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            child.kill(signal);
          }
        },
      };
    },
  };
}

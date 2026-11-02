// A thread's launch options (LaunchOptions), as the core and the drivers keep them, and as they're
// stored: in the stored thread's `launch` field, and in a run's checkpoint, with the other
// backends' snake_case keys.

import type { Thread } from "@dire-kiwi/agent-threads-protocol";
import type { LaunchOptions, ThreadContext } from "./harness.js";

/** Launch options as they're stored: each field left out when it's empty. */
export interface StoredLaunch {
  args?: string[];
  env?: { [k: string]: string | null };
  add_dirs?: string[];
  config_dir?: string;
}

/** A thread as the store keeps it: with its launch options, which clients aren't sent. */
export type StoredThread = Thread & { launch?: StoredLaunch };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The launch options with only the fields that are set, and the environment's variables in order
 * (undefined values, and anything that isn't a string, are left out): two that do the same are
 * equal as JSON.
 */
export function normalLaunch(l: LaunchOptions | undefined): LaunchOptions {
  if (!l) return {};
  const args = strings(l.args);
  const addDirs = strings(l.addDirs);
  const env: { [k: string]: string | null } = {};
  for (const k of Object.keys(l.env ?? {}).sort()) {
    const v = l.env![k];
    if (typeof v === "string" || v === null) env[k] = v;
  }
  return {
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(addDirs.length ? { addDirs } : {}),
    ...(typeof l.configDir === "string" && l.configDir ? { configDir: l.configDir } : {}),
  };
}

export const isEmptyLaunch = (l: LaunchOptions): boolean => Object.keys(normalLaunch(l)).length === 0;

export const sameLaunch = (a: LaunchOptions, b: LaunchOptions): boolean => JSON.stringify(normalLaunch(a)) === JSON.stringify(normalLaunch(b));

/** The launch options as they're stored, or undefined if they're empty. */
export function storedLaunch(l: LaunchOptions): StoredLaunch | undefined {
  const n = normalLaunch(l);
  const out: StoredLaunch = {
    ...(n.args ? { args: n.args } : {}),
    ...(n.env ? { env: n.env } : {}),
    ...(n.addDirs ? { add_dirs: n.addDirs } : {}),
    ...(n.configDir ? { config_dir: n.configDir } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** Launch options stored (as storedLaunch() gives them), or none. */
export function launchFromStored(v: unknown): LaunchOptions {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const s = v as { [k: string]: unknown };
  const env = s.env && typeof s.env === "object" && !Array.isArray(s.env) ? (s.env as LaunchOptions["env"]) : undefined;
  return normalLaunch({
    args: strings(s.args),
    ...(env ? { env } : {}),
    addDirs: strings(s.add_dirs),
    ...(typeof s.config_dir === "string" ? { configDir: s.config_dir } : {}),
  });
}

/** The thread as the store keeps it, with these launch options. */
export function storedThread(thread: Thread, launch: LaunchOptions): StoredThread {
  const l = storedLaunch(launch);
  return l ? { ...thread, launch: l } : thread;
}

/** A stored thread as clients see it, and its launch options. */
export function splitStored(stored: Thread): { thread: Thread; launch: LaunchOptions } {
  const { launch, ...thread } = stored as StoredThread;
  return { thread, launch: launchFromStored(launch) };
}

/** Makes the launch options' changes to an environment (the backend's, with the harness options' changes). */
export function applyLaunchEnv(env: NodeJS.ProcessEnv, launch: LaunchOptions): NodeJS.ProcessEnv {
  for (const [k, v] of Object.entries(launch.env ?? {})) {
    if (typeof v === "string") env[k] = v;
    else if (v === null) delete env[k];
  }
  return env;
}

/** An environment: the backend's, with `changes` (undefined removes a variable). */
export function withEnv(changes: { [k: string]: string | undefined } | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * The thread's options a process is started with, kept in its run's checkpoint: a process started
 * with other ones than the thread's now is replaced at the next turn.
 */
export interface Launched {
  model?: string;
  effort?: string;
  permission_mode?: string;
  launch?: StoredLaunch;
  /**
   * Claude Code was started in bypass mode, so it can be switched to it (it refuses otherwise). The
   * model and permission mode are those it has now: it takes new ones as it runs.
   */
  bypass?: boolean;
}

/** The options a process started for the thread now has. */
export function launchedOf(ctx: ThreadContext): Launched {
  const t = ctx.thread;
  const launch = storedLaunch(ctx.launch);
  return {
    ...(t.model !== undefined ? { model: t.model } : {}),
    ...(t.effort !== undefined ? { effort: t.effort } : {}),
    ...(t.permission_mode !== undefined ? { permission_mode: t.permission_mode } : {}),
    ...(launch ? { launch } : {}),
  };
}

/** Whether a process started with `l` has the thread's options now. */
export function launchedNow(l: Launched | undefined, ctx: ThreadContext): boolean {
  if (!l) return false;
  const now = launchedOf(ctx);
  return l.model === now.model && l.effort === now.effort && l.permission_mode === now.permission_mode && sameLaunch(launchFromStored(l.launch), ctx.launch);
}

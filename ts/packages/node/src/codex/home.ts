// The app's own CODEX_HOME: where Codex keeps the app's sessions (which thread/resume needs), with
// none of the user's config, MCP servers, skills or history, but with their login linked in.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The user's own CODEX_HOME. */
export function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** The app's CODEX_HOME when it doesn't name one. */
export function defaultCodexHome(): string {
  return join(homedir(), ".agent-threads", "codex");
}

/**
 * Makes the app's CODEX_HOME, with the login (auth.json) from `login` linked in if it has none of
 * its own (or copied, where links can't be made). A link keeps it the user's login: when Codex
 * refreshes its tokens, the user's own Codex sees them.
 */
export function prepareCodexHome(home: string, login: string | false): string {
  const dir = resolve(home);
  mkdirSync(dir, { recursive: true });
  if (login === false) return dir;
  const from = resolve(login, "auth.json");
  const to = join(dir, "auth.json");
  if (from === to || !existsSync(from)) return dir;
  // A link whose login has gone is made again; a login of the app's own is left alone.
  if (present(to) && (existsSync(to) || !lstatSync(to).isSymbolicLink())) return dir;
  if (present(to)) unlinkSync(to);
  try {
    symlinkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
  return dir;
}

/** Whether there's something at the path (a broken link counts). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** What the driver keeps about a Codex session, next to Codex's own record of it. */
export interface SessionState {
  /** The dynamic tools the session was started with, which Codex keeps for it (resuming can't change them). */
  dynamicTools: { name: string; description: string; inputSchema: unknown }[];
  /** Codex's token totals for the session after its last turn. */
  totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteInputTokens?: number } | null;
}

const statePath = (home: string, session: string) => join(home, "agent-threads", "sessions", `${encodeURIComponent(session)}.json`);

/** The session's state, or null if there's none (it was started elsewhere, or by an older driver). */
export function readSessionState(home: string, session: string): SessionState | null {
  try {
    const s = JSON.parse(readFileSync(statePath(home, session), "utf8"));
    return Array.isArray(s?.dynamicTools) ? { dynamicTools: s.dynamicTools, totals: s.totals ?? null } : null;
  } catch {
    return null;
  }
}

export function writeSessionState(home: string, session: string, state: SessionState): void {
  const path = statePath(home, session);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

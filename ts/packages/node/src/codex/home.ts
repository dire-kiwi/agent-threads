// The app's own CODEX_HOME: where Codex keeps the app's sessions (which thread/resume needs), with
// none of the user's config, MCP servers, skills or history, but with their login linked in.

import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

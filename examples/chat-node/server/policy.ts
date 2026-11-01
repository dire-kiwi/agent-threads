// The app's permission policy: allow what only reads, and ask the user about everything else (the
// frontend shows a permission card). It's plain code, run for each tool call the agent wants to make.

import type { PermissionPolicy } from "@dire-kiwi/agent-threads-node";

/** Tools that only read: the app's own lookup, and Claude loading a skill. */
const READ_ONLY_TOOLS = new Set(["lookup_order", "Skill"]);

/** Programs that only read what they're given (Codex reads files, its skills included, with these). */
const READERS = new Set(["cat", "head", "tail", "ls", "wc", "grep", "pwd", "nl", "stat"]);

/**
 * Whether a shell command only reads: one of READERS, or `sed -n '<lines>p' <files>`, with no shell
 * syntax (pipes, redirections, substitutions, several commands) that could make it do anything
 * else, and no globs: the shell would expand those into names the check never sees, and a file
 * called `-i` would make `sed -n 1p *` edit files in place.
 */
export function readsOnly(command: string): boolean {
  if (/[;&|<>`$(){}\n\\"]/.test(command)) return false;
  // Words: each either quoted whole in single quotes (nothing in them is expanded) or not quoted at all.
  const words: string[] = [];
  for (const [, quoted, bare] of command.trim().matchAll(/'([^']*)'(?=\s|$)|(\S+)/g)) {
    if (quoted !== undefined) words.push(quoted);
    else if (/['*?[\]]/.test(bare!)) return false; // a quote partway through a word, or a glob
    else words.push(bare!);
  }
  const [program, ...args] = words;
  // GNU sed takes options anywhere (`sed -n 1p -i file` edits in place, `-e 'w file'` writes), so
  // after the script there must be only files, none that looks like an option.
  if (program === "sed") return args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1] ?? "") && args.length > 2 && args.slice(2).every((a) => !a.startsWith("-"));
  return !!program && READERS.has(program);
}

export const permissions: PermissionPolicy = (q) => {
  if (q.kind === "read" || q.kind === "search" || READ_ONLY_TOOLS.has(q.name)) return "allow";
  if (q.kind === "shell" && q.command && readsOnly(q.command)) return "allow";
  return "ask";
};

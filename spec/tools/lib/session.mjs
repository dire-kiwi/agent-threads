// Reading a fixture's session.jsonl: a meta line, then each run's entries in order.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} path a fixture directory, or its session.jsonl
 * @returns {{ meta: any, runs: Map<number, any[]> }}
 */
export function loadSession(path) {
  const file = statSync(path).isDirectory() ? join(path, "session.jsonl") : path;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines[0]?.dir === "meta" ? lines.shift() : {};
  const runs = new Map();
  for (const e of lines) {
    if (!runs.has(e.run)) runs.set(e.run, []);
    runs.get(e.run).push(e);
  }
  return { meta, runs };
}

/** The value of a flag (`--flag value` or `--flag=value`), true for one with no value, or undefined. */
export function flag(argv, name, takesValue = true) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return takesValue ? argv[i + 1] : true;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

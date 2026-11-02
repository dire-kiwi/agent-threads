// The spec directory, and temporary directories, for the tests.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { MemoryState, MemoryStore } from "../stores/memory.js";

export const specDir = fileURLToPath(new URL("../../../../../spec/", import.meta.url));

export const readJson = (path: string): unknown => JSON.parse(readFileSync(join(specDir, path), "utf8"));

export const readJsonl = (path: string): unknown[] =>
  readFileSync(join(specDir, path), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new temporary directory, removed after the test file's tests. */
export function tempDir(prefix = "agent-threads-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

let shimBin: string | undefined;

/**
 * agent-threads-shim, built from ../../../../../shim if it isn't yet (or from $AGENT_THREADS_SHIM).
 * Building it needs cargo.
 */
export function shimPath(): string {
  if (shimBin) return shimBin;
  const given = process.env.AGENT_THREADS_SHIM;
  if (given) return (shimBin = given);
  const dir = fileURLToPath(new URL("../../../../../shim/", import.meta.url));
  const bin = join(dir, "target", "debug", "agent-threads-shim");
  if (!existsSync(bin)) execFileSync("cargo", ["build", "--quiet", "--manifest-path", join(dir, "Cargo.toml")], { stdio: "inherit" });
  return (shimBin = bin);
}

/**
 * What `store` holds now, in a store of its own: as a backend that stopped without closing left
 * it, for another to load (the first's processes, still running, can't change it).
 */
export function crashed(store: MemoryStore): MemoryStore {
  const copy = new MemoryState();
  copy.threads = structuredClone(store.state.threads);
  copy.events = structuredClone(store.state.events);
  copy.snapshots = structuredClone(store.state.snapshots);
  copy.runs = structuredClone(store.state.runs);
  return new MemoryStore(copy);
}

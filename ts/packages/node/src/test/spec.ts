// The spec directory, and temporary directories, for the tests.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

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

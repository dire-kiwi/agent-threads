// Where the fixtures are.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesDir = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/** Every fixture's directory (spec/fixtures/<harness>/<scenario>), sorted. */
export function fixtureDirs() {
  const dirs = [];
  for (const h of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!h.isDirectory()) continue;
    for (const s of readdirSync(join(fixturesDir, h.name), { withFileTypes: true })) {
      if (s.isDirectory() && existsSync(join(fixturesDir, h.name, s.name, "session.jsonl"))) dirs.push(join(fixturesDir, h.name, s.name));
    }
  }
  return dirs.sort();
}

// The app's skills, written out as a directory of `<name>/SKILL.md`s for a harness to load.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Skill } from "./harness.js";

/** Writes the skills into `root` (a skill given as a directory is copied, with what it refers to). */
export function writeSkills(root: string, skills: Skill[]): string {
  mkdirSync(root, { recursive: true });
  for (const s of skills) {
    if (typeof s === "string") cpSync(resolve(s), join(root, basename(resolve(s))), { recursive: true });
    else {
      mkdirSync(join(root, s.name), { recursive: true });
      writeFileSync(join(root, s.name, "SKILL.md"), s.content);
    }
  }
  return root;
}

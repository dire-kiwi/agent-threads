// The examples in spec/examples, for the tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const specDir = fileURLToPath(new URL("../../../../spec/", import.meta.url));

export const readJson = (path: string): unknown => JSON.parse(readFileSync(specDir + path, "utf8"));

export const readJsonl = (path: string): unknown[] =>
  readFileSync(specDir + path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

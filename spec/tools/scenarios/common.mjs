// What the Claude and Codex scenarios share: the files each session starts with, the app tool, and
// the external MCP server.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The working directory every session starts in (shown as /work in the fixtures). */
export function seedWorkdir(dir) {
  writeFileSync(join(dir, "notes.txt"), "apple\nbanana\ncherry\n");
}

/** The app-defined tool the app-tool scenarios register, and the answer the app gives. */
export const appTool = {
  name: "lookup_order",
  description: "Looks up an order by its id and says what's in it and whether it has shipped.",
  input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  result: "Order 42: 3 blue widgets, shipped on 2026-10-30.",
};

/** The external stdio MCP server the mcp-tool scenarios attach. */
export const echoServer = {
  command: "node",
  args: [fileURLToPath(new URL("../mcp-echo.mjs", import.meta.url))],
};

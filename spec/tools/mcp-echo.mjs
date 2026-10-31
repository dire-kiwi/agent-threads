#!/usr/bin/env node
// A tiny stdio MCP server with one tool, echo, for the mcp-tool fixtures. It's what those sessions
// were recorded with; when replaying, the fake CLI never starts it.
//
//   node spec/tools/mcp-echo.mjs

import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echoes the text it's given, prefixed with 'echo: '.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // a notification
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      });
    case "tools/list":
      return reply(msg.id, { tools });
    case "tools/call":
      return reply(msg.id, { content: [{ type: "text", text: `echo: ${msg.params.arguments?.text ?? ""}` }] });
    case "ping":
      return reply(msg.id, {});
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } }) + "\n");
  }
});

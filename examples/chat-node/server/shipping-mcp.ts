// The external MCP server: a stand-in for a courier's tracking service, as a stdio MCP server with
// one tool, track_parcel. The harness (Claude Code or Codex) starts it, not the backend, and its
// calls go through the app's permission policy like any other tool's.
//
//   node server/shipping-mcp.ts

import { createInterface } from "node:readline";

// A Map, so an order id like `__proto__` or `toString` is just one that isn't there.
const PARCELS = new Map<string, { tracking: string; events: string[] }>(Object.entries({
  "42": {
    tracking: "NZP-4410-2291",
    events: ["2026-10-30 09:12 Picked up in Auckland", "2026-10-31 06:40 At the Christchurch depot", "2026-11-01 08:05 Out for delivery"],
  },
  "1001": {
    tracking: "NZP-3982-0017",
    events: ["2026-10-21 10:30 Picked up in Auckland", "2026-10-22 14:02 Delivered, left at the front door"],
  },
}));

const tools = [
  {
    name: "track_parcel",
    description: "Tracks the parcel an order was shipped in: its tracking number and where it has been.",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
];

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg: { id?: number | string; method?: string; params?: any };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // a notification
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shipping", version: "1.0.0" } },
      });
    case "tools/list":
      return send({ id: msg.id, result: { tools } });
    case "tools/call": {
      const id = String(msg.params?.arguments?.order_id ?? "").replace(/^#/, "");
      const parcel = PARCELS.get(id);
      const text = parcel ? `Parcel ${parcel.tracking} for order ${id}:\n${parcel.events.join("\n")}` : `No parcel has been shipped for order ${id}.`;
      return send({ id: msg.id, result: { content: [{ type: "text", text }], ...(parcel ? {} : { isError: true }) } });
    }
    case "ping":
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
});

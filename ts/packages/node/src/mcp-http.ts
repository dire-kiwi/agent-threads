// A loopback MCP server for the app's tools, over streamable HTTP: for a harness that can't take
// them any other way (Codex without dynamic tools). It listens on 127.0.0.1 on a random port and
// takes only requests with its bearer token. It answers each POST with JSON (no SSE streams), which
// streamable HTTP allows.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "./tools.js";

export interface ToolServerHandlers {
  /** The tools to list. */
  tools(): Tool[];
  /** Runs one. */
  call(name: string, args: unknown): Promise<{ text: string; isError: boolean; structured?: unknown }>;
}

export interface LoopbackMcp {
  /** Its endpoint, http://127.0.0.1:<port>/mcp. */
  readonly url: string;
  /** The bearer token requests must have. */
  readonly token: string;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024 * 1024;

type Json = { [k: string]: any };

/**
 * Starts a loopback MCP server for the tools: on a new port with a new token, or on those of one
 * before it (for a process configured with it that outlived the backend).
 */
export async function serveTools(name: string, handlers: ToolServerHandlers, again?: { port: number; token: string }): Promise<LoopbackMcp> {
  const token = again?.token ?? randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const answer = async (msg: Json): Promise<Json | null> => {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg?.id !== undefined ? { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request" } } : null;
    }
    if (msg.id === undefined || msg.id === null) return null; // a notification
    const reply = (body: Json) => ({ jsonrpc: "2.0", id: msg.id, ...body });
    switch (msg.method) {
      case "initialize":
        return reply({
          result: {
            protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name, version: "1.0.0" },
          },
        });
      case "ping":
        return reply({ result: {} });
      case "tools/list":
        return reply({ result: { tools: handlers.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) } });
      case "tools/call": {
        const out = await handlers.call(String(msg.params?.name ?? ""), msg.params?.arguments ?? {});
        return reply({
          result: {
            content: [{ type: "text", text: out.text }],
            ...(out.isError ? { isError: true } : {}),
            ...(out.structured !== undefined ? { structuredContent: out.structured } : {}),
          },
        });
      }
      default:
        return reply({ error: { code: -32601, message: `method ${msg.method} isn't supported` } });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") return void res.writeHead(404).end();
    if (!authorized(req)) return void res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST, DELETE" }).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return void res.writeHead(413).end();
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return void json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? (body as unknown[]) : [body]).map((m) => answer(m as Json)))).filter((r): r is Json => r !== null);
    if (!replies.length) return void res.writeHead(202).end();
    json(res, 200, batch ? replies : replies[0]);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(again?.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }).end(text);
}

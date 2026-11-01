// The chat example's server: agent-threads' Node backend, and the app's own transport, a
// WebSocket. The SDK has no network layer, so this file is the whole "seam": events out
// (sdk.subscribe → every client), commands in (a client's `command` → sdk.handle), plus snapshots
// and eventsSince for clients that connect or reconnect. examples/PROTOCOL.md has the wire format.
//
//   node server/main.ts      (or pnpm dev / pnpm start; see the README)

import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentThreads,
  CommandError,
  SqliteStore,
  claudeCode,
  codex,
  direct,
  shim,
  type Harness,
  type PermissionPolicy,
  type Thread,
} from "@dire-kiwi/agent-threads-node";
import { config, REPO, RESTART_CODE, ROOT, type HarnessInfo } from "./config.ts";
import { lookupOrder } from "./orders.ts";
import { serveStatic } from "./static.ts";

const cfg = config();
const workspace = join(cfg.data, "workspace"); // the agents' working directory
mkdirSync(workspace, { recursive: true });

// ---------- the backend ----------

/** Allow what only reads (files, searches, the app's own lookup, loading a skill); ask the user about everything else. */
const READ_ONLY_TOOLS = new Set(["lookup_order", "Skill"]);
const permissions: PermissionPolicy = (q) => (q.kind === "read" || q.kind === "search" || READ_ONLY_TOOLS.has(q.name) ? "allow" : "ask");

const FAKE_CLI = join(REPO, "spec/tools/fake-cli.mjs");

function harness(h: HarnessInfo): Harness {
  // With a fixture, the fake CLI replays its recorded session (and checks what we send it).
  const fake = h.fake
    ? (() => {
        // Where it keeps which of the session's runs is next: afresh each time, unless it's given
        // (CHAT_FAKE_STATE, so a session that has several runs can carry on after a restart).
        const state = process.env.CHAT_FAKE_STATE ? join(process.env.CHAT_FAKE_STATE, h.name) : join(cfg.data, `fake-${h.name}`);
        if (!process.env.CHAT_FAKE_STATE) rmSync(state, { recursive: true, force: true });
        mkdirSync(state, { recursive: true });
        return { bin: process.execPath, binArgs: [FAKE_CLI], env: { AGENT_THREADS_FIXTURE: h.fake, AGENT_THREADS_FIXTURE_STATE: state } };
      })()
    : {};
  if (h.name === "claude") return claudeCode({ ...fake });
  // Codex keeps the app's sessions in a CODEX_HOME of the app's own (with the user's login linked in).
  return codex({ ...fake, home: join(cfg.data, "codex-home") });
}

const sdk = new AgentThreads({
  store: new SqliteStore(join(cfg.data, "threads.db")),
  harnesses: Object.fromEntries(cfg.harnesses.map((h) => [h.name, harness(h)])),
  spawner: cfg.shim ? shim(cfg.shim, { runsDir: join(cfg.data, "runs") }) : direct(),
  // The recorded sessions had no MCP server or skill, and the fake CLI checks that.
  tools: !cfg.fake || cfg.fake.tools ? [lookupOrder] : [],
  ...(cfg.fake
    ? {}
    : {
        mcpServers: { shipping: { command: process.execPath, args: [join(ROOT, "server/shipping-mcp.ts")] } },
        skills: [join(ROOT, "skills/order-support")],
      }),
  permissions,
  systemPrompt: "You're the support agent for Widget Co., a small online shop. Use the order-support skill for questions about orders.",
});

// Runs that outlived the last server (with the shim) carry on from where it left them.
if (cfg.shim) {
  const { reattached, lost } = await sdk.recover();
  if (reattached.length || lost.length) console.log(`recovered: ${reattached.length} run(s) re-attached, ${lost.length} lost`);
}

// ---------- the transport ----------

const http = createServer((req, res) => serveStatic(join(ROOT, "web/dist"), req, res));
const wss = new WebSocketServer({ server: http, path: "/ws" });

// Events out: every thread's events (deltas included) to every client, as they happen.
const clients = new Set<WebSocket>();
sdk.subscribe((event) => {
  const frame = JSON.stringify({ type: "event", event });
  for (const ws of clients) ws.send(frame);
});

type Request = { id: number; method: string; params?: any };

/** The app's methods: what a client asks for, and what the backend says (see examples/PROTOCOL.md). */
const methods: { [name: string]: (params: any) => unknown } = {
  hello: () => ({
    harnesses: cfg.harnesses.map(({ name, label, model, models }) => ({ name, label, model, models })),
    restart: cfg.supervised,
  }),
  list: async () => (await sdk.list()).sort(newestFirst),
  create: (p: { harness?: string; model?: string; title?: string }) => {
    const h = cfg.harnesses.find((h) => h.name === p.harness);
    if (!h) throw new CommandError(`there's no harness ${JSON.stringify(p.harness)}`);
    return sdk.create({
      harness: h.name,
      model: p.model || h.model,
      ...(h.effort ? { effort: h.effort } : {}),
      ...(p.title ? { title: p.title.slice(0, 80) } : {}),
      cwd: workspace,
    });
  },
  snapshot: (p: { thread_id: string }) => sdk.snapshot(p.thread_id),
  events_since: (p: { thread_id: string; seq: number }) => sdk.eventsSince(p.thread_id, p.seq),
  // Commands in: send, interrupt, respond and set_options, checked and carried out by the backend.
  command: async (p: { command: unknown }) => {
    await sdk.handle(p.command as any);
    return null;
  },
  restart: () => {
    if (!cfg.supervised) throw new Error("this server isn't run by supervise.ts, so it can't restart");
    setTimeout(() => void shutdown(RESTART_CODE), 50);
    return null;
  },
};

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (data) => {
    let req: Request;
    try {
      req = JSON.parse(String(data));
    } catch {
      return;
    }
    const reply = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id: req.id, ...msg }));
    const method = methods[req.method];
    if (!method) return reply({ error: `there's no method ${JSON.stringify(req.method)}` });
    try {
      reply({ result: (await method(req.params ?? {})) ?? null });
    } catch (e) {
      // A CommandError is the client's mistake (an unknown thread, a malformed command); anything else is ours.
      if (!(e instanceof CommandError)) console.error(`${req.method}:`, e);
      reply({ error: e instanceof Error ? e.message : String(e) });
    }
  });
});

http.listen(cfg.port, "127.0.0.1", () => {
  const what = cfg.harnesses.map((h) => `${h.name}${h.fake ? " (fake)" : ""}`).join(", ");
  console.log(`chat-node on http://127.0.0.1:${cfg.port} with ${what}${cfg.shim ? ", under the shim" : ""}; data in ${cfg.data}`);
});

// ---------- shutting down ----------

let stopping: Promise<void> | undefined;
function shutdown(code = 0): Promise<void> {
  stopping ??= (async () => {
    for (const ws of clients) ws.close(1012, "restarting");
    wss.close();
    http.close();
    // Stops the harness processes, or with the shim leaves them running for the next server to re-attach to.
    await sdk.close().catch((e) => console.error("close:", e));
    await sdk.store.close?.(); // The store is the app's to close.
    process.exit(code);
  })();
  return stopping;
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function newestFirst(a: Thread, b: Thread): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

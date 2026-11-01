// The chat example's server: agent-threads' Node backend, and the app's own transport, a
// WebSocket. The SDK has no network layer, so this file is the whole "seam": events out
// (sdk.subscribe → every client), commands in (a client's `command` → sdk.handle), plus snapshots
// and eventsSince for clients that connect or reconnect. examples/PROTOCOL.md has the wire format.
//
//   node server/main.ts      (or pnpm dev / pnpm start; see the README)

import { mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
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
  type Thread,
} from "@dire-kiwi/agent-threads-node";
import { config, DEV_PORT, REPO, RESTART_CODE, ROOT, type HarnessInfo } from "./config.ts";
import { lookupOrder } from "./orders.ts";
import { permissions } from "./policy.ts";
import { serveStatic } from "./static.ts";

const cfg = config();
const workspace = join(cfg.data, "workspace"); // the agents' working directory
mkdirSync(workspace, { recursive: true });

// ---------- the backend ----------

const FAKE_CLI = join(REPO, "spec/tools/fake-cli.mjs");

/** The fake CLI, replaying a fixture's recorded session (and checking what the backend sends it). */
function fakeCli(name: string, fixture: string) {
  // Where it keeps which of the session's runs is next: afresh each time, or kept across restarts
  // in CHAT_FAKE_STATE, for a session that has several runs.
  const state = cfg.fakeState ? join(cfg.fakeState, name) : join(cfg.data, `fake-${name}`);
  if (!cfg.fakeState) rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  return { bin: process.execPath, binArgs: [FAKE_CLI], env: { AGENT_THREADS_FIXTURE: fixture, AGENT_THREADS_FIXTURE_STATE: state } };
}

function harness(h: HarnessInfo): Harness {
  const fake = h.fake ? fakeCli(h.name, h.fake) : {};
  if (h.name === "claude") return claudeCode(fake);
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

/**
 * Whether a WebSocket may connect. Listening on 127.0.0.1 isn't enough: any page the user has open
 * can open a WebSocket to it, and the socket can read every thread, send the agent anything and
 * allow its own permission requests. So it must come from this app's own page (its Origin is the
 * host it connects to), on a loopback name (which a rebound DNS name isn't), at this server or
 * Vite's dev server (whose proxy keeps the Host and Origin). Clients that aren't browsers send no
 * Origin. This is the example's only check: a real app authenticates its users here too.
 */
function trusted(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!TRUSTED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
const TRUSTED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"].flatMap((name) => [cfg.port, DEV_PORT].map((port) => `${name}:${port}`)));

const wss = new WebSocketServer({ server: http, path: "/ws", verifyClient: ({ req }: { req: IncomingMessage }) => trusted(req) });

// Events out: every thread's events (deltas included) to every client, as they happen.
const clients = new Set<WebSocket>();
sdk.subscribe((event) => {
  const frame = JSON.stringify({ type: "event", event });
  for (const ws of clients) ws.send(frame);
});

type Request = { id: number | string; method: string; params?: any };

/** Whether a frame is a request: anything else is ignored (with no id, it can't be answered). */
const isRequest = (r: unknown): r is Request =>
  typeof r === "object" &&
  r !== null &&
  (typeof (r as Request).id === "number" || typeof (r as Request).id === "string") &&
  typeof (r as Request).method === "string" &&
  ((r as Request).params === undefined || (typeof (r as Request).params === "object" && (r as Request).params !== null));

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
    let req: unknown;
    try {
      req = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!isRequest(req)) return;
    const { id, method: name, params } = req;
    const reply = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ...msg }));
    const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
    if (!method) return reply({ error: `there's no method ${JSON.stringify(name)}` });
    try {
      reply({ result: (await method(params ?? {})) ?? null });
    } catch (e) {
      // A CommandError is the client's mistake (an unknown thread, a malformed command); anything else is ours.
      if (!(e instanceof CommandError)) console.error(`${name}:`, e);
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

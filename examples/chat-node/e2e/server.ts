// Starts the chat server for a test, on a free port with a data directory of its own.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "../../spec/fixtures");
export const SHIM = join(ROOT, "../../shim/target/debug/agent-threads-shim");

export interface Server {
  url: string;
  env: { [k: string]: string };
  /** Resolves each time the server says it's listening (again, after a restart). */
  listening(): Promise<void>;
  stop(): Promise<void>;
}

export async function startServer(env: { [k: string]: string }, { supervised = false, port: given }: { supervised?: boolean; port?: number } = {}): Promise<Server> {
  const port = given ?? (await freePort());
  const data = env.CHAT_DATA ?? mkdtempSync(join(tmpdir(), "chat-e2e-"));
  const all = { ...env, PORT: String(port), CHAT_DATA: data };
  const proc: ChildProcess = spawn(process.execPath, [join(ROOT, supervised ? "server/supervise.ts" : "server/main.ts")], {
    env: { ...process.env, ...all },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let waiting: (() => boolean)[] = [];
  let starts = 0;
  createInterface({ input: proc.stdout! }).on("line", (line) => {
    process.stdout.write(`[server] ${line}\n`);
    if (line.startsWith("chat-node on")) {
      starts++;
      waiting = waiting.filter((w) => !w());
    }
  });
  const exited = new Promise<void>((r) => proc.on("exit", () => r()));
  let seen = 0;
  const server: Server = {
    url: `http://127.0.0.1:${port}`,
    env: all,
    listening: () => {
      // The next start after the last one waited for.
      const want = ++seen;
      return starts >= want ? Promise.resolve() : new Promise((r) => waiting.push(() => starts >= want && (r(), true)));
    },
    stop: async () => {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => {
        process.stdout.write("[server] didn't stop within 15s: killing it\n");
        proc.kill("SIGKILL");
      }, 15_000);
      await exited;
      clearTimeout(timer);
    },
  };
  // Not for ever: say why if it doesn't start.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    server.listening(),
    exited.then(() => Promise.reject(new Error("the server exited before it was listening"))),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the server didn't start within 20s")), 20_000))),
  ]).finally(() => clearTimeout(timer));
  return server;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

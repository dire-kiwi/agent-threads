// pnpm dev: the server (under supervise.ts) and Vite's dev server for the frontend, which proxies
// /ws to it. Open http://localhost:5173.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./config.ts";

const children = [
  spawn(process.execPath, [join(ROOT, "server/supervise.ts")], { stdio: "inherit", env: { ...process.env, CHAT_DEV: "1" } }),
  spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js")], { stdio: "inherit", cwd: ROOT }),
];
for (const c of children) c.on("exit", (code) => {
  for (const o of children) if (o !== c) o.kill("SIGTERM");
  process.exitCode = code ?? 0;
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => children.forEach((c) => c.kill(sig)));

// Runs the server, and starts it again when it exits asking to (the frontend's Restart button, for
// the restart demo): with CHAT_SHIM set, its harness runs carry on meanwhile, and the new server
// re-attaches to them.
//
//   node server/supervise.ts      (pnpm start)

import { spawn } from "node:child_process";
import { join } from "node:path";
import { RESTART_CODE, ROOT } from "./config.ts";

let child: ReturnType<typeof spawn> | undefined;

function run(): void {
  child = spawn(process.execPath, [join(ROOT, "server/main.ts")], { stdio: "inherit", env: { ...process.env, CHAT_SUPERVISED: "1" } });
  child.on("exit", (code, signal) => {
    if (code === RESTART_CODE) {
      console.log("restarting the server…");
      return run();
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Ctrl-C goes to the whole process group, so the server gets it too and shuts down by itself.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child?.kill(sig));
run();

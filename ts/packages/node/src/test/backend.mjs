// A backend in a process of its own, for restart.test.ts to kill: the built package (dist), with a
// FileStore, the shim spawner, and Claude Code and Codex played by the fake CLI. It takes commands on stdin,
// one JSON object a line ({id, op, args}), and writes each reply ({reply: id, result} or {reply: id,
// error}) and every event ({event}) to stdout, a line each.
//
// Environment: STORE, RUNS, CODEX_HOME_DIR (directories), SHIM (the binary), FAKE_CLI, and the fake
// CLI's own (AGENT_THREADS_FIXTURE...). POLICY is the permission policy (allow or ask), and
// LATE_ANSWERS turns lateAnswers on. CLAUDE_BIN
// and CODEX_BIN run another `claude` or `codex` (mini-claude.mjs, mini-codex.mjs) instead of the
// fake CLI. With TOOL_MARKER, there's an app
// tool `lookup`, which appends a line to that file each time it runs, and then (with TOOL_HANG)
// doesn't return. STOP_GRACE_MS and CLOSE_GRACE_MS are the drivers' stopGraceMs and closeGraceMs.
// With SAVE_DELAY_MS, each save (appendEvents) takes that long. SPAWNER=direct runs the harnesses
// as its own children instead of under the shim. IDLE_CLOSE_MS is idleCloseMs.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { AgentThreads, FileStore, claudeCode, codex, defineTool, direct, shim } from "../../dist/index.js";

const env = process.env;
const fakeEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("AGENT_THREADS_FIXTURE")));
const graces = {
  ...(env.STOP_GRACE_MS ? { stopGraceMs: Number(env.STOP_GRACE_MS) } : {}),
  ...(env.CLOSE_GRACE_MS ? { closeGraceMs: Number(env.CLOSE_GRACE_MS) } : {}),
};
const store = new FileStore(env.STORE);
if (env.SAVE_DELAY_MS) {
  const append = store.appendEvents.bind(store);
  store.appendEvents = async (...args) => {
    await new Promise((r) => setTimeout(r, Number(env.SAVE_DELAY_MS)));
    return append(...args);
  };
}
const sdk = new AgentThreads({
  store,
  harnesses: {
    claude: claudeCode({ bin: env.CLAUDE_BIN ?? env.FAKE_CLI, env: fakeEnv, ...graces }),
    codex: codex({ bin: env.CODEX_BIN ?? env.FAKE_CLI, env: fakeEnv, home: env.CODEX_HOME_DIR, login: false, ...graces }),
  },
  permissions: env.POLICY ?? "allow",
  lateAnswers: !!env.LATE_ANSWERS,
  ...(env.IDLE_CLOSE_MS ? { idleCloseMs: Number(env.IDLE_CLOSE_MS) } : {}),
  tools: env.TOOL_MARKER
    ? [
        defineTool({
          name: "lookup",
          description: "Looks something up.",
          input: { type: "object" },
          run: async (_args, ctx) => {
            appendFileSync(env.TOOL_MARKER, "ran\n");
            if (env.TOOL_HANG) await new Promise((r) => ctx.signal.addEventListener("abort", r));
            return "found it";
          },
        }),
      ]
    : [],
  spawner: env.SPAWNER === "direct" ? direct() : shim(env.SHIM, { runsDir: env.RUNS, pollMs: 50 }),
  onError: (e) => process.stderr.write(`backend error: ${e?.stack ?? e}\n`),
});
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
sdk.subscribe((event) => out({ event }));

const ops = {
  create: (args) => sdk.create(args),
  handle: (command) => sdk.handle(command),
  snapshot: (id) => sdk.snapshot(id),
  // Resolves once every event so far is saved (and the run with them).
  saved: async (id) => void (await sdk.eventsSince(id, 0)),
  recover: () => sdk.recover(),
  release: (id) => sdk.release(id),
  close: async (options) => {
    await sdk.close(options);
    await sdk.store.close();
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, op, args = [] } = JSON.parse(line);
  try {
    out({ reply: id, result: (await ops[op](...args)) ?? null });
  } catch (e) {
    out({ reply: id, error: String(e?.stack ?? e) });
  }
  if (op === "close") process.stdout.write("", () => process.exit(0));
});

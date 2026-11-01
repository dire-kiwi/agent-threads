// A backend in a process of its own, for restart.test.ts to kill: the built package (dist), with a
// FileStore, the shim spawner and Claude Code played by the fake CLI. It takes commands on stdin,
// one JSON object a line ({id, op, args}), and writes each reply ({reply: id, result} or {reply: id,
// error}) and every event ({event}) to stdout, a line each.
//
// Environment: STORE, RUNS (directories), SHIM (the binary), FAKE_CLI, and the fake CLI's own
// (AGENT_THREADS_FIXTURE...). POLICY is the permission policy (allow or ask).

import { createInterface } from "node:readline";
import { AgentThreads, FileStore, claudeCode, shim } from "../../dist/index.js";

const env = process.env;
const fakeEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("AGENT_THREADS_FIXTURE")));
const sdk = new AgentThreads({
  store: new FileStore(env.STORE),
  harnesses: { claude: claudeCode({ bin: env.FAKE_CLI, env: fakeEnv }) },
  permissions: env.POLICY ?? "allow",
  spawner: shim(env.SHIM, { runsDir: env.RUNS, pollMs: 50 }),
  onError: (e) => process.stderr.write(`backend error: ${e?.stack ?? e}\n`),
});
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
sdk.subscribe((event) => out({ event }));

const ops = {
  create: (args) => sdk.create(args),
  handle: (command) => sdk.handle(command),
  snapshot: (id) => sdk.snapshot(id),
  recover: () => sdk.recover(),
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

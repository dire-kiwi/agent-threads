// What the server runs with, from its environment (see the README):
//
//   PORT                 the port, 3001 by default (on 127.0.0.1)
//   CHAT_DATA            where threads, runs and the agents' workspace go; ./data by default
//   CHAT_HARNESSES       the harnesses to offer, `claude,codex` by default
//   CHAT_CLAUDE_MODEL    the default model for new threads on Claude Code (haiku)
//   CHAT_CODEX_MODEL     and on Codex (gpt-5.6-luna, with effort CHAT_CODEX_EFFORT, low)
//   CHAT_SHIM            run the harnesses under agent-threads-shim, so they outlive the server:
//                        `1` for the one `make shim` builds, or the binary's path
//   CHAT_FAKE_CLAUDE     replay a recorded session (a spec/fixtures directory) with the fake CLI
//   CHAT_FAKE_CODEX      in place of the real one: for the tests, with no login needed
//   CHAT_FAKE_STATE      where the fake CLIs keep their state, kept across restarts (a fresh one by default)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // examples/chat-node
export const REPO = resolve(ROOT, "../..");

export interface HarnessInfo {
  name: string;
  label: string;
  /** The default model for new threads. */
  model: string;
  /** Models to suggest. */
  models: string[];
  /** The default effort, if the harness takes one. */
  effort?: string;
  /** The fixture to replay instead of running the real CLI. */
  fake?: string;
}

export interface Config {
  port: number;
  data: string;
  harnesses: HarnessInfo[];
  /** The agent-threads-shim binary, when runs should outlive the server. */
  shim?: string;
  /**
   * Replaying fixtures: no MCP server or skill, as they were recorded without them, and the app's
   * tool only if they were recorded with it (the fake CLI checks what the backend says it has).
   */
  fake: false | { tools: boolean };
  /** Started by supervise.ts, which starts it again when it exits for a restart. */
  supervised: boolean;
}

/** The exit code that asks supervise.ts to start the server again. */
export const RESTART_CODE = 75;

export function config(env = process.env): Config {
  const fakes: { [h: string]: string | undefined } = { claude: env.CHAT_FAKE_CLAUDE, codex: env.CHAT_FAKE_CODEX };
  const fake = Object.values(fakes).some(Boolean);
  const wanted = fake ? Object.keys(fakes).filter((h) => fakes[h]) : (env.CHAT_HARNESSES ?? "claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
  const all: { [name: string]: HarnessInfo } = {
    claude: { name: "claude", label: "Claude Code", model: env.CHAT_CLAUDE_MODEL || "haiku", models: ["haiku", "sonnet", "opus"] },
    codex: { name: "codex", label: "Codex", model: env.CHAT_CODEX_MODEL || "gpt-5.6-luna", models: ["gpt-5.6-luna", "gpt-5.6"], effort: env.CHAT_CODEX_EFFORT || "low" },
  };
  let fakeTools = true;
  const harnesses = wanted.map((name) => {
    const h = all[name];
    if (!h) throw new Error(`CHAT_HARNESSES: there's no harness ${name} (there's claude and codex)`);
    const dir = fakes[name];
    if (!dir) return h;
    // The model and effort the session was recorded with, which the fake CLI checks.
    const fixture = JSON.parse(readFileSync(join(resolve(dir), "fixture.json"), "utf8"));
    if (!fixture.tools?.some((t: { name: string }) => t.name === "lookup_order")) fakeTools = false;
    return { ...h, model: fixture.thread.model, models: [fixture.thread.model], effort: fixture.thread.effort, fake: resolve(dir) };
  });
  let shim: string | undefined;
  if (env.CHAT_SHIM && env.CHAT_SHIM !== "0") {
    shim = env.CHAT_SHIM === "1" ? join(REPO, "shim/target/debug/agent-threads-shim") : resolve(env.CHAT_SHIM);
    if (!existsSync(shim)) throw new Error(`CHAT_SHIM: there's no ${shim} (run make shim in the repository first)`);
  }
  return {
    port: Number(env.PORT || 3001),
    data: resolve(env.CHAT_DATA || join(ROOT, "data")),
    harnesses,
    ...(shim ? { shim } : {}),
    fake: fake && { tools: fakeTools },
    supervised: env.CHAT_SUPERVISED === "1",
  };
}

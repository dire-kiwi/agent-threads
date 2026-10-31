// Every Claude Code fixture in spec/fixtures/claude, run as spec/fixtures/README.md says: the SDK
// drives the fake CLI (which replays the recording and checks what it's sent), and its events must
// match expected.jsonl by spec/tools/check-events.mjs's rules. Its snapshot must be its events,
// folded.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { applyEvents, initialState, type Command, type Thread, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import { claudeCode } from "../claude/driver.js";
import type { McpServer } from "../harness.js";
import type { PermissionPolicy } from "../permissions.js";
import { MemoryStore } from "../stores/memory.js";
import { defineTool } from "../tools.js";
import { readJsonl, specDir, tempDir } from "./spec.js";

interface Fixture {
  thread: { harness: string; model?: string; effort?: string; permission_mode?: Thread["permission_mode"] };
  permissions?: "allow" | "ask";
  tools?: { name: string; description: string; input: { [k: string]: unknown }; result: string }[];
  mcp_servers?: { [name: string]: McpServer };
  steps: ({ command: { [k: string]: unknown } } | { wait: unknown } | { restart: true })[];
}

const { compare } = (await import(pathToFileURL(join(specDir, "tools/check-events.mjs")).href)) as {
  compare: (expected: unknown[], actual: unknown[]) => { ok: true } | { ok: false; error: string };
};

/** Whether a value has everything a pattern has (objects field by field, everything else exactly). */
function matches(v: unknown, p: unknown): boolean {
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return !!v && typeof v === "object" && Object.entries(p).every(([k, x]) => matches((v as Record<string, unknown>)[k], x));
  }
  return JSON.stringify(v) === JSON.stringify(p);
}

const fakeCli = join(specDir, "tools/fake-cli.mjs");
const WAIT_MS = 10_000;

const dir = join(specDir, "fixtures/claude");
const scenarios = readdirSync(dir).filter((s) => existsSync(join(dir, s, "session.jsonl"))).sort();

describe.each(scenarios)("claude/%s", (scenario) => {
  it("matches expected.jsonl", { timeout: 60_000 }, async () => {
    const fixtureDir = join(dir, scenario);
    const fixture = JSON.parse(readFileSync(join(fixtureDir, "fixture.json"), "utf8")) as Fixture;
    const cwd = tempDir();
    const state = tempDir();
    const store = new MemoryStore();
    const events: ThreadEvent[] = [];

    const make = () => {
      const sdk = new AgentThreads({
        store,
        harnesses: {
          claude: claudeCode({ bin: fakeCli, env: { AGENT_THREADS_FIXTURE: fixtureDir, AGENT_THREADS_FIXTURE_STATE: state } }),
        },
        tools: (fixture.tools ?? []).map((t) => defineTool({ name: t.name, description: t.description, input: t.input, run: () => t.result })),
        mcpServers: fixture.mcp_servers ?? {},
        permissions: (fixture.permissions ?? "allow") as PermissionPolicy,
        onError: (e) => {
          throw e;
        },
      });
      sdk.subscribe((e) => events.push(e));
      return sdk;
    };

    let sdk = make();
    const { harness, ...options } = fixture.thread;
    const thread = await sdk.create({ harness, ...options, cwd });
    let from = 0;
    for (const [i, step] of fixture.steps.entries()) {
      const where = `step ${i + 1}: ${JSON.stringify(step)}`;
      if ("restart" in step) {
        await sdk.close();
        sdk = make();
        from = events.length;
      } else if ("command" in step) {
        const command = { ...step.command, thread_id: thread.id } as Command;
        if (command.type === "respond") {
          const { requests } = await sdk.snapshot(thread.id);
          expect(requests, where).toHaveLength(1);
          command.request_id = requests[0]!.id;
        }
        from = events.length;
        await sdk.handle(command);
      } else {
        const at = await waitFor(events, from, step.wait);
        expect(at, `${where}: no such event within ${WAIT_MS}ms. Events since the step before:\n${show(events.slice(from))}`).toBeGreaterThanOrEqual(0);
        from = at + 1;
      }
    }

    // Its snapshot is its events, folded (deltas included).
    const snapshot = await sdk.snapshot(thread.id);
    expect(snapshot).toEqual(applyEvents(initialState(events[0]!.type === "thread.updated" ? events[0]!.thread : thread), events));

    await sdk.close();

    // The fake CLI was sent what the recording has, in every run.
    const runs = readJsonl(`fixtures/claude/${scenario}/session.jsonl`).filter((e) => (e as { dir?: string }).dir === "spawn").length;
    const reports = readdirSync(state).filter((f) => /^run-\d+\.json$/.test(f));
    expect(reports.sort()).toEqual(Array.from({ length: runs }, (_, n) => `run-${n + 1}.json`));
    for (const r of reports) expect(JSON.parse(readFileSync(join(state, r), "utf8")), r).toMatchObject({ ok: true });

    const result = compare(readJsonl(`fixtures/claude/${scenario}/expected.jsonl`), events);
    if (!result.ok) expect.fail(`${result.error}\n\nEvents:\n${show(events)}`);
  });
});

async function waitFor(events: ThreadEvent[], from: number, pattern: unknown): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const at = events.findIndex((e, i) => i >= from && matches(e, pattern));
    if (at >= 0) return at;
    await new Promise((r) => setTimeout(r, 5));
  }
  return -1;
}

function show(events: ThreadEvent[]): string {
  return events
    .filter((e) => e.type !== "delta")
    .map((e) => JSON.stringify(e).slice(0, 300))
    .join("\n");
}

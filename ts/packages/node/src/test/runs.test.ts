// The core's side of runs that outlive the backend: what's saved with a thread's events.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import type { Harness, HarnessSession, ThreadContext } from "../harness.js";
import type { Spawner } from "../spawner.js";
import type { RunRecord } from "../store.js";
import { claudeCode } from "../claude/driver.js";
import { shim } from "../shim.js";
import { MemoryStore } from "../stores/memory.js";
import { defineTool } from "../tools.js";
import { shimPath, tempDir } from "./spec.js";

/** A store that takes a while to write, as one on a busy disk or over a network does. */
class SlowStore extends MemoryStore {
  /** The runs each append wrote, with its events' types, as written. */
  written: { events: string[]; runs: RunRecord[] }[] = [];
  override async appendEvents(id: string, events: ThreadEvent[], runs: RunRecord[] = []): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    this.written.push(structuredClone({ events: events.map((e) => e.type), runs }));
    return super.appendEvents(id, events, runs);
  }
}

describe("a run's checkpoint", () => {
  it("is saved as it was when the events with it were, though the driver's state changes before the store writes it", async () => {
    const state = { sent: ["m1"] };
    let ctx!: ThreadContext;
    let started = false;
    const session: HarnessSession = {
      start: () => {
        started = true;
        ctx.setThread({ run: { id: "run_1", spawner: "shim" } });
        // More of the run's output, read before the store gets to write what came before.
        setTimeout(() => state.sent.splice(0), 10);
      },
      steer: () => {},
      carryOver: () => {},
      interrupt: () => {},
      live: () => true,
      release: () => {},
      optionsChanged: () => {},
      close: async () => {},
      checkpoint: () => (started ? { id: "run_1", offset: 42, state } : undefined),
    };
    const harness: Harness = { name: "fake", open: (c) => ((ctx = c), session) };
    const spawner: Spawner = { name: "shim", durable: true, spawn: () => ({}) as never };
    const store = new SlowStore();
    const sdk = new AgentThreads({ store, harnesses: { fake: harness }, spawner });
    const t = await sdk.create();
    await sdk.send(t.id, "hi");
    await sdk.eventsSince(t.id, 0);
    // The run was first saved with the turn's start, as it was then.
    const first = store.written.find((w) => w.runs.length)!;
    expect(first.events).toContain("turn.started");
    expect(first.runs[0]).toMatchObject({ offset: 42, data: { state: { sent: ["m1"] }, turn: { interrupted: false } } });
  });
});

describe.skipIf(process.platform === "win32")("an app tool, with a run that outlives the backend", () => {
  it("isn't run if the run can't be saved as running it first", { timeout: 30_000 }, async () => {
    /** A store that can't save a run on its own (with no events), once told to. */
    class FailingStore extends MemoryStore {
      failing = false;
      override async appendEvents(id: string, events: ThreadEvent[], runs?: RunRecord[]): Promise<void> {
        if (this.failing && !events.length && runs?.length) throw new Error("the disk is full");
        return super.appendEvents(id, events, runs);
      }
    }
    const store = new FailingStore();
    let calls = 0;
    const errors: unknown[] = [];
    const sdk = new AgentThreads({
      store,
      harnesses: {
        claude: claudeCode({
          bin: fileURLToPath(new URL("./mini-claude.mjs", import.meta.url)),
          // A while between the tool's call and the request to run it, as with Claude.
          env: { MINI_CLAUDE_TOOL_DELAY: "300" },
        }),
      },
      tools: [defineTool({ name: "lookup", description: "Looks up.", input: { type: "object" }, run: () => (calls++, "found it") })],
      permissions: "allow",
      spawner: shim(shimPath(), { runsDir: tempDir(), pollMs: 20 }),
      onError: (e) => errors.push(e),
    });
    const events: ThreadEvent[] = [];
    sdk.subscribe((e) => events.push(e));
    const t = await sdk.create({ cwd: tempDir() });
    await sdk.send(t.id, "app lookup {}");
    while (!events.some((e) => e.type === "item.added" && e.item.type === "tool_call")) await new Promise((r) => setTimeout(r, 10));
    await sdk.eventsSince(t.id, 0);
    store.failing = true;
    while (!events.some((e) => e.type === "turn.completed")) await new Promise((r) => setTimeout(r, 10));
    store.failing = false;
    const snap = await sdk.snapshot(t.id);
    await sdk.close({ stop: true });
    expect(calls).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    const said = snap.items.map((i) => (i.type === "assistant_message" ? i.text : "")).join("\n");
    expect(said).toMatch(/couldn't save its state/);
  });
});

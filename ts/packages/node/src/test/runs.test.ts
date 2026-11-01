// The core's side of runs that outlive the backend: what's saved with a thread's events.

import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import type { Harness, HarnessSession, ThreadContext } from "../harness.js";
import type { Spawner } from "../spawner.js";
import type { RunRecord } from "../store.js";
import { MemoryStore } from "../stores/memory.js";

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

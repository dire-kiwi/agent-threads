// A smoke test against the real `claude`, which needs it installed and logged in, and costs a
// cent or so: AGENT_THREADS_LIVE=1 pnpm test. (CLAUDE_BIN names another binary.)

import { describe, expect, it } from "vitest";
import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import { claudeCode } from "../claude/driver.js";
import { defineTool } from "../tools.js";
import { tempDir } from "./spec.js";

describe.skipIf(!process.env.AGENT_THREADS_LIVE)("live Claude Code", () => {
  it("replies, and calls an app tool", { timeout: 120_000 }, async () => {
    const sdk = new AgentThreads({
      harnesses: { claude: claudeCode({ bin: process.env.CLAUDE_BIN ?? "claude" }) },
      tools: [
        defineTool<{ order_id: string }>({
          name: "lookup_order",
          description: "Looks up an order by its id.",
          input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
          run: ({ order_id }) => `Order ${order_id}: 3 blue widgets.`,
        }),
      ],
      permissions: "allow",
    });
    try {
      const t = await sdk.create({ model: "haiku", cwd: tempDir() });
      const done = (turns: number) =>
        new Promise<void>((resolve) => {
          const off = sdk.subscribe((e) => {
            if (e.type === "turn.completed" && --turns === 0) {
              off();
              resolve();
            }
          });
        });

      let finished = done(1);
      await sdk.send(t.id, "Reply with exactly these words and nothing else: hello from agent-threads");
      await finished;
      let s = await sdk.snapshot(t.id);
      expect(s.thread).toMatchObject({ status: "idle", session_id: expect.any(String) });
      expect(s.items.filter((i) => i.type === "assistant_message").map((i) => (i as { text: string }).text).join("")).toMatch(/hello from agent-threads/i);

      finished = done(1);
      await sdk.send(t.id, "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.");
      await finished;
      s = await sdk.snapshot(t.id);
      expect(s.thread.status).toBe("idle");
      const call = s.items.find((i): i is ToolCall => i.type === "tool_call" && i.kind === "app");
      expect(call).toMatchObject({ name: "lookup_order", status: "completed", result: { content: "Order 42: 3 blue widgets." } });
      expect(s.thread.usage?.cost_usd).toBeGreaterThan(0);
    } finally {
      await sdk.close();
    }
  });
});

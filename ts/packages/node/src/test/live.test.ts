// A smoke test against the real `claude`, which needs it installed and logged in, and costs a
// cent or so: AGENT_THREADS_LIVE=1 pnpm test. (CLAUDE_BIN names another binary.)

import { describe, expect, it } from "vitest";
import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import { claudeCode } from "../claude/driver.js";
import { direct, type Spawner } from "../spawner.js";
import { defineTool } from "../tools.js";
import { tempDir } from "./spec.js";

describe.skipIf(!process.env.AGENT_THREADS_LIVE)("live Claude Code", () => {
  it("replies, calls an app tool, and has the app's skills", { timeout: 120_000 }, async () => {
    // Claude's output, to see what its initialize response lists.
    const out: string[] = [];
    const inner = direct();
    const spawner: Spawner = {
      name: "direct",
      spawn: (options, handlers) => inner.spawn(options, { ...handlers, line: (l) => (out.push(l), handlers.line(l)) }),
    };
    const sdk = new AgentThreads({
      spawner,
      skills: [{ name: "review-sentinel", content: "---\nname: review-sentinel\ndescription: Says sentinel.\n---\nSay sentinel.\n" }],
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
      // The app's skill is there, though the user's and the project's config aren't loaded.
      const init = out.map((l) => JSON.parse(l)).find((m) => m.type === "control_response" && m.response?.response?.commands);
      const commands: string[] = init.response.response.commands.map((c: { name: string }) => c.name);
      expect(commands).toContain("app:review-sentinel");
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

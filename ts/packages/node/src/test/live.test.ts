// Smoke tests against the real `claude` and `codex`, which need them installed and logged in, and
// cost a cent or so: AGENT_THREADS_LIVE=1 pnpm test. (CLAUDE_BIN names another claude.)

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { AgentThreads } from "../agent-threads.js";
import { claudeCode } from "../claude/driver.js";
import { codex } from "../codex/driver.js";
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

// The same against the real `codex` (CODEX_BIN names another binary, CODEX_MODEL another model),
// with a CODEX_HOME of the test's own that has the user's login linked in.
describe.skipIf(!process.env.AGENT_THREADS_LIVE)("live Codex", () => {
  for (const appTools of ["dynamic", "mcp"] as const) {
    it(`replies, and calls an app tool (${appTools === "dynamic" ? "a dynamic tool" : "on the loopback MCP server"})`, { timeout: 180_000 }, async () => {
      const sdk = new AgentThreads({
        harnesses: { codex: codex({ bin: process.env.CODEX_BIN ?? "codex", home: tempDir(), appTools }) },
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
        const t = await sdk.create({ harness: "codex", model: process.env.CODEX_MODEL ?? "gpt-5.6-luna", effort: "low", cwd: tempDir() });
        const done = () =>
          new Promise<void>((resolve) => {
            const off = sdk.subscribe((e) => {
              if (e.type === "turn.completed") {
                off();
                resolve();
              }
            });
          });

        let finished = done();
        await sdk.send(t.id, "Reply with exactly these words and nothing else: hello from agent-threads");
        await finished;
        let s = await sdk.snapshot(t.id);
        expect(s.thread).toMatchObject({ status: "idle", session_id: expect.any(String) });
        expect(s.items.filter((i) => i.type === "assistant_message").map((i) => (i as { text: string }).text).join("")).toMatch(/hello from agent-threads/i);

        finished = done();
        await sdk.send(t.id, "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.");
        await finished;
        s = await sdk.snapshot(t.id);
        expect(s.thread.status).toBe("idle");
        const call = s.items.find((i): i is ToolCall => i.type === "tool_call" && i.kind === "app");
        expect(call).toMatchObject({ name: "lookup_order", status: "completed", result: { content: expect.stringContaining("Order 42: 3 blue widgets.") } });
        expect(s.thread.usage?.output_tokens).toBeGreaterThan(0);
      } finally {
        await sdk.close();
      }
    });
  }
});

describe.skipIf(!process.env.AGENT_THREADS_LIVE)("live Codex, across a resume", () => {
  it("calls a tool the app added after the session started (on the MCP server)", { timeout: 180_000 }, async () => {
    const tool = (name: string) =>
      defineTool<{ order_id: string }>({
        name,
        description: "Looks up an order by its id.",
        input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
        run: ({ order_id }) => `${name}: order ${order_id} has 3 blue widgets.`,
      });
    const sdk = new AgentThreads({ harnesses: { codex: codex({ bin: process.env.CODEX_BIN ?? "codex", home: tempDir() }) }, permissions: "allow" });
    const done = () =>
      new Promise<void>((resolve) => {
        const off = sdk.subscribe((e) => {
          if (e.type === "turn.completed") {
            off();
            resolve();
          }
        });
      });
    try {
      const t = await sdk.create({ harness: "codex", model: process.env.CODEX_MODEL ?? "gpt-5.6-luna", effort: "low", cwd: tempDir(), tools: [tool("lookup_order")] });
      let finished = done();
      await sdk.send(t.id, "Reply with just: ok");
      await finished;
      // A tool Codex's session doesn't have as a dynamic tool: the resumed session gets it over MCP.
      await sdk.configure(t.id, { tools: [tool("find_order")] });
      finished = done();
      await sdk.send(t.id, "Look up order 42 with the find_order tool, then tell me in a few words what's in it.");
      await finished;
      const s = await sdk.snapshot(t.id);
      // (It may try the session's old dynamic tool first, and be told it's gone.)
      const call = s.items.find((i): i is ToolCall => i.type === "tool_call" && i.name === "find_order");
      expect(call).toMatchObject({ name: "find_order", status: "completed", result: { content: expect.stringContaining("find_order: order 42") } });
    } finally {
      await sdk.close();
    }
  });
});

// The real `codex` against a local stand-in for the model (no login, no cost): what it's sent.
describe.skipIf(!process.env.AGENT_THREADS_LIVE)("Codex against a local model", () => {
  it("leaves out the user's and the project's skills, and has the app's", { timeout: 60_000 }, async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
        event("response.created", { response: { id: "r" } });
        event("response.output_item.done", { item: { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text: "ok" }] } });
        const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
        event("response.completed", { response: { id: "r", usage } });
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const skill = (root: string, name: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nSay ${name}.\n`);
    };
    const home = tempDir();
    const cwd = tempDir();
    skill(join(home, ".agents", "skills"), "user-sentinel");
    skill(join(cwd, ".agents", "skills"), "repo-sentinel");
    const provider = `model_providers.local={name="local",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`;
    const sdk = new AgentThreads({
      harnesses: { codex: codex({ bin: process.env.CODEX_BIN ?? "codex", home: tempDir(), login: false, env: { HOME: home }, args: ["-c", provider, "-c", "model_provider=local"] }) },
      skills: [{ name: "app-sentinel", content: "---\nname: app-sentinel\ndescription: The app-sentinel skill.\n---\nSay app-sentinel.\n" }],
      permissions: "allow",
    });
    try {
      const t = await sdk.create({ harness: "codex", model: "gpt-5.6-luna", cwd });
      const finished = new Promise<void>((resolve) => sdk.subscribe((e) => e.type === "turn.completed" && resolve()));
      await sdk.send(t.id, "hi");
      await finished;
      const sent = bodies.join("\n");
      expect(sent).toContain("app-sentinel");
      expect(sent).not.toContain("user-sentinel");
      expect(sent).not.toContain("repo-sentinel");
    } finally {
      await sdk.close();
      server.close();
    }
  });
});

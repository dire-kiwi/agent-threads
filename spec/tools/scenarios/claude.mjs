// The Claude Code scenarios: each drives a real `claude -p` (stream-json in and out) the way an
// agent-threads backend does, playing the backend's part (initialize, user messages, answers to
// can_use_tool and the in-process MCP server's mcp_message requests).

import { appTool, echoServer } from "./common.mjs";

export const MODEL = "haiku";

/** The arguments every backend passes, as the fixtures expect them. */
export function args({ model = MODEL, resume, mcpConfig, extra = [] } = {}) {
  const a = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format", "stream-json",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--forward-subagent-text",
    "--model", model,
  ];
  if (mcpConfig) a.push("--mcp-config", JSON.stringify({ mcpServers: mcpConfig }));
  if (resume) a.push("--resume", resume);
  return [...a, ...extra];
}


/** Send a control_request from the backend and wait for its control_response. */
async function control(p, request) {
  const request_id = `req_${(p.reqs = (p.reqs ?? 0) + 1)}`;
  p.send({ type: "control_request", request_id, request });
  return p.next((m) => m.type === "control_response" && m.response?.request_id === request_id, `the ${request.subtype} response`);
}

const initialize = (p, sdkMcpServers) =>
  control(p, sdkMcpServers ? { subtype: "initialize", sdkMcpServers } : { subtype: "initialize" });

const user = (p, text) =>
  p.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" });

/** The label of the question's option that matches, as a user picking it would give. */
const pick = (q, label) => q.options.find((o) => o.label.toLowerCase() === label).label;

const isResult = (m) => m.type === "result";
const isToolUse = (name) => (m) => m.type === "assistant" && m.message?.content?.some((c) => c.type === "tool_use" && (!name || c.name === name));

/**
 * The backend's answers to the CLI's control requests.
 * @param {object} o
 * @param {(req: any) => object} [o.permission] can_use_tool -> {behavior, ...}; allows by default
 * @param {boolean} [o.app] serve the app tool as the in-process "app" MCP server
 */
function answers({ permission, app } = {}) {
  return (msg, p) => {
    if (msg.type !== "control_request") return;
    const req = msg.request;
    let response;
    if (req.subtype === "can_use_tool") {
      response = permission ? permission(req) : { behavior: "allow", updatedInput: req.input };
    } else if (req.subtype === "mcp_message" && app) {
      response = { mcp_response: appServer(req.message) };
    } else {
      p.send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported: ${req.subtype}` } });
      return;
    }
    p.send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
  };
}

/** The app's in-process MCP server, as the official Agent SDK answers mcp_message. */
function appServer(m) {
  const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "app", version: "1.0.0" } });
    case "tools/list":
      return ok({ tools: [{ name: appTool.name, description: appTool.description, inputSchema: appTool.input }] });
    case "tools/call":
      return ok({ content: [{ type: "text", text: appTool.result }] });
    default:
      // Notifications are acknowledged like this by the official SDK.
      return m.id === undefined ? { jsonrpc: "2.0", result: {}, id: 0 } : ok({});
  }
}

/** The uuid of the main conversation's last message so far: where --resume-session-at resumes it. */
function lastMessage(p) {
  return p.messages
    .slice(0, p.cursor)
    .findLast((m) => (m.type === "user" || m.type === "assistant") && !m.parent_tool_use_id && m.uuid)?.uuid;
}

/** One turn on a fresh process: initialize, send the prompt, wait for the result, close. */
async function oneTurn(ctx, prompt, { argv = args(), handlers, sdkMcpServers, setup } = {}) {
  const p = ctx.spawn(argv, handlers, { setup });
  await initialize(p, sdkMcpServers);
  user(p, prompt);
  const result = await p.next(isResult, "the result");
  p.close();
  await p.exited;
  return result;
}

export const scenarios = {
  "plain-reply": {
    description: "A plain reply: one turn with streamed text and no tools.",
    run: (ctx) => oneTurn(ctx, "Reply with exactly these words and nothing else: hello from the fixture", { handlers: answers() }),
  },

  "tool-calls": {
    description: "Built-in tools: Read, Bash and Edit, all allowed by the app's permission policy without asking.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Do these one at a time, using the tools named: 1. Read notes.txt with the Read tool. 2. Run `wc -l notes.txt` with the Bash tool. 3. Use the Edit tool to change the line apple to apricot in notes.txt. Then reply with just: done",
        { handlers: answers() },
      ),
  },

  "permission-allow": {
    description: "A Bash call that the user allows when asked.",
    run: (ctx) =>
      oneTurn(ctx, "Run this shell command with the Bash tool: touch allowed.txt — then reply with just: created", {
        handlers: answers({ permission: (req) => ({ behavior: "allow", updatedInput: req.input }) }),
      }),
  },

  "permission-deny": {
    description: "A Bash call that the user denies when asked, with a message the agent is told.",
    run: (ctx) =>
      oneTurn(ctx, "Run this shell command with the Bash tool: touch denied.txt — if you can't, reply with just: not allowed", {
        handlers: answers({ permission: () => ({ behavior: "deny", message: "The user doesn't want files created." }) }),
      }),
  },

  "ask-user-question": {
    description: "AskUserQuestion, answered by the user through the permission callback.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with the options red and blue (header: Color). Then reply with just the color I chose.",
        {
          handlers: answers({
            permission: (req) =>
              req.tool_name === "AskUserQuestion"
                ? { behavior: "allow", updatedInput: { ...req.input, answers: { [req.input.questions[0].question]: pick(req.input.questions[0], "blue") } } }
                : { behavior: "allow", updatedInput: req.input },
          }),
        },
      ),
  },

  "app-tool": {
    description: "An app-defined tool (lookup_order), served by the backend as an in-process sdk MCP server over the control channel.",
    run: (ctx) =>
      oneTurn(ctx, "Look up order 42 with the lookup_order tool and tell me in one short sentence what's in it.", {
        argv: args({ mcpConfig: { app: { type: "sdk", name: "app" } } }),
        sdkMcpServers: ["app"],
        handlers: answers({ app: true }),
      }),
  },

  "mcp-tool": {
    description: "A tool on an external stdio MCP server (echo), passed with --mcp-config.",
    run: (ctx) =>
      oneTurn(ctx, "Call the echo tool with the text: fixture. Then reply with exactly what it returned.", {
        argv: args({ mcpConfig: { echo: { type: "stdio", ...echoServer } } }),
        handlers: answers(),
      }),
  },

  subagent: {
    description: "A subagent (the Agent/Task tool): its messages and tool calls carry parent_tool_use_id.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Use the Task tool to start a general-purpose subagent with this prompt: 'Read notes.txt with the Read tool and reply with its first line only.' Then reply with just what the subagent said.",
        { handlers: answers() },
      ),
  },

  steer: {
    description: "A message sent while a turn is running, which joins that turn.",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Run `sleep 5 && echo first` with the Bash tool, then reply with its output.");
      await p.next(isToolUse("Bash"), "the Bash call");
      user(p, "Also end your reply with the word: steered");
      await p.next(isResult, "the result");
      p.close();
      await p.exited;
    },
  },

  interrupt: {
    description: "An interrupt while a long Bash command runs.",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Run `python3 -c 'import time; time.sleep(30); print(\"finished\")'` with the Bash tool, then reply with its output.");
      await p.next(isToolUse("Bash"), "the Bash call");
      await new Promise((r) => setTimeout(r, 1500));
      await control(p, { subtype: "interrupt" });
      await p.next(isResult, "the result");
      p.close();
      await p.exited;
    },
  },

  resume: {
    description: "Two runs: a turn, the process ends, then a new process resumes the session with --resume.",
    async run(ctx) {
      const first = await oneTurn(ctx, "Remember the word pineapple. Reply with just: ok", { handlers: answers() });
      await oneTurn(ctx, "What word did I ask you to remember? Reply with just the word.", {
        argv: args({ resume: first.session_id }),
        handlers: answers(),
      });
    },
  },

  compaction: {
    description: "A turn, then /compact sent as a message, which compacts the conversation.",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Reply with just: ready");
      await p.next(isResult, "the first result");
      user(p, "/compact");
      await p.next(isResult, "the compaction's result");
      p.close();
      await p.exited;
    },
  },

  adopt: {
    description: "A thread created with the session id of a conversation the app already had (made by a setup run, not recorded): its first turn resumes it.",
    async run(ctx) {
      const setup = await oneTurn(ctx, "Remember the word pineapple. Reply with just: ok", { handlers: answers(), setup: true });
      ctx.meta.thread = { session_id: setup.session_id };
      await oneTurn(ctx, "What word did I ask you to remember? Reply with just the word.", {
        argv: args({ resume: setup.session_id }),
        handlers: answers(),
      });
    },
  },

  rewind: {
    description: "Two turns, a rewind to before the second, then a turn in a new process that resumes the session at the first turn's last message (--resume-session-at).",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Remember the word pineapple. Reply with just: ok");
      const first = await p.next(isResult, "the first result");
      const at = lastMessage(p);
      user(p, "Forget that word: remember the word mango instead. Reply with just: ok");
      await p.next(isResult, "the second result");
      p.note({ type: "rewind", turn_id: "{{t2}}" });
      p.close();
      await p.exited;
      await oneTurn(ctx, "What word did I ask you to remember? Reply with just the word.", {
        argv: args({ resume: first.session_id, extra: ["--resume-session-at", at] }),
        handlers: answers(),
      });
    },
  },

  "new-session": {
    description: "A turn, then new_session: the next turn starts a new conversation in a new process (no --resume).",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Remember the word pineapple. Reply with just: ok");
      await p.next(isResult, "the first result");
      p.note({ type: "new_session" });
      p.close();
      await p.exited;
      await oneTurn(ctx, "What word did I ask you to remember? If you don't know, reply with just: unknown", { handlers: answers() });
    },
  },

  compact: {
    description: "A turn, then the compact command, which the backend sends as /compact.",
    async run(ctx) {
      const p = ctx.spawn(args(), answers());
      await initialize(p);
      user(p, "Reply with just: ready");
      await p.next(isResult, "the first result");
      p.note({ type: "compact" });
      user(p, "/compact");
      await p.next(isResult, "the compaction's result");
      p.close();
      await p.exited;
    },
  },

  error: {
    description: "A turn that fails: the model doesn't exist.",
    run: (ctx) => oneTurn(ctx, "Reply with: hi", { argv: args({ model: "claude-no-such-model" }), handlers: answers() }),
  },
};

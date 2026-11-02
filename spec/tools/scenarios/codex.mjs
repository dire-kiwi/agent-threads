// The Codex scenarios: each drives a real `codex app-server` (JSON-RPC over stdio) the way an
// agent-threads backend does, playing the backend's part (initialize, thread/start, turn/start,
// and answers to the server's approval, requestUserInput and item/tool/call requests).

import { appTool, echoServer } from "./common.mjs";

export const MODEL = "gpt-5.6-luna";
export const EFFORT = "low";

export const args = () => ["app-server"];

/** The JSON-RPC client half of a backend. */
class Rpc {
  constructor(p) {
    this.p = p;
    this.id = 0;
  }
  async request(method, params) {
    const id = ++this.id;
    this.p.send({ id, method, params });
    const r = await this.p.next((m) => m.id === id && m.method === undefined, `the ${method} response`);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { response: r });
    return r.result;
  }
  notify(method, params) {
    this.p.send(params === undefined ? { method } : { method, params });
  }
}

/**
 * The thread/start parameters a backend sends for a thread with the default permission mode: the
 * agent works in the workspace and asks before anything else.
 */
export function threadParams(ctx, { model = MODEL, dynamicTools, mcpServers } = {}) {
  const p = {
    cwd: ctx.work,
    model,
    approvalPolicy: "untrusted",
    // Whatever the permission mode: Codex says what this sandbox is, with all its config, and the
    // first turn puts the thread in its mode's (plan: read-only).
    sandbox: "workspace-write",
    config: {
      "features.default_mode_request_user_input": true,
      suppress_unstable_features_warning: true,
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
      // The user's and the project's skills, which a CODEX_HOME of its own doesn't keep out.
      ...(ctx.hiddenSkills?.length ? { skills: { config: ctx.hiddenSkills.map((path) => ({ path, enabled: false })) } } : {}),
    },
  };
  if (dynamicTools) p.dynamicTools = dynamicTools;
  return p;
}

const text = (t) => [{ type: "text", text: t, text_elements: [] }];

/**
 * The backend's answers to the server's requests.
 * @param {object} o
 * @param {(m: any) => boolean} [o.approve] for command and file-change approvals; accepts by default
 * @param {(m: any) => object} [o.userInput] item/tool/requestUserInput -> {answers}
 */
function answers({ approve = () => true, userInput } = {}) {
  return (m, p) => {
    if (m.id === undefined || m.method === undefined) return;
    const reply = (result) => p.send({ id: m.id, result });
    switch (m.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return reply({ decision: approve(m) ? "accept" : "decline" });
      case "mcpServer/elicitation/request":
        return reply({ action: "accept", content: {} });
      case "item/tool/requestUserInput":
        return reply(userInput ? userInput(m) : { answers: {} });
      case "item/tool/call":
        return reply({ contentItems: [{ type: "inputText", text: appTool.result }], success: true });
      default:
        p.send({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    }
  };
}

/** Start the app server and initialize it, as every backend does first. */
async function start(ctx, handlers = answers(), { setup } = {}) {
  const p = ctx.spawn(args(), handlers, { setup });
  const rpc = new Rpc(p);
  await rpc.request("initialize", { clientInfo: { name: "agent-threads", title: "agent-threads", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized");
  // Skills Codex finds that aren't its own built-in ones are turned off in thread/start's config.
  const { data } = await rpc.request("skills/list", { cwds: [ctx.work], forceReload: true });
  ctx.hiddenSkills = data.flatMap((d) => d.skills).filter((s) => s.scope !== "system").map((s) => s.path);
  return { p, rpc };
}

const turnCompleted = (threadId) => (m) => m.method === "turn/completed" && m.params?.threadId === threadId;

async function turn(rpc, threadId, prompt, more = {}) {
  const r = await rpc.request("turn/start", { threadId, input: text(prompt), effort: EFFORT, ...more });
  return r.turn.id;
}

/** turn/start's collaborationMode for Codex's plan mode (or its default one). */
const collaboration = (mode, model = MODEL) => ({ mode, settings: { model, reasoning_effort: EFFORT, developer_instructions: null } });

/** One thread, one turn, then the process is closed. */
async function oneTurn(ctx, prompt, { thread, handlers, setup } = {}) {
  const { p, rpc } = await start(ctx, handlers, { setup });
  const { thread: t } = await rpc.request("thread/start", thread ?? threadParams(ctx));
  await turn(rpc, t.id, prompt);
  await p.next(turnCompleted(t.id), "the turn to complete");
  p.close();
  await p.exited;
  return t.id;
}

export const scenarios = {
  "plain-reply": {
    description: "A plain reply: one turn with streamed text and no tools.",
    run: (ctx) => oneTurn(ctx, "Reply with exactly these words and nothing else: hello from the fixture"),
  },

  "tool-calls": {
    description: "Built-in tools: reading a file and running commands, and editing a file, all allowed by the app's permission policy without asking.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Do these one at a time: 1. Show notes.txt with `cat notes.txt`. 2. Run `wc -l notes.txt`. 3. Edit notes.txt with apply_patch to change the line apple to apricot. Then reply with just: done",
      ),
  },

  "permission-allow": {
    description: "A command that needs approval, which the user allows.",
    run: (ctx) => oneTurn(ctx, "Run this shell command: touch allowed.txt — then reply with just: created"),
  },

  "permission-deny": {
    description: "A command that needs approval, which the user declines.",
    run: (ctx) =>
      oneTurn(ctx, "Run this shell command: touch denied.txt — if you can't, reply with just: not allowed", {
        handlers: answers({ approve: () => false }),
      }),
  },

  "ask-user-question": {
    description: "item/tool/requestUserInput, answered by the user.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Use the request_user_input tool to ask me one question: which color do I prefer, with the options red and blue (header: Color). Then reply with just the color I chose.",
        {
          handlers: answers({
            userInput: ({ params: { questions: [q] } }) => ({
              answers: { [q.id]: { answers: [q.options.find((o) => o.label.toLowerCase() === "blue").label] } },
            }),
          }),
        },
      ),
  },

  "app-tool": {
    description: "An app-defined tool (lookup_order), given as a dynamic tool on thread/start and answered via item/tool/call.",
    run: (ctx) =>
      oneTurn(ctx, "Look up order 42 with the lookup_order tool and tell me in one short sentence what's in it.", {
        thread: threadParams(ctx, {
          dynamicTools: [{ type: "function", name: appTool.name, description: appTool.description, inputSchema: appTool.input }],
        }),
      }),
  },

  "mcp-tool": {
    description: "A tool on an external stdio MCP server (echo), given in thread/start's config.",
    run: (ctx) =>
      oneTurn(ctx, "Call the echo tool with the text: fixture. Then reply with exactly what it returned.", {
        thread: threadParams(ctx, { mcpServers: { echo: echoServer } }),
      }),
  },

  subagent: {
    description: "A subagent: Codex spawns a child thread, whose items arrive with the child's threadId.",
    run: (ctx) =>
      oneTurn(
        ctx,
        "Spawn one subagent with this task: 'Read notes.txt and reply with its first line only.' Wait for it, then reply with just what the subagent said.",
      ),
  },

  steer: {
    description: "A message sent while a turn is running (turn/steer), which joins that turn.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      const turnId = await turn(rpc, thread.id, "Run `sleep 5 && echo first`, then reply with its output.");
      await p.next((m) => m.method === "item/started" && m.params.item.type === "commandExecution", "the command to start");
      await rpc.request("turn/steer", { threadId: thread.id, expectedTurnId: turnId, input: text("Also end your reply with the word: steered") });
      await p.next(turnCompleted(thread.id), "the turn to complete");
      p.close();
      await p.exited;
    },
  },

  interrupt: {
    description: "An interrupt (turn/interrupt) while a long command runs.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      const turnId = await turn(rpc, thread.id, "Run `sleep 30 && echo finished`, then reply with its output.");
      await p.next((m) => m.method === "item/started" && m.params.item.type === "commandExecution", "the command to start");
      await new Promise((r) => setTimeout(r, 1500));
      await rpc.request("turn/interrupt", { threadId: thread.id, turnId });
      await p.next(turnCompleted(thread.id), "the turn to complete");
      p.close();
      await p.exited;
    },
  },

  resume: {
    description: "Two runs: a turn, the process ends, then a new app server resumes the thread with thread/resume.",
    async run(ctx) {
      const threadId = await oneTurn(ctx, "Remember the word pineapple. Reply with just: ok");
      const { p, rpc } = await start(ctx);
      const { cwd, model, approvalPolicy, sandbox, config } = threadParams(ctx);
      await rpc.request("thread/resume", { threadId, cwd, model, approvalPolicy, sandbox, config, excludeTurns: true });
      await turn(rpc, threadId, "What word did I ask you to remember? Reply with just the word.");
      await p.next(turnCompleted(threadId), "the turn to complete");
      p.close();
      await p.exited;
    },
  },

  compaction: {
    description: "A turn, then /compact, which the backend sends as thread/compact/start.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      await turn(rpc, thread.id, "Reply with just: ready");
      await p.next(turnCompleted(thread.id), "the first turn to complete");
      await rpc.request("thread/compact/start", { threadId: thread.id });
      await p.next(turnCompleted(thread.id), "the compaction to complete");
      p.close();
      await p.exited;
    },
  },

  adopt: {
    description: "A thread created with the id of a Codex thread the app already had (made by a setup run, not recorded): its first turn resumes it with thread/resume.",
    async run(ctx) {
      const threadId = await oneTurn(ctx, "Remember the word pineapple. Reply with just: ok", { setup: true });
      ctx.meta.thread = { session_id: threadId };
      const { p, rpc } = await start(ctx);
      const { cwd, model, approvalPolicy, sandbox, config } = threadParams(ctx);
      await rpc.request("thread/resume", { threadId, cwd, model, approvalPolicy, sandbox, config, excludeTurns: true });
      await turn(rpc, threadId, "What word did I ask you to remember? Reply with just the word.");
      await p.next(turnCompleted(threadId), "the turn to complete");
      p.close();
      await p.exited;
    },
  },

  rewind: {
    description: "Two turns, a rewind to before the second, then a turn in a new app server that resumes the thread and reverts it to before the second turn (thread/revert).",
    async run(ctx) {
      const first = await start(ctx);
      const { thread } = await first.rpc.request("thread/start", threadParams(ctx));
      await turn(first.rpc, thread.id, "Remember the word pineapple. Reply with just: ok");
      await first.p.next(turnCompleted(thread.id), "the first turn to complete");
      const second = await turn(first.rpc, thread.id, "Forget that word: remember the word mango instead. Reply with just: ok");
      await first.p.next(turnCompleted(thread.id), "the second turn to complete");
      first.p.note({ type: "rewind", turn_id: "{{t2}}" });
      first.p.close();
      await first.p.exited;
      const { p, rpc } = await start(ctx);
      const { cwd, model, approvalPolicy, sandbox, config } = threadParams(ctx);
      await rpc.request("thread/resume", { threadId: thread.id, cwd, model, approvalPolicy, sandbox, config, excludeTurns: true });
      await rpc.request("thread/revert", { threadId: thread.id, beforeTurnId: second });
      await turn(rpc, thread.id, "What word did I ask you to remember? Reply with just the word.");
      await p.next(turnCompleted(thread.id), "the third turn to complete");
      p.close();
      await p.exited;
    },
  },

  "new-session": {
    description: "A turn, then new_session: the next turn starts a new thread (thread/start) in a new app server.",
    async run(ctx) {
      const first = await start(ctx);
      const { thread } = await first.rpc.request("thread/start", threadParams(ctx));
      await turn(first.rpc, thread.id, "Remember the word pineapple. Reply with just: ok");
      await first.p.next(turnCompleted(thread.id), "the first turn to complete");
      first.p.note({ type: "new_session" });
      first.p.close();
      await first.p.exited;
      await oneTurn(ctx, "What word did I ask you to remember? If you don't know, reply with just: unknown");
    },
  },

  compact: {
    description: "A turn, then the compact command, which the backend sends as thread/compact/start.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      await turn(rpc, thread.id, "Reply with just: ready");
      await p.next(turnCompleted(thread.id), "the first turn to complete");
      p.note({ type: "compact" });
      await rpc.request("thread/compact/start", { threadId: thread.id });
      await p.next(turnCompleted(thread.id), "the compaction to complete");
      p.close();
      await p.exited;
    },
  },

  plan: {
    description:
      "Plan mode (collaboration mode plan): the agent proposes a plan and its turn ends; the user's feedback is another plan-mode turn; they approve the second plan, which is a default-mode turn with Codex's own \"Implement the plan.\" and the accept_edits policy, in which the edit isn't asked about.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      await turn(rpc, thread.id, "Plan this change: in notes.txt, change the line apple to apricot. Don't ask me any questions, and keep the plan short.", {
        sandboxPolicy: { type: "readOnly" },
        collaborationMode: collaboration("plan"),
      });
      await p.next(turnCompleted(thread.id), "the first plan");
      await turn(rpc, thread.id, "Also change the line banana to blueberry.", { collaborationMode: collaboration("plan") });
      await p.next(turnCompleted(thread.id), "the second plan");
      await turn(rpc, thread.id, "Implement the plan.", {
        collaborationMode: collaboration("default"),
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite" },
      });
      await p.next(turnCompleted(thread.id), "the implementation");
      p.close();
      await p.exited;
    },
  },

  "set-options": {
    description:
      "Options changed between turns while the process runs: the next turn/start overrides the model and the approval policy (accept_edits), so its edit isn't asked about.",
    async run(ctx) {
      const { p, rpc } = await start(ctx);
      const { thread } = await rpc.request("thread/start", threadParams(ctx));
      await turn(rpc, thread.id, "Reply with just: one");
      await p.next(turnCompleted(thread.id), "the first turn to complete");
      await turn(rpc, thread.id, "Edit notes.txt with apply_patch to change the line apple to apricot. Then reply with just: done", {
        model: "gpt-6-luna",
        // The sandbox stays as it is (workspace-write): only the approval policy changes.
        approvalPolicy: "on-request",
      });
      await p.next(turnCompleted(thread.id), "the second turn to complete");
      p.close();
      await p.exited;
    },
  },

  error: {
    description: "A turn that fails: the model doesn't exist.",
    run: (ctx) => oneTurn(ctx, "Reply with: hi", { thread: threadParams(ctx, { model: "gpt-no-such-model" }) }),
  },
};

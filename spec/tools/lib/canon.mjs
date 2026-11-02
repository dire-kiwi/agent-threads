// What the fake CLI checks of a backend's input. Backends needn't send byte-for-byte what the
// recorder sent: each message is reduced to the parts that matter (its kind, the text of a user
// message, a permission's behavior, a JSON-RPC method and its key params...) and those are compared.
// The rules are in spec/tools/README.md, under "What's checked".

import { readFileSync, existsSync } from "node:fs";
import { flag } from "./session.mjs";

// ---------- argv ----------

const CLAUDE_FLAGS = [
  ["-p", false],
  ["--output-format", true],
  ["--input-format", true],
  ["--verbose", false],
  ["--include-partial-messages", false],
  ["--replay-user-messages", false],
  ["--permission-prompt-tool", true],
  ["--forward-subagent-text", false],
  ["--strict-mcp-config", false],
  ["--model", true],
  ["--resume", true],
  ["--resume-session-at", true],
  ["--permission-mode", true],
];

/** The parts of a CLI's arguments that the fixtures check. */
export function argvKey(harness, argv) {
  const args = argv.slice(1);
  if (harness === "codex") return { subcommand: args.find((a) => !a.startsWith("-")) };
  const key = {};
  for (const [name, takesValue] of CLAUDE_FLAGS) {
    const v = name === "-p" ? (flag(args, "-p", false) ?? flag(args, "--print", false)) : flag(args, name, takesValue);
    if (v !== undefined) key[name] = v;
  }
  const mcp = flag(args, "--mcp-config");
  if (mcp !== undefined) key["--mcp-config"] = mcpServers(mcp);
  return key;
}

/** --mcp-config's servers, as {name: type}: the value is JSON, or a file holding it. */
function mcpServers(value) {
  let text = value;
  if (!value.trim().startsWith("{") && existsSync(value)) text = readFileSync(value, "utf8");
  const servers = JSON.parse(text).mcpServers ?? {};
  return Object.fromEntries(
    Object.entries(servers)
      .map(([name, s]) => [name, s.type ?? (s.url ? "http" : "stdio")])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------- input messages ----------

/**
 * Tracks what the CLI has asked the backend (so a reply can be reduced by what it answers) and
 * maps the ids a backend chose for its own requests to the recorded ones.
 */
export class Context {
  constructor(harness) {
    this.harness = harness;
    this.asked = new Map(); // id the CLI chose -> its request
    this.ids = new Map(); // recorded id of a backend request -> the backend's actual id
  }

  /** Note a message the fake CLI is about to send. */
  sent(msg) {
    if (this.harness === "claude" && msg.type === "control_request") this.asked.set(msg.request_id, msg.request);
    if (this.harness === "codex" && msg.method !== undefined && msg.id !== undefined) this.asked.set(msg.id, msg);
  }

  /** A recorded output with the backend's own request ids put in. */
  rewrite(msg) {
    if (this.harness === "claude" && msg.type === "control_response" && this.ids.has(msg.response?.request_id)) {
      return { ...msg, response: { ...msg.response, request_id: this.ids.get(msg.response.request_id) } };
    }
    if (this.harness === "codex" && msg.method === undefined && msg.id !== undefined && this.ids.has(msg.id)) {
      return { ...msg, id: this.ids.get(msg.id) };
    }
    return msg;
  }

  /** Note that the backend's actual message matched a recorded one. */
  matched(recorded, actual) {
    if (this.harness === "claude" && recorded.type === "control_request") this.ids.set(recorded.request_id, actual.request_id);
    if (this.harness === "codex" && recorded.method !== undefined && recorded.id !== undefined) this.ids.set(recorded.id, actual.id);
  }

  /** The parts of an input message the fixtures check. */
  key(msg) {
    return this.harness === "claude" ? this.#claude(msg) : this.#codex(msg);
  }

  #claude(m) {
    switch (m.type) {
      case "user": {
        const c = m.message?.content;
        const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
        const k = { type: "user", text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
        const images = blocks.filter((b) => b.type === "image").length;
        if (images) k.images = images;
        if (m.parent_tool_use_id) k.parent_tool_use_id = m.parent_tool_use_id;
        return k;
      }
      case "control_request": {
        const r = m.request ?? {};
        const k = { type: "control_request", subtype: r.subtype };
        if (r.subtype === "initialize") k.sdkMcpServers = [...(r.sdkMcpServers ?? [])].sort();
        if (r.subtype === "set_permission_mode") k.mode = r.mode;
        if (r.subtype === "set_model") k.model = r.model;
        return k;
      }
      case "control_response": {
        const r = m.response ?? {};
        const k = { type: "control_response", request_id: r.request_id, subtype: r.subtype };
        const asked = this.asked.get(r.request_id);
        if (r.subtype !== "success" || !asked) return k;
        const body = r.response ?? {};
        if (asked.subtype === "can_use_tool") {
          k.behavior = body.behavior;
          // What the tool will run with: the input it asked about, unless the backend changed it
          // (AskUserQuestion's answers go in it too). A denial's message is what the agent is told.
          if (body.behavior === "allow") k.input = body.updatedInput ?? asked.input;
          // An approved plan's mode (setMode), and any other permission updates.
          if (body.behavior === "allow" && body.updatedPermissions?.length) k.permissions = body.updatedPermissions;
          if (body.behavior === "deny") k.message = body.message;
        } else if (asked.subtype === "mcp_message") {
          k.mcp = mcpReply(asked.message, body.mcp_response);
        }
        return k;
      }
      default:
        return m;
    }
  }

  #codex(m) {
    if (m.method !== undefined) {
      if (m.id === undefined) return { notify: m.method };
      return { method: m.method, params: codexParams(m.method, m.params ?? {}) };
    }
    const asked = this.asked.get(m.id);
    const k = { reply_to: m.id };
    if (m.error) return { ...k, error: true };
    const r = m.result ?? {};
    switch (asked?.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { ...k, decision: typeof r.decision === "string" ? r.decision : Object.keys(r.decision ?? {})[0] };
      case "mcpServer/elicitation/request":
        return { ...k, action: r.action };
      case "item/tool/requestUserInput":
        return { ...k, answers: r.answers };
      case "item/tool/call":
        return { ...k, success: r.success, text: texts(r.contentItems, "inputText") };
      default:
        return { ...k, result: r };
    }
  }
}

/** An in-process MCP server's reply, reduced: tool names for tools/list, the text for tools/call. */
function mcpReply(request, reply) {
  if (request?.id === undefined) return {}; // a notification's acknowledgement
  const k = { id: reply?.id };
  if (reply?.error) return { ...k, error: true };
  switch (request.method) {
    case "tools/list":
      return { ...k, tools: (reply?.result?.tools ?? []).map((t) => t.name).sort() };
    case "tools/call":
      return { ...k, text: texts(reply?.result?.content, "text"), ...(reply?.result?.isError ? { isError: true } : {}) };
    default:
      return k;
  }
}

const texts = (items, type) => (items ?? []).filter((c) => c.type === type).map((c) => c.text).join("\n");

/** Config given as nested tables or dotted keys, as dotted keys. */
function flatten(o, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && k !== "mcp_servers") flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function codexParams(method, p) {
  const text = (input) => (input ?? []).filter((i) => i.type === "text").map((i) => i.text).join("\n");
  switch (method) {
    case "initialize":
      return { experimentalApi: !!p.capabilities?.experimentalApi };
    case "thread/start":
    case "thread/resume": {
      const config = flatten(p.config);
      const k = { model: p.model, approvalPolicy: p.approvalPolicy, sandbox: p.sandbox };
      if (method === "thread/resume") k.threadId = p.threadId;
      const features = Object.keys(config).filter((c) => c.startsWith("features.") && config[c]);
      if (features.length) k.features = features.sort();
      const servers = Object.keys(config.mcp_servers ?? {});
      if (servers.length) k.mcp_servers = servers.sort();
      if (p.dynamicTools?.length) k.dynamicTools = p.dynamicTools.map((t) => t.name).sort();
      return k;
    }
    case "turn/start":
      // With the options it changes: the model, the policy, and the collaboration mode (plan, or
      // back to default).
      return {
        threadId: p.threadId,
        text: text(p.input),
        ...(p.effort ? { effort: p.effort } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.approvalPolicy ? { approvalPolicy: p.approvalPolicy } : {}),
        ...(p.sandboxPolicy ? { sandboxPolicy: p.sandboxPolicy.type } : {}),
        ...(p.collaborationMode ? { collaborationMode: p.collaborationMode.mode } : {}),
      };
    case "turn/steer":
      return { threadId: p.threadId, expectedTurnId: p.expectedTurnId, text: text(p.input) };
    case "turn/interrupt":
      return { threadId: p.threadId, turnId: p.turnId };
    case "thread/compact/start":
      return { threadId: p.threadId };
    case "skills/list":
      // Its cwds are the thread's working directory, which differs between runs.
      return { forceReload: !!p.forceReload };
    default:
      return p;
  }
}

/** Deep equality of JSON values, ignoring key order. */
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

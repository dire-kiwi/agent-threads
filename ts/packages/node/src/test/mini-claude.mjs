#!/usr/bin/env node
// A tiny scriptable `claude -p` for the driver's tests of what the recorded fixtures don't cover.
// What it does with a message depends on the message's text:
//
//   reply <text>          replies with <text> and ends the turn
//   tool <name> <json>    calls a tool (asking can_use_tool), says how it went, and ends the turn
//   app <name> <json>     calls an app tool over mcp_message, says what it returned, and ends the turn
//   slow                  waits for an interrupt, then ends the turn as interrupted
//   stubborn              ignores interrupts (and a closed stdin), until it's signalled
//   crash                 writes to stderr and exits with code 3
//
// MINI_CLAUDE_LOG names a file each run appends its argv and every line it's sent to. With
// MINI_CLAUDE_STEER=late, messages sent during a turn are taken in after its result (as the next
// turn); with MINI_CLAUDE_STEER=never, they never are (and the process has to be restarted).

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.MINI_CLAUDE_LOG;
const steer = process.env.MINI_CLAUDE_STEER ?? "now";
const note = (v) => log && appendFileSync(log, JSON.stringify(v) + "\n");
note({ argv: process.argv.slice(2) });

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const args = process.argv.slice(2);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const session = resume ?? `sess-${process.pid}`;

let ids = 0;
const waiting = new Map(); // our control request id -> resolve
const inbox = []; // user messages not yet taken in
let wake = null;
let busy = false;
let interrupted = null;
let stubborn = false;
let initialized = false;

const ask = (request) =>
  new Promise((resolve) => {
    const request_id = `cli_${++ids}`;
    waiting.set(request_id, resolve);
    out({ type: "control_request", request_id, request });
  });

const textOf = (m) => m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    note(m);
    if (m.type === "control_request") {
      if (m.request.subtype === "initialize") initialized = true;
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      if (m.request.subtype === "interrupt" && !stubborn) interrupted?.();
      return;
    }
    if (m.type === "control_response") {
      // Echo it, as Claude Code does.
      out(m);
      waiting.get(m.response.request_id)?.(m.response);
      waiting.delete(m.response.request_id);
      return;
    }
    if (m.type === "user") {
      if (!initialized) {
        process.stderr.write("a message came before initialize\n");
        process.exit(4);
      }
      inbox.push(m);
      wake?.();
    }
  })
  .on("close", () => {
    if (!stubborn) process.exit(0);
  });

let msgs = 0;
let turns = 0;
const say = (text) => {
  const id = `msg_${process.pid}_${++msgs}`;
  out({ type: "assistant", message: { id, model: "mini", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: session });
};
const result = (extra = {}) =>
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 5, result: "", session_id: session, model_usage_since_last_result: { mini: { inputTokens: 1, outputTokens: 2, costUSD: 0.001 } }, ...extra });

async function turn(m) {
  busy = true;
  turns++;
  out({ type: "user", message: m.message, isReplay: true, session_id: session, parent_tool_use_id: null });
  out({ type: "system", subtype: "init", session_id: session });
  const text = textOf(m);
  const [cmd, ...rest] = text.split(" ");
  if (cmd === "reply") {
    say(rest.join(" "));
  } else if (cmd === "tool") {
    const [name, json = "{}"] = rest;
    const id = `toolu_${++ids}`;
    const input = JSON.parse(json);
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: session });
    const r = await ask({ subtype: "can_use_tool", tool_name: name, input, tool_use_id: id });
    const allowed = r.response.behavior === "allow";
    out({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: allowed ? "done" : r.response.message, is_error: !allowed }] },
      parent_tool_use_id: null,
      session_id: session,
    });
    say(allowed ? `ran with ${JSON.stringify(r.response.updatedInput)}` : `denied: ${r.response.message}`);
  } else if (cmd === "app") {
    const [name, json = "{}"] = rest;
    const id = `toolu_${++ids}`;
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name: `mcp__app__${name}`, input: JSON.parse(json) }] }, parent_tool_use_id: null, session_id: session });
    const r = await ask({ subtype: "mcp_message", server_name: "app", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: JSON.parse(json), _meta: { "claudecode/toolUseId": id } } } });
    const res = r.response.mcp_response.result;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: res.content, is_error: !!res.isError }] }, parent_tool_use_id: null, session_id: session });
    say(`app said ${res.content[0].text}`);
  } else if (cmd === "slow" || cmd === "stubborn") {
    stubborn = cmd === "stubborn";
    await new Promise((r) => (interrupted = r));
    result({ subtype: "error_during_execution", is_error: true });
    busy = false;
    return;
  } else if (cmd === "crash") {
    process.stderr.write("something broke\n");
    process.exit(3);
  }
  // Messages that came during the turn are taken in before it ends, unless they're taken in late.
  if (steer === "now") while (inbox.length) out({ type: "user", message: inbox.shift().message, isReplay: true, session_id: session, parent_tool_use_id: null });
  result();
  busy = false;
}

for (;;) {
  if (!inbox.length || busy) {
    await new Promise((r) => (wake = r));
    wake = null;
    continue;
  }
  if (steer === "never" && turns > 0) {
    inbox.length = 0;
    continue;
  }
  await turn(inbox.shift());
}

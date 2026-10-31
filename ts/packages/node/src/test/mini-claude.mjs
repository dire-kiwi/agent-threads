#!/usr/bin/env node
// A tiny scriptable `claude -p` for the driver's tests of what the recorded fixtures don't cover.
// What it does with a message depends on the message's text:
//
//   reply <text>          replies with <text> and ends the turn
//   tool <name> <json>    calls a tool (asking can_use_tool), says how it went, and ends the turn
//   app <name> <json>     calls an app tool over mcp_message, says what it returned, and ends the turn
//   sleep <ms> <text>     waits, then replies with <text> and ends the turn
//   cancelled <tool>      asks can_use_tool, then cancels the request and ends the turn
//   slow                  waits for an interrupt, then ends the turn as interrupted
//   stubborn              ignores interrupts (and a closed stdin), until it's signalled
//   crash                 writes to stderr and exits with code 3
//   sleepcrash <ms>       waits, then crashes
//   streamcrash <text>    streams <text> (deltas, no final message), then crashes
//   streamhang <text>     streams <text>, then waits for its input to close
//
// MINI_CLAUDE_LOG names a file each run appends its argv and every line it's sent to. With
// MINI_CLAUDE_STEER=late, messages sent during a turn are taken in after its result (as the next
// turn); with MINI_CLAUDE_STEER=never, they never are (and the process has to be restarted); with
// MINI_CLAUDE_STEER=hold, they're never taken in either, and an interrupt while no turn runs gets
// an interrupted result. MINI_CLAUDE_IDLE_ERRORS=<n> sends n failed results (an API error, say)
// before taking in late messages. With MINI_CLAUDE_FAIL_RESUME=1 (or the name of a file that
// exists), a process started with --resume fails at its first message.

import { appendFileSync, existsSync } from "node:fs";
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
let idleErrors = Number(process.env.MINI_CLAUDE_IDLE_ERRORS ?? 0);

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
      if (m.request.subtype === "interrupt" && !busy && steer === "hold") result({ subtype: "error_during_execution", is_error: true });
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
      const failResume = process.env.MINI_CLAUDE_FAIL_RESUME;
      if (resume && failResume && (failResume === "1" || existsSync(failResume))) {
        process.stderr.write("can't resume\n");
        setTimeout(() => process.exit(2), 50);
        return;
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
  } else if (cmd === "sleep") {
    const [ms, ...words] = rest;
    await new Promise((r) => setTimeout(r, Number(ms)));
    say(words.join(" "));
  } else if (cmd === "cancelled") {
    const id = `toolu_${++ids}`;
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name: rest[0], input: {} }] }, parent_tool_use_id: null, session_id: session });
    const request_id = `cli_${++ids}`;
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: rest[0], input: {}, tool_use_id: id } });
    out({ type: "control_cancel_request", request_id });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "cancelled", is_error: true }] }, parent_tool_use_id: null, session_id: session });
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
  } else if (cmd === "streamcrash" || cmd === "streamhang") {
    const id = `msg_${process.pid}_${++msgs}`;
    out({ type: "stream_event", event: { type: "message_start", message: { id } }, parent_tool_use_id: null, session_id: session });
    for (const word of rest) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word + " " } }, parent_tool_use_id: null, session_id: session });
    if (cmd === "streamhang") await new Promise(() => {});
    await new Promise((r) => setTimeout(r, 50));
    process.stderr.write("something broke\n");
    process.exit(3);
  } else if (cmd === "sleepcrash") {
    await new Promise((r) => setTimeout(r, Number(rest[0])));
    process.stderr.write("something broke\n");
    process.exit(3);
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
  if (steer === "hold" && turns > 0) {
    await new Promise((r) => (wake = r));
    wake = null;
    continue;
  }
  if (idleErrors > 0 && turns > 0) {
    idleErrors--;
    await new Promise((r) => setTimeout(r, 20));
    result({ subtype: "success", is_error: true, result: "API Error: overloaded" });
    continue;
  }
  await turn(inbox.shift());
}

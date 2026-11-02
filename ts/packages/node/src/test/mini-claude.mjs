#!/usr/bin/env node
// A tiny scriptable `claude -p` for the driver's tests of what the recorded fixtures don't cover.
// Like Claude, it makes a turn of each message waiting for it while it's idle, and takes a message
// that comes during a turn into that turn (when it's ready to). What it does with a message
// depends on its text; a message of several text blocks does each in turn, in one turn:
//
//   reply <text>          replies with <text> and ends the turn
//   tool <name> <json>    calls a tool (asking can_use_tool), says how it went, and ends the turn
//   app <name> <json>     calls an app tool over mcp_message, says what it returned, and ends the turn
//   sleep <ms> <text>     waits (or until it's interrupted), then replies with <text> and ends the turn
//   cancelled <tool>      asks can_use_tool, then cancels the request and ends the turn
//   twice <tool> <json>   calls a tool twice at once (asking can_use_tool for both), says how each
//                         went, and ends the turn
//   asking <tool> <json>  calls a tool as `tool` does, but an interrupt while it's asking cancels the
//                         request (as Claude does) and ends the turn as interrupted
//                         (MINI_CLAUDE_INTERRUPT_DELAY=<ms> after cancelling it)
//   slow                  waits for an interrupt, then ends the turn as interrupted
//   stubborn              ignores interrupts, and a closed stdin (saying "not stopping"), until
//                         it's signalled
//   crash                 writes to stderr and exits with code 3
//   sleepcrash <ms>       waits, then crashes
//   streamcrash <text>    streams <text> (deltas, no final message), then crashes
//   streamhang <text>     streams <text>, then waits for its input to close
//   background <ms> <text>
//                         starts a background subagent and ends the turn; the subagent calls Bash
//                         (asking can_use_tool before the turn ends), runs it for <ms>, and
//                         reports <text>; then, as Claude does, a turn of its own says so (its
//                         result has origin.kind task-notification). With
//                         MINI_CLAUDE_BACKGROUND_APP=<name>, the subagent calls that app tool
//                         instead, which is answered before the turn ends, and its tool_result
//                         comes <ms> after. With MINI_CLAUDE_NOTIFY_FIRST=1, messages that come
//                         while a background subagent runs wait for the turn that reports it
//
// It answers every control request with success and an empty response, but a `never_answered` one.
//
// MINI_CLAUDE_LOG names a file each run appends its argv (with CLAUDE_CONFIG_DIR, and the
// variables MINI_LOG_ENV names, comma-separated), every line it's sent and each result it sends
// ({"result": ...}) to. With
// MINI_CLAUDE_STEER=late, messages sent during a turn are taken in after its result (as the next
// turn); with MINI_CLAUDE_STEER=never, they never are (and the process has to be restarted); with
// MINI_CLAUDE_STEER=hold, they're never taken in either, and an interrupt while no turn runs gets
// an interrupted result. MINI_CLAUDE_IDLE_ERRORS=<n> sends n failed results (an API error, say)
// before taking in late messages. MINI_CLAUDE_START_DELAY=<ms> waits that long before saying
// anything about the first message. MINI_CLAUDE_TOOL_DELAY=<ms> waits that long between an app tool's
// call and asking for it to be run, and MINI_CLAUDE_RESULT_DELAY=<ms> between its answer and its
// tool_result. MINI_CLAUDE_ASK_DELAY=<ms> waits that long between a tool's call and asking
// can_use_tool, and MINI_CLAUDE_TOOL_RUN_MS=<ms> that long running a tool it was allowed to. With
// MINI_CLAUDE_FAIL_RESUME=1 (or the name of a file that
// exists), a process started with --resume fails at its first message.

import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.MINI_CLAUDE_LOG;
const steer = process.env.MINI_CLAUDE_STEER ?? "now";
const note = (v) => log && appendFileSync(log, JSON.stringify(v) + "\n");
const loggedEnv = Object.fromEntries((process.env.MINI_LOG_ENV ?? "").split(",").filter(Boolean).map((k) => [k, process.env[k] ?? null]));
note({ argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR, env: loggedEnv });

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
let wasInterrupted = false;
let backgrounds = 0; // background subagents still running

const ask = (request) =>
  new Promise((resolve) => {
    const request_id = `cli_${++ids}`;
    waiting.set(request_id, resolve);
    out({ type: "control_request", request_id, request });
  });


createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    note(m);
    if (m.type === "control_request") {
      if (m.request.subtype === "never_answered") return;
      if (m.request.subtype === "initialize") initialized = true;
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      if (m.request.subtype === "interrupt" && busy && !stubborn) {
        wasInterrupted = true;
        interrupted?.();
      }
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
      m.during = busy; // it came during a turn, so it's taken into that turn
      inbox.push(m);
      wake?.();
    }
  })
  .on("close", () => {
    if (!stubborn) process.exit(0);
    say("not stopping");
  });

let msgs = 0;
let turns = 0;
const say = (text) => {
  const id = `msg_${process.pid}_${++msgs}`;
  out({ type: "assistant", message: { id, model: "mini", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: session });
};
const result = (extra = {}) => {
  const r = { type: "result", subtype: "success", is_error: false, duration_ms: 5, result: "", session_id: session, model_usage_since_last_result: { mini: { inputTokens: 1, outputTokens: 2, costUSD: 0.001 } }, ...extra };
  note({ result: r.subtype });
  out(r);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(m) {
  busy = true;
  wasInterrupted = false;
  turns++;
  // A while before it says anything about the first message (MINI_CLAUDE_START_DELAY).
  if (turns === 1) await sleep(Number(process.env.MINI_CLAUDE_START_DELAY ?? 0));
  out({ type: "user", message: m.message, isReplay: true, session_id: session, parent_tool_use_id: null });
  out({ type: "system", subtype: "init", session_id: session });
  for (const block of m.message.content.filter((b) => b.type === "text")) {
    await step(block.text);
    if (wasInterrupted) {
      result({ subtype: "error_during_execution", is_error: true });
      busy = false;
      return;
    }
  }
  // Messages that came during the turn are taken in before it ends, unless they're taken in late.
  if (steer === "now") {
    for (const w of inbox.filter((x) => x.during)) out({ type: "user", message: w.message, isReplay: true, session_id: session, parent_tool_use_id: null });
    inbox.splice(0, inbox.length, ...inbox.filter((x) => !x.during));
  }
  result();
  busy = false;
}

async function step(text) {
  const [cmd, ...rest] = text.split(" ");
  if (cmd === "reply") {
    say(rest.join(" "));
  } else if (cmd === "sleep") {
    const [ms, ...words] = rest;
    await Promise.race([sleep(Number(ms)), new Promise((r) => (interrupted = r))]);
    if (!wasInterrupted) say(words.join(" "));
  } else if (cmd === "cancelled") {
    const id = `toolu_${++ids}`;
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name: rest[0], input: {} }] }, parent_tool_use_id: null, session_id: session });
    const request_id = `cli_${++ids}`;
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: rest[0], input: {}, tool_use_id: id } });
    out({ type: "control_cancel_request", request_id });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "cancelled", is_error: true }] }, parent_tool_use_id: null, session_id: session });
  } else if (cmd === "twice") {
    const [name, json = "{}"] = rest;
    const input = JSON.parse(json);
    const calls = [`toolu_${++ids}`, `toolu_${++ids}`];
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: calls.map((id) => ({ type: "tool_use", id, name, input })) }, parent_tool_use_id: null, session_id: session });
    const answers = await Promise.all(calls.map((id) => ask({ subtype: "can_use_tool", tool_name: name, input, tool_use_id: id })));
    calls.forEach((id, i) => {
      const r = answers[i];
      const allowed = r.response.behavior === "allow";
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: allowed ? "done" : r.response.message, is_error: !allowed }] }, parent_tool_use_id: null, session_id: session });
      say(allowed ? `ran with ${JSON.stringify(r.response.updatedInput)}` : `denied: ${r.response.message}`);
    });
  } else if (cmd === "asking") {
    const [name, json = "{}"] = rest;
    const id = `toolu_${++ids}`;
    const input = JSON.parse(json);
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: session });
    const request_id = `cli_${++ids}`;
    const answer = new Promise((resolve) => waiting.set(request_id, resolve));
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: id } });
    const r = await Promise.race([answer, new Promise((r) => (interrupted = r))]);
    if (wasInterrupted) {
      waiting.delete(request_id);
      out({ type: "control_cancel_request", request_id });
      await sleep(Number(process.env.MINI_CLAUDE_INTERRUPT_DELAY ?? 0));
      return;
    }
    const allowed = r.response.behavior === "allow";
    out({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: allowed ? "done" : r.response.message, is_error: !allowed }] },
      parent_tool_use_id: null,
      session_id: session,
    });
    say(allowed ? `ran with ${JSON.stringify(r.response.updatedInput)}` : `denied: ${r.response.message}`);
  } else if (cmd === "tool") {
    const [name, json = "{}"] = rest;
    const id = `toolu_${++ids}`;
    const input = JSON.parse(json);
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: session });
    await sleep(Number(process.env.MINI_CLAUDE_ASK_DELAY ?? 0));
    const r = await ask({ subtype: "can_use_tool", tool_name: name, input, tool_use_id: id });
    const allowed = r.response.behavior === "allow";
    if (allowed) await sleep(Number(process.env.MINI_CLAUDE_TOOL_RUN_MS ?? 0));
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
    // As Claude does, a while later (so the backend has saved the call before it's asked to run it).
    await new Promise((r) => setTimeout(r, Number(process.env.MINI_CLAUDE_TOOL_DELAY ?? 0)));
    const r = await ask({ subtype: "mcp_message", server_name: "app", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: JSON.parse(json), _meta: { "claudecode/toolUseId": id } } } });
    const res = r.response.mcp_response.result;
    await new Promise((r) => setTimeout(r, Number(process.env.MINI_CLAUDE_RESULT_DELAY ?? 0)));
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: res.content, is_error: !!res.isError }] }, parent_tool_use_id: null, session_id: session });
    say(`app said ${res.content[0].text}`);
  } else if (cmd === "background") {
    const [ms, ...words] = rest;
    const agent = `toolu_${++ids}`;
    const task = `task_${agent}`;
    out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id: agent, name: "Agent", input: { description: "bg", prompt: "p", subagent_type: "general-purpose", run_in_background: true } }] }, parent_tool_use_id: null, session_id: session });
    out({ type: "system", subtype: "task_started", task_id: task, tool_use_id: agent, description: "bg", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", session_id: session });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: agent, content: [{ type: "text", text: "Async agent launched successfully." }] }] }, parent_tool_use_id: null, session_id: session, tool_use_result: { isAsync: true, status: "async_launched", resolvedModel: "mini-1" } });
    const call = `toolu_${++ids}`;
    const app = process.env.MINI_CLAUDE_BACKGROUND_APP;
    let finish;
    if (app) {
      out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id: call, name: `mcp__app__${app}`, input: {} }] }, parent_tool_use_id: agent, session_id: session });
      // Answered before the turn ends; its result comes after.
      const r = await ask({ subtype: "mcp_message", server_name: "app", message: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: app, arguments: {}, _meta: { "claudecode/toolUseId": call } } } });
      const res = r.response.mcp_response.result;
      finish = async () => {
        await sleep(Number(ms));
        return { content: res.content, is_error: !!res.isError };
      };
    } else {
      out({ type: "assistant", message: { id: `msg_${process.pid}_${++msgs}`, model: "mini", content: [{ type: "tool_use", id: call, name: "Bash", input: { command: "true" } }] }, parent_tool_use_id: agent, session_id: session });
      // Asked now, so it's open when the turn ends.
      const answer = ask({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "true" }, tool_use_id: call });
      finish = async () => {
        const r = await answer;
        const allowed = r.response.behavior === "allow";
        if (allowed) await sleep(Number(ms));
        return { content: allowed ? "done" : r.response.message, is_error: !allowed };
      };
    }
    backgrounds++;
    void (async () => {
      const { content, is_error } = await finish();
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content, is_error }] }, parent_tool_use_id: agent, session_id: session });
      out({ type: "system", subtype: "task_progress", task_id: task, tool_use_id: agent, description: "Running true", usage: { tool_uses: 1 }, session_id: session });
      out({ type: "system", subtype: "task_updated", task_id: task, patch: { status: "completed" }, session_id: session });
      out({ type: "system", subtype: "task_notification", task_id: task, tool_use_id: agent, status: "completed", summary: words.join(" "), usage: { tool_uses: 1 }, session_id: session });
      backgrounds--;
      if (busy) return void wake?.();
      busy = true;
      out({ type: "system", subtype: "init", session_id: session });
      say(`the subagent said ${words.join(" ")}`);
      result({ origin: { kind: "task-notification" } });
      busy = false;
      wake?.();
    })();
  } else if (cmd === "slow" || cmd === "stubborn") {
    stubborn = cmd === "stubborn";
    // Running with nothing else to do once its stdin's closed.
    if (stubborn) setInterval(() => {}, 60_000);
    await new Promise((r) => (interrupted = r));
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
}

for (;;) {
  if (!inbox.length || busy || (process.env.MINI_CLAUDE_NOTIFY_FIRST && backgrounds > 0)) {
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

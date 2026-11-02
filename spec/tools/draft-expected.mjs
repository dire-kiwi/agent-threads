#!/usr/bin/env node
// Drafts a fixture's expected.jsonl, and the steps of its fixture.json, from its session.jsonl, by
// applying the translation rules in spec/fixtures/README.md to the recording. It's a drafting aid
// for when a fixture is (re-)recorded, not a backend: what it writes must be checked by hand, and
// the committed expected.jsonl is what backends are held to.
//
//   node spec/tools/draft-expected.mjs spec/fixtures/claude/plain-reply   # writes both files
//   node spec/tools/draft-expected.mjs --check spec/fixtures/*/*          # differs from what's committed?
//
// It reads the fixture's fixture.json (if there is one) for the thread options, the permission
// policy and the app's tools, and rewrites only its "steps".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./lib/main.mjs";
import { loadSession } from "./lib/session.mjs";

// ---------- tools ----------

/** Claude's tool names, by what they do. */
function claudeKind(name) {
  if (name.startsWith("mcp__")) return "mcp";
  return (
    {
      Bash: "shell", BashOutput: "shell", Read: "read", NotebookRead: "read", Edit: "edit", MultiEdit: "edit",
      Write: "edit", NotebookEdit: "edit", Glob: "search", Grep: "search", WebFetch: "web", WebSearch: "web",
      Task: "subagent", Agent: "subagent", TodoWrite: "todo",
    }[name] ?? "other"
  );
}

/** A Claude tool_use as a tool_call item's fields (without id, status and the item's own fields). */
function claudeTool(block) {
  const { name, input = {} } = block;
  const t = { name, kind: claudeKind(name), input };
  if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    t.name = rest.join("__");
    if (server === APP_SERVER) t.kind = "app";
    else t.server = server;
  }
  switch (t.kind) {
    case "shell":
      if (typeof input.command === "string") t.command = input.command;
      break;
    case "read":
      if (input.file_path) t.path = input.file_path;
      break;
    case "search":
      if (input.pattern) t.query = input.pattern;
      if (input.path) t.path = input.path;
      break;
    case "web":
      if (input.url) t.url = input.url;
      if (input.query) t.query = input.query;
      break;
    case "edit":
      if (input.file_path) t.changes = [{ path: input.file_path, op: "update" }];
      break;
    case "subagent":
      if (input.description) t.title = input.description;
      break;
    case "todo":
      if (Array.isArray(input.todos)) t.todos = input.todos.map((x) => ({ text: x.content, status: x.status }));
      break;
  }
  return t;
}

/** The in-process MCP server that serves a thread's app tools under Claude. */
const APP_SERVER = "app";

/** Tool result content as text: text blocks joined by newlines, images as [image]. */
function resultText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : b.type === "tool_reference" ? b.tool_name : null))
    .filter((x) => x !== null)
    .join("\n");
}

/** A structuredPatch as a unified diff's hunks. */
function hunks(patch) {
  return patch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("");
}

/** Codex wraps commands in a login shell: `/usr/bin/bash -lc 'cmd'` is shown as cmd. */
export function unwrapCommand(command) {
  const m = /^(?:\S*\/)?(?:bash|zsh|sh) -lc (?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s.exec(command);
  if (!m) return command;
  if (m[1] !== undefined) return m[1].replace(/'\\''/g, "'");
  return m[2].replace(/\\(.)/g, "$1");
}

// ---------- the draft ----------

class Draft {
  constructor(meta, fixture) {
    this.meta = meta;
    this.fixture = fixture;
    this.policy = fixture.permissions ?? "allow";
    this.events = [];
    this.steps = [];
    this.n = {};
    const { harness: _, ...options } = fixture.thread ?? {};
    this.thread = {
      id: "{{thread}}",
      harness: meta.harness,
      status: "idle",
      ...options,
      permission_mode: options.permission_mode ?? "default",
      cwd: "{{cwd}}",
      // Not compared: there so each event is a valid ThreadEvent.
      created_at: "2026-11-01T00:00:00Z",
    };
    this.lastThread = null;
    this.turn = null;
    this.items = new Map();
    this.queued = [];
    this.requests = new Map(); // harness request id -> our request
    this.clientIds = 0;
    this.threadUpdated();
  }

  ph(prefix) {
    this.n[prefix] = (this.n[prefix] ?? 0) + 1;
    return `{{${prefix}${this.n[prefix]}}}`;
  }

  emit(e) {
    this.events.push(structuredClone({ type: e.type, thread_id: "{{thread}}", ...e }));
  }

  threadUpdated() {
    const t = JSON.stringify(this.thread);
    if (t === this.lastThread) return;
    this.lastThread = t;
    this.emit({ type: "thread.updated", thread: JSON.parse(t) });
  }

  setThread(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete this.thread[k];
      else this.thread[k] = v;
    }
    this.threadUpdated();
  }

  /** Before a command: wait for the last event so far, then send it. */
  command(cmd, bind) {
    if (this.events.length > 1 || this.steps.length) this.waitForLast();
    const step = { command: cmd, from: this.events.length };
    this.steps.push(step);
    return bind;
  }

  /** A control request the app sends (with `control`), and the harness's answer: `{result}` or `{error}`. */
  control(request, answer) {
    if (this.events.length > 1 || this.steps.length) this.waitForLast();
    this.steps.push({ control: request, ...answer, from: this.events.length });
  }

  /** The harness reported usage limits: they replace the thread's with the same ids. */
  rateLimits(limits) {
    if (!limits.length) return;
    const all = new Map((this.thread.rate_limits ?? []).map((l) => [l.id, l]));
    for (const l of limits) all.set(l.id, l);
    this.setThread({ rate_limits: [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) });
  }

  waitForLast() {
    // The last event whose pattern an earlier one (since the step before) doesn't match too. The
    // events after it don't depend on the command (a rate limit reported meanwhile, say).
    const last = this.steps[this.steps.length - 1];
    const start = !last ? 0 : last.wait ? last.at + 1 : last.from;
    let at = this.events.length - 1;
    while (at > start && this.events.findIndex((e, i) => i >= start && matches(e, pattern(this.events[at]))) !== at) at--;
    const step = { wait: pattern(this.events[at]) };
    const prev = this.steps.findLast?.((s) => s.wait);
    if (prev && JSON.stringify(prev.wait) === JSON.stringify(step.wait) && prev.at === at) return;
    step.at = at;
    this.steps.push(step);
  }

  item(item) {
    const it = { ...item, turn_id: this.turn?.id };
    if (!it.parent_id) delete it.parent_id;
    if (!it.turn_id) delete it.turn_id;
    this.items.set(it.id, it);
    this.emit({ type: "item.added", item: it });
    return it;
  }

  update(id, patch) {
    const it = this.items.get(id);
    if (!it) return;
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(it[k]) !== JSON.stringify(v ?? undefined)) changed[k] = v;
    }
    if (!Object.keys(changed).length) return;
    for (const [k, v] of Object.entries(changed)) {
      if (v === null) delete it[k];
      else it[k] = v;
    }
    this.emit({ type: "item.updated", item_id: id, patch: changed });
  }

  // ---------- commands ----------

  send(text) {
    const client_id = `c${++this.clientIds}`;
    this.command({ type: "send", text, client_id });
    if (!this.turn) {
      this.startTurn();
      this.item({ id: this.ph("u"), type: "user_message", text, client_id });
      this.emit({ type: "turn.started", turn_id: this.turn.id });
      this.setThread({ status: "running", error: undefined });
    } else {
      const it = this.item({ id: this.ph("u"), type: "user_message", text, steered: true, queued: true, client_id });
      this.queued.push(it);
    }
  }

  /** A turn starts: it notes the session it starts in, for its turn_result's. */
  startTurn() {
    this.turn = { id: this.ph("t"), interrupted: false, usage: null, session: this.thread.session_id, at: undefined };
  }

  /** The harness's mark for the running turn (Claude's last message, Codex's turn id). */
  mark(at) {
    if (this.turn && at) this.turn.at = at;
  }

  /** A command the app sent that the recording noted (see Proc.note). */
  note(c) {
    if (c.type === "rewind") this.rewind(c.turn_id);
    else if (c.type === "new_session") this.newSession();
    else if (c.type === "compact") this.compact();
    else throw new Error(`a note of a command draft-expected doesn't know: ${JSON.stringify(c)}`);
  }

  /** compact: a turn with no user_message, whose compaction the harness is sent next. */
  compact() {
    this.command({ type: "compact" });
    this.startTurn();
    this.compacting = true;
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined });
  }

  /** new_session: the session is let go of, and a notice marks where. */
  newSession() {
    this.command({ type: "new_session" });
    if (!this.thread.session_id) return;
    this.setThread({ session_id: undefined, resume_at: undefined });
    this.item({ id: this.ph("n"), type: "notice", level: "info", code: "session.new", text: NEW_SESSION_TEXT });
  }

  /** rewind: the turn's items and every later one's go, and the session goes back to before it. */
  rewind(turnId) {
    this.command({ type: "rewind", turn_id: turnId });
    const items = [...this.items.values()];
    const results = items.filter((it) => it.type === "turn_result" && !it.parent_id);
    const sessions = results.map((r) => r.session);
    const at = results.findIndex((r) => r.turn_id === turnId);
    // The turns from it on, in the order they ran; what isn't a turn's, after the last turn kept and
    // the first item of one that goes.
    const dropped = new Set(results.slice(at).map((r) => r.turn_id));
    const kept = at > 0 ? items.indexOf(results[at - 1]) : -1;
    const first = items.findIndex((it) => dropped.has(it.turn_id));
    const gone = items.filter((it, i) => dropped.has(it.turn_id) || (!it.turn_id && i > kept && i > first));
    const point = this.meta.harness === "claude" ? resumeAtPoint(sessions, at) : revertPoint(sessions, at);
    for (const it of gone) this.items.delete(it.id);
    this.queued = this.queued.filter((q) => this.items.has(q.id));
    this.emit({ type: "items.removed", item_ids: gone.map((it) => it.id) });
    // A rewind not yet made in the same session still has to be, if this one has no mark to go to.
    const pending = point.session_id !== undefined && point.session_id === this.thread.session_id ? this.thread.resume_at : undefined;
    this.setThread({ session_id: point.session_id, resume_at: point.resume_at ?? pending });
    this.item({ id: this.ph("n"), type: "notice", level: "info", code: "rewind", text: REWIND_TEXT });
  }

  /** The harness echoed a message back or took it in: it's no longer queued. */
  tookIn(text) {
    const i = this.queued.findIndex((q) => q.text === text);
    if (i < 0) return;
    const [it] = this.queued.splice(i, 1);
    this.update(it.id, { queued: null });
  }

  interrupt() {
    this.command({ type: "interrupt" });
    if (this.turn) this.turn.interrupted = true;
  }

  open(request, toolCallId) {
    const r = { ...request, turn_id: this.turn?.id };
    if (toolCallId && this.items.has(toolCallId)) {
      r.tool_call_id = toolCallId;
      const parent = this.items.get(toolCallId).parent_id;
      if (parent) r.parent_id = parent;
      this.update(toolCallId, { status: "pending" });
    }
    this.emit({ type: "request.opened", request: r });
    this.setThread({ status: "waiting" });
    return r;
  }

  respond(r, resolution) {
    // Fixtures have one request open at a time, and the runner fills in its id.
    const open = [...this.requests.values()].filter((x) => !x.resolved);
    if (open.length !== 1) throw new Error(`${open.length} requests are open when one is answered`);
    this.command({ type: "respond", resolution });
    this.emit({ type: "request.resolved", request_id: r.id, resolution });
    r.resolved = true;
    if (![...this.requests.values()].some((x) => !x.resolved)) this.setThread({ status: "running" });
  }

  endTurn({ ok, error, usage, duration_ms }) {
    for (const it of this.items.values()) {
      if (it.type === "tool_call" && it.turn_id === this.turn.id && (it.status === "running" || it.status === "pending")) {
        this.update(it.id, { status: "cancelled" });
      }
    }
    for (const r of this.requests.values()) {
      if (!r.resolved) {
        r.resolved = true;
        this.emit({ type: "request.resolved", request_id: r.id, resolution: { outcome: "cancel" } });
      }
    }
    const tr = { id: this.ph("tr"), type: "turn_result", ok: ok && !this.turn.interrupted };
    if (this.turn.interrupted) tr.interrupted = true;
    if (error && !this.turn.interrupted) tr.error = error;
    if (usage) tr.usage = usage;
    if (duration_ms !== undefined) tr.duration_ms = duration_ms;
    if (this.thread.session_id) {
      tr.session = { id: this.thread.session_id };
      if (this.turn.at) tr.session.at = this.turn.at;
      if (!this.turn.session) tr.session.started = true;
    }
    this.item(tr);
    this.emit({ type: "turn.completed", turn_id: this.turn.id });
    const total = addUsage(this.thread.usage, usage);
    this.turn = null;
    this.setThread({ status: tr.ok || tr.interrupted ? "idle" : "error", error: tr.error, usage: total });
  }

  /** A new process: the backend restarted, unless a rewind or new_session made it start one. */
  newRun() {
    if (this.restartless) this.restartless = false;
    else this.restart();
  }

  restart() {
    this.waitForLast();
    this.steps.push({ restart: true, from: this.events.length });
  }

  finish() {
    this.waitForLast();
    // Each wait must be met by the event it was made from: the first match among the events
    // after the step before it (after a command was sent, or after the last wait's match).
    let from = 0;
    for (const s of this.steps) {
      if (!s.wait) {
        from = Math.max(from, s.from);
        continue;
      }
      const at = this.events.findIndex((e, i) => i >= from && matches(e, s.wait));
      if (at !== s.at) console.warn(`${this.meta.harness}/${this.meta.scenario}: the wait ${JSON.stringify(s.wait)} would be met by event ${at + 1}, not ${s.at + 1}`);
      from = at + 1;
    }
    for (const s of this.steps) {
      delete s.at;
      delete s.from;
    }
  }
}

/** The notices rewind and new_session add. */
const REWIND_TEXT = "The conversation was rewound to here: the agent doesn't remember what came after.";
const NEW_SESSION_TEXT = "A new conversation starts here: the agent doesn't remember what came before.";

/**
 * Where a Claude rewind to before the turn `i` goes, from each turn's session (spec/PROTOCOL.md,
 * "Sessions"): the session it continued, at the last message of the latest turn before it in it.
 */
export function resumeAtPoint(sessions, i) {
  const t = sessions[i];
  if (!t || t.started) return {};
  for (let j = i - 1; j >= 0; j--) {
    const u = sessions[j];
    if (!u || u.id !== t.id) break;
    if (u.at) return { session_id: t.id, resume_at: u.at };
    if (u.started) break;
  }
  throw new Error("the conversation before this turn isn't known");
}

/** Where a Codex rewind to before the turn `i` goes: its session, reverted to before the first turn from it on that has a mark. */
export function revertPoint(sessions, i) {
  const t = sessions[i];
  if (!t || t.started) return {};
  for (let j = i; j < sessions.length; j++) {
    const u = sessions[j];
    if (!u || u.id !== t.id || (j > i && u.started)) break;
    if (u.at) return { session_id: t.id, resume_at: u.at };
  }
  return { session_id: t.id };
}

function addUsage(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k === "cost_usd" ? Math.round(((out[k] ?? 0) + v) * 1e12) / 1e12 : (out[k] ?? 0) + v;
  return out;
}

/** Whether a value has everything a pattern has (objects partially, everything else exactly). */
export function matches(v, p) {
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return !!v && typeof v === "object" && Object.entries(p).every(([k, x]) => matches(v[k], x));
  }
  return JSON.stringify(v) === JSON.stringify(p);
}

/** What a step waits for, to send a command just after an event. */
function pattern(e) {
  const isPh = (s) => typeof s === "string" && s.startsWith("{{");
  switch (e.type) {
    case "thread.updated":
      return { type: e.type, thread: { status: e.thread.status } };
    case "item.added":
      return { type: e.type, item: isPh(e.item.id) ? { type: e.item.type } : { id: e.item.id } };
    case "item.updated":
      return { type: e.type, ...(isPh(e.item_id) ? {} : { item_id: e.item_id }), patch: e.patch.status ? { status: e.patch.status } : {} };
    case "request.opened":
      return { type: e.type, request: { type: e.request.type } };
    case "delta":
      return { type: e.type, item_id: e.item_id };
    default:
      return { type: e.type };
  }
}

// ---------- Claude ----------

function draftClaude(d, runs) {
  let first = true;
  for (const [, entries] of runs) {
    if (!first) d.newRun();
    first = false;
    const asked = new Map(); // CLI request_id -> request
    const msgOfParent = new Map(); // parent_tool_use_id -> current streamed message id
    const blockCount = new Map(); // message id -> blocks seen in assistant messages
    const streamed = new Map(); // block key -> item id, for blocks that got deltas
    let summaryNext = null;
    let interrupted = false;
    // The message that starts a run is sent before the process starts (backends start it then).
    const opener = entries.find((e) => e.dir === "in" && e.msg.type === "user");
    for (const e of entries) {
      if (e.dir === "spawn" && opener) d.send(userText(opener.msg));
      if (e.dir === "command") d.note(e.command);
      if (e.dir === "command" && e.command.type !== "compact") d.restartless = true;
      const m = e.msg;
      if (!m) continue;
      if (e.dir === "in") {
        if (m.type === "user") {
          // The compact command's /compact is its turn's, not a message.
          if (d.compacting && userText(m) === "/compact") d.compacting = false;
          else if (e !== opener) d.send(userText(m));
        } else if (m.type === "control_request" && m.request.subtype === "interrupt") {
          d.interrupt();
          interrupted = true;
        } else if (m.type === "control_request" && m.request.subtype !== "initialize") {
          // The app's own, sent with control().
          const reply = entries.find((x) => x.dir === "out" && x.msg?.type === "control_response" && x.msg.response?.request_id === m.request_id)?.msg.response;
          d.control(m.request, reply?.subtype === "success" ? { result: reply.response ?? {} } : { error: reply?.error ?? "" });
        } else if (m.type === "control_response") {
          const req = asked.get(m.response.request_id);
          const r = d.requests.get(m.response.request_id);
          if (!req || !r) continue;
          const body = m.response.response;
          if (r.type === "question") {
            const answers = {};
            for (const [q, a] of Object.entries(body.updatedInput.answers)) answers[q] = a.split(", ");
            d.respond(r, { outcome: "answer", answers });
            d.update(req.tool_use_id, { status: "running" });
          } else {
            const resolution = body.behavior === "allow" ? { outcome: "allow" } : { outcome: "deny", message: body.message };
            d.respond(r, resolution);
            d.update(req.tool_use_id, { status: body.behavior === "allow" ? "running" : "denied" });
          }
        }
        continue;
      }
      if (e.dir !== "out") continue;
      const parent = m.parent_tool_use_id ?? undefined;
      // The main conversation's messages: the last of a turn's is where a rewind can resume.
      if ((m.type === "user" || m.type === "assistant") && !parent) d.mark(m.uuid);
      // A message refused for the usage limit says which limit, before anything else it leads to.
      if (["assistant", "user", "result"].includes(m.type) && m.api_error === "usage_limit_reached" && m.api_error_params?.rate_limit_info) {
        d.rateLimits(claudeLimits(m.api_error_params.rate_limit_info));
      }
      switch (m.type) {
        case "rate_limit_event":
          d.rateLimits(claudeLimits(m.rate_limit_info ?? {}));
          break;
        case "system":
          // The session it runs in; a rewind's resume_at is done with once it's resumed there.
          if (m.subtype === "init" && (m.session_id !== d.thread.session_id || d.thread.resume_at)) d.setThread({ session_id: m.session_id, resume_at: undefined });
          if (m.subtype === "api_retry") d.item({ id: d.ph("n"), type: "notice", level: "warning", code: "retry", text: retryText(m), parent_id: parent });
          if (m.subtype === "hook_response") {
            const n = hookNotice(m);
            if (n) d.item({ id: d.ph("n"), type: "notice", ...n, code: "hook", parent_id: parent });
          }
          if (m.subtype === "compact_boundary") {
            d.item({ id: m.uuid, type: "compaction", trigger: m.compact_metadata.trigger, tokens_before: m.compact_metadata.pre_tokens });
            summaryNext = m.uuid;
          }
          break;
        case "stream_event": {
          const ev = m.event;
          if (ev.type === "message_start") msgOfParent.set(parent, ev.message.id);
          if (ev.type === "content_block_delta") {
            const msgId = m.api_message_id ?? msgOfParent.get(parent);
            const key = `${msgId}:${ev.index}`;
            const kind = ev.delta.type === "text_delta" ? "text" : ev.delta.type === "thinking_delta" ? "reasoning" : null;
            const text = ev.delta.text ?? ev.delta.thinking;
            if (!kind || !text) break;
            if (!streamed.has(key)) {
              streamed.set(key, key);
              d.item({ id: key, type: kind === "text" ? "assistant_message" : "reasoning", text: "", parent_id: parent });
            }
            d.emit({ type: "delta", item_id: key, kind, text });
          }
          break;
        }
        case "assistant": {
          const msgId = m.message.id;
          for (const block of m.message.content) {
            const index = blockCount.get(msgId) ?? 0;
            blockCount.set(msgId, index + 1);
            const key = `${msgId}:${index}`;
            if (block.type === "text" || block.type === "thinking") {
              if (m.message.model === "<synthetic>") continue;
              const text = block.type === "text" ? block.text : block.thinking;
              if (streamed.has(key)) d.update(key, { text });
              else if (text) d.item({ id: key, type: block.type === "text" ? "assistant_message" : "reasoning", text, parent_id: parent });
            } else if (block.type === "tool_use") {
              d.item({ id: block.id, type: "tool_call", ...claudeTool(block), status: "running", parent_id: parent });
            }
          }
          break;
        }
        case "user": {
          if (m.isReplay) {
            const c = m.message.content;
            d.tookIn(typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
            break;
          }
          const content = m.message.content;
          if (typeof content === "string") {
            if (summaryNext && m.isSynthetic) {
              d.update(summaryNext, { summary: content });
              summaryNext = null;
            }
            break;
          }
          for (const b of content) {
            if (b.type !== "tool_result") continue;
            const it = d.items.get(b.tool_use_id);
            if (!it) continue;
            const patch = {};
            // A denied call stays denied; its result is what the agent was told.
            if (it.status !== "denied") patch.status = b.is_error ? (interrupted ? "cancelled" : "failed") : "completed";
            patch.result = { content: resultText(b.content) };
            const tur = m.tool_use_result;
            if (it.kind === "edit" && tur && Array.isArray(tur.structuredPatch) && !b.is_error) {
              patch.changes = [{ path: tur.filePath ?? it.changes?.[0]?.path, op: tur.type === "create" ? "add" : "update", diff: tur.type === "create" ? tur.content : hunks(tur.structuredPatch) }];
            }
            d.update(b.tool_use_id, patch);
          }
          break;
        }
        case "control_request": {
          asked.set(m.request_id, m.request);
          const req = m.request;
          if (req.subtype !== "can_use_tool") break;
          if (req.tool_name === "AskUserQuestion") {
            const questions = req.input.questions.map((q) => ({
              id: q.question,
              question: q.question,
              ...(q.header ? { header: q.header } : {}),
              options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
              ...(q.multiSelect ? { multi_select: true } : {}),
              allow_other: true,
            }));
            const r = d.open({ id: d.ph("q"), type: "question", questions }, req.tool_use_id);
            d.requests.set(m.request_id, r);
          } else if (d.policy === "ask") {
            const t = claudeTool({ name: req.tool_name, input: req.input });
            const r = { id: d.ph("p"), type: "permission", name: t.name, kind: t.kind, input: req.input, title: title(t) };
            if (req.decision_reason) r.reason = req.decision_reason;
            d.requests.set(m.request_id, d.open(r, req.tool_use_id));
          }
          break;
        }
        case "result": {
          d.endTurn({
            ok: !m.is_error,
            error: m.is_error ? (m.result || (m.errors ?? []).join("\n") || m.subtype) : undefined,
            usage: claudeUsage(m),
            duration_ms: m.duration_ms,
          });
          interrupted = false;
          break;
        }
      }
    }
  }
}

/**
 * What a turn used. A result's usage is its last model call's (it leaves out compaction and
 * subagents) and its total_cost_usd the session's so far (across resumes too), so it's
 * model_usage_since_last_result, summed over the models.
 */
export function claudeUsage(result) {
  const u = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  for (const m of Object.values(result.model_usage_since_last_result ?? {})) {
    u.input_tokens += m.inputTokens ?? 0;
    u.output_tokens += m.outputTokens ?? 0;
    u.cache_read_tokens += m.cacheReadInputTokens ?? 0;
    u.cache_write_tokens += m.cacheCreationInputTokens ?? 0;
    u.cost_usd = Math.round((u.cost_usd + (m.costUSD ?? 0)) * 1e12) / 1e12;
  }
  return u;
}

/** A Claude rate_limit_info as the rate limits it reports (none, or one). */
export function claudeLimits(info) {
  const overage = info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
  const status = { allowed: "allowed", allowed_warning: "warning", rejected: overage ? "warning" : "rejected" }[info.status];
  if (!status) return [];
  const l = { id: info.rateLimitType || "unknown", status };
  if (typeof info.utilization === "number") l.used_percent = info.utilization * 100;
  if (typeof info.resetsAt === "number") l.resets_at = unixTime(info.resetsAt);
  return [l];
}

/** Unix seconds as YYYY-MM-DDTHH:MM:SSZ. */
const unixTime = (s) => new Date(Math.floor(s) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** An api_retry's notice text. */
function retryText(m) {
  const why = [m.error ? String(m.error) : "", m.error_status != null ? `status ${m.error_status}` : ""].filter(Boolean).join(", ");
  return `API request failed${why ? ` (${why})` : ""}; retrying in ${Math.ceil((m.retry_delay_ms ?? 0) / 1000)}s (attempt ${m.attempt} of ${m.max_retries}).`;
}

/** A hook_response's notice (level, text and detail), if it makes one. */
function hookNotice(m) {
  const output = typeof m.output === "string" ? m.output.trim() : "";
  if (m.outcome === "error") {
    const detail = (typeof m.stderr === "string" ? m.stderr.trim() : "") || output;
    const code = typeof m.exit_code === "number" ? ` (exit code ${m.exit_code})` : "";
    return { level: "warning", text: `Hook ${m.hook_name} failed${code}`, ...(detail ? { detail } : {}) };
  }
  return output ? { level: "info", text: `Hook ${m.hook_name} ran`, detail: output } : null;
}

const userText = (m) => {
  const c = m.message.content;
  return typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
};

/** A permission's title: what it's about, in a few words. */
function title(t) {
  if (t.command) return t.command;
  if (t.path) return t.path;
  if (t.changes?.length) return t.changes.map((c) => c.path).join(", ");
  return t.name;
}

// ---------- Codex ----------

/** The requests a Codex driver sends itself: any other is the app's. */
const DRIVER_METHODS = new Set(["initialize", "skills/list", "skills/extraRoots/set", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt", "thread/compact/start", "thread/revert"]);

/** A Codex rate limit snapshot as the rate limits it reports: its primary and secondary windows. */
export function codexLimits(rl) {
  const prefix = rl.limitId && rl.limitId !== "codex" ? `${rl.limitId}:` : "";
  const out = [];
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const credits = rl.credits?.hasCredits === true || rl.credits?.unlimited === true;
    const l = { id: prefix + key, status: typeof w.usedPercent === "number" && w.usedPercent >= 100 ? (credits ? "warning" : "rejected") : "allowed" };
    if (typeof w.usedPercent === "number") l.used_percent = w.usedPercent;
    if (typeof w.resetsAt === "number") l.resets_at = unixTime(w.resetsAt);
    if (typeof w.windowDurationMins === "number") l.window_minutes = w.windowDurationMins;
    out.push(l);
  }
  return out;
}

function draftCodex(d, runs) {
  let first = true;
  let mainThread = null;
  const children = new Map(); // child thread id -> spawnAgent call id
  for (const [, entries] of runs) {
    if (!first) d.newRun();
    first = false;
    const asked = new Map(); // server request id -> request
    const sentReq = new Map(); // our request id -> method
    const streamed = new Set();
    // Whether Codex has reported the thread's tokens in this run, and what its turn has used: the sum
    // of each model call's (`last`) since the turn started. (Its running totals aren't: they're the
    // session's from before the thread adopted it, and a revert doesn't take them back.)
    let reported = false;
    let used = null;
    let lastChildMessage = new Map();
    let error = null;
    const text = (m) => (m.params?.input ?? []).filter((i) => i.type === "text").map((i) => i.text).join("\n");
    // The message that starts a run is sent before the process starts (backends start it then).
    const opener = entries.find((e) => e.dir === "in" && (e.msg.method === "turn/start" || e.msg.method === "thread/compact/start"));
    for (const e of entries) {
      if (e.dir === "spawn" && opener) d.send(opener.msg.method === "turn/start" ? text(opener.msg) : "/compact");
      if (e.dir === "command") d.note(e.command);
      if (e.dir === "command" && e.command.type !== "compact") d.restartless = true;
      const m = e.msg;
      if (!m) continue;
      if (e.dir === "in") {
        if (m.method !== undefined) {
          if (m.id !== undefined) sentReq.set(m.id, m.method);
          // The compact command's compaction is its turn's, not a message.
          if (m.method === "thread/compact/start" && d.compacting) d.compacting = false;
          else if (m.method === "turn/start" || m.method === "thread/compact/start") {
            if (e !== opener) d.send(m.method === "turn/start" ? text(m) : "/compact");
          } else if (m.method === "turn/steer") d.send(text(m));
          else if (m.method === "turn/interrupt") d.interrupt();
          else if (m.id !== undefined && !DRIVER_METHODS.has(m.method)) {
            // The app's own, sent with control().
            const reply = entries.find((x) => x.dir === "out" && x.msg?.id === m.id && x.msg.method === undefined)?.msg;
            const request = { method: m.method, ...(m.params !== undefined ? { params: m.params } : {}) };
            d.control(request, reply?.error ? { error: reply.error.message ?? "" } : { result: reply?.result ?? null });
          }
          continue;
        }
        const req = asked.get(m.id);
        const r = d.requests.get(m.id);
        if (!req || !r) continue;
        if (r.type === "question") {
          const answers = Object.fromEntries(Object.entries(m.result.answers).map(([k, v]) => [k, v.answers]));
          d.respond(r, { outcome: "answer", answers });
          d.update(r.tool_call_id, {
            status: "completed",
            result: { content: Object.entries(answers).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n") },
          });
        } else {
          const ok = m.result.decision ? m.result.decision === "accept" || m.result.decision === "acceptForSession" : m.result.action === "accept";
          d.respond(r, { outcome: ok ? "allow" : "deny" });
          if (r.tool_call_id) d.update(r.tool_call_id, { status: ok ? "running" : "denied" });
        }
        continue;
      }
      if (e.dir !== "out") continue;
      if (m.method === undefined) {
        // A response to one of the backend's requests.
        const method = sentReq.get(m.id);
        if ((method === "thread/start" || method === "thread/resume") && m.result?.thread) {
          mainThread = m.result.thread.id;
          if (d.thread.session_id !== mainThread) d.setThread({ session_id: mainThread });
        }
        // A rewind's revert is done.
        if (method === "thread/revert" && m.result) d.setThread({ resume_at: undefined });
        continue;
      }
      const p = m.params ?? {};
      const child = p.threadId && p.threadId !== mainThread ? p.threadId : null;
      const parent = child ? children.get(child) : undefined;
      if (child && parent === undefined) continue; // a thread we don't know
      if (m.id !== undefined) {
        asked.set(m.id, m);
        switch (m.method) {
          case "item/commandExecution/requestApproval":
          case "item/fileChange/requestApproval":
          case "mcpServer/elicitation/request": {
            if (d.policy !== "ask") break;
            const it = d.items.get(p.itemId) ?? [...d.items.values()].findLast((i) => i.type === "tool_call" && i.kind === "mcp" && i.server === p.serverName && i.status === "running");
            const r = { id: d.ph("p"), type: "permission", name: it?.name ?? "", kind: it?.kind ?? "other", input: it?.input ?? {}, title: it ? title(it) : p.message };
            if (p.reason) r.reason = p.reason;
            d.requests.set(m.id, d.open(r, it?.id));
            break;
          }
          case "item/tool/requestUserInput": {
            d.item({
              id: p.itemId,
              type: "tool_call",
              name: "request_user_input",
              kind: "other",
              input: { questions: p.questions },
              status: "pending",
              parent_id: parent,
            });
            const questions = p.questions.map((q) => ({
              id: q.id,
              question: q.question,
              ...(q.header ? { header: q.header } : {}),
              ...(q.options ? { options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
              ...(q.isOther ? { allow_other: true } : {}),
              ...(q.isSecret ? { secret: true } : {}),
            }));
            const r = { id: d.ph("q"), type: "question", questions, tool_call_id: p.itemId, turn_id: d.turn?.id };
            if (parent) r.parent_id = parent;
            d.emit({ type: "request.opened", request: r });
            d.setThread({ status: "waiting" });
            d.requests.set(m.id, r);
            break;
          }
        }
        continue;
      }
      switch (m.method) {
        case "item/started":
        case "item/completed": {
          const item = p.item;
          const done = m.method === "item/completed";
          switch (item.type) {
            case "userMessage":
              if (!child && !done) d.tookIn(item.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
              break;
            case "agentMessage":
            case "reasoning": {
              if (!done) break;
              const text = item.type === "agentMessage" ? item.text : [...(item.summary ?? [])].join("\n\n");
              if (child) lastChildMessage.set(child, item.text ?? lastChildMessage.get(child));
              if (streamed.has(item.id)) d.update(item.id, { text });
              else if (text) d.item({ id: item.id, type: item.type === "agentMessage" ? "assistant_message" : "reasoning", text, parent_id: parent });
              break;
            }
            case "commandExecution":
            case "fileChange":
            case "mcpToolCall":
            case "dynamicToolCall": {
              if (!done) {
                d.item({ id: item.id, type: "tool_call", ...codexTool(item), status: "running", parent_id: parent });
                break;
              }
              d.update(item.id, codexDone(item, d.items.get(item.id)));
              break;
            }
            case "collabAgentToolCall": {
              if (item.tool !== "spawnAgent") break;
              if (!done) {
                d.item({ id: item.id, type: "tool_call", name: "spawnAgent", kind: "subagent", input: { prompt: item.prompt }, status: "running", title: item.prompt, parent_id: parent });
              } else {
                for (const t of item.receiverThreadIds ?? []) children.set(t, item.id);
              }
              break;
            }
            case "contextCompaction":
              if (!done) d.item({ id: item.id, type: "compaction", trigger: "manual", parent_id: parent });
              break;
          }
          break;
        }
        case "item/agentMessage/delta":
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta": {
          if (!p.delta) break;
          const kind = m.method === "item/agentMessage/delta" ? "text" : "reasoning";
          if (!streamed.has(p.itemId)) {
            streamed.add(p.itemId);
            d.item({ id: p.itemId, type: kind === "text" ? "assistant_message" : "reasoning", text: "", parent_id: parent });
          }
          d.emit({ type: "delta", item_id: p.itemId, kind, text: p.delta });
          break;
        }
        case "warning":
          if (!child && p.threadId) d.item({ id: d.ph("n"), type: "notice", level: "warning", text: p.message });
          break;
        case "error":
          if (child) break;
          if (p.willRetry) d.item({ id: d.ph("n"), type: "notice", level: "warning", code: "retry", text: p.error.message });
          else error = p.error.message;
          break;
        case "turn/started":
          if (!child) used = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
          break;
        case "thread/tokenUsage/updated":
          if (child) break;
          reported = true;
          if (used) used = addUsage(used, callUsage(p.tokenUsage.last));
          break;
        case "account/rateLimits/updated":
          d.rateLimits(codexLimits(p.rateLimits ?? {}));
          break;
        case "turn/completed": {
          if (child) {
            d.update(parent, { status: "completed", result: { content: lastChildMessage.get(child) ?? "" } });
            break;
          }
          const turn = p.turn;
          d.mark(turn.id);
          const usage = reported ? (used ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }) : undefined;
          used = null;
          d.endTurn({
            ok: turn.status === "completed",
            error: turn.status === "failed" ? (turn.error?.message ?? error ?? "the turn failed") : undefined,
            usage,
            duration_ms: turn.durationMs ?? undefined,
          });
          error = null;
          break;
        }
      }
    }
  }
}

/** A model call's tokens (tokenUsage.last) as usage: input_tokens leaves out the cached ones. */
function callUsage(last) {
  return {
    input_tokens: last.inputTokens - last.cachedInputTokens,
    output_tokens: last.outputTokens,
    cache_read_tokens: last.cachedInputTokens,
    cache_write_tokens: last.cacheWriteInputTokens ?? 0,
  };
}

function codexTool(item) {
  switch (item.type) {
    case "commandExecution":
      return { name: "commandExecution", kind: "shell", input: { command: item.command, cwd: item.cwd }, command: unwrapCommand(item.command) };
    case "fileChange":
      return { name: "fileChange", kind: "edit", input: { changes: item.changes }, changes: fileChanges(item.changes) };
    case "mcpToolCall":
      return { name: item.tool, kind: "mcp", input: item.arguments ?? {}, server: item.server };
    case "dynamicToolCall":
      return { name: item.tool, kind: "app", input: item.arguments ?? {} };
  }
}

function fileChanges(changes) {
  return (changes ?? []).map((c) => {
    const op = c.kind?.type === "add" ? "add" : c.kind?.type === "delete" ? "delete" : "update";
    const f = { path: c.path, op };
    if (c.diff) f.diff = c.diff;
    if (c.kind?.move_path) f.move_to = c.kind.move_path;
    return f;
  });
}

function codexDone(item, it) {
  const status = { completed: "completed", failed: "failed", declined: "denied", inProgress: "running" }[item.status] ?? "completed";
  const patch = { status: it?.status === "denied" ? "denied" : status };
  switch (item.type) {
    case "commandExecution":
      // A command with no output has none (null), but still an exit code.
      if (typeof item.aggregatedOutput === "string" || typeof item.exitCode === "number") {
        patch.result = { content: item.aggregatedOutput ?? "" };
        if (typeof item.exitCode === "number") patch.result.exit_code = item.exitCode;
      }
      break;
    case "fileChange":
      patch.changes = fileChanges(item.changes);
      break;
    case "mcpToolCall":
      if (item.result) {
        patch.result = { content: resultText(item.result.content) };
        if (item.result.structuredContent) patch.result.structured = item.result.structuredContent;
      } else if (item.error) patch.result = { content: item.error.message ?? String(item.error) };
      break;
    case "dynamicToolCall":
      patch.result = { content: (item.contentItems ?? []).filter((c) => c.type === "inputText").map((c) => c.text).join("\n") };
      break;
  }
  return patch;
}

// ---------- main ----------

export function draft(dir) {
  const { meta, runs } = loadSession(dir);
  const fixturePath = join(dir, "fixture.json");
  const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : {};
  // A thread made from a session the recording started with (adopt) has its id.
  if (meta.thread) fixture.thread = { ...fixture.thread, ...meta.thread };
  const d = new Draft(meta, fixture);
  if (meta.harness === "claude") draftClaude(d, runs);
  else draftCodex(d, runs);
  d.finish();
  // Number the saved events; a delta carries the seq of the last saved event before it, and the
  // length of its item's text before it.
  let seq = 0;
  const texts = new Map(); // item id -> its text so far
  const events = d.events.map((e) => {
    if (e.type !== "delta") seq++;
    let { type, thread_id, ...rest } = e;
    if (type === "item.added" && typeof e.item.text === "string") texts.set(e.item.id, e.item.text);
    if (type === "item.updated" && typeof e.patch.text === "string") texts.set(e.item_id, e.patch.text);
    if (type === "delta") {
      const offset = texts.get(e.item_id)?.length ?? 0;
      texts.set(e.item_id, (texts.get(e.item_id) ?? "") + e.text);
      const { item_id, kind, text, ...more } = rest;
      rest = { item_id, kind, offset, text, ...more };
    }
    return { type, thread_id, seq, ...rest };
  });
  return { meta, fixture, events, steps: d.steps };
}

const args = process.argv.slice(2);
if (args.length && isMain(import.meta.url)) {
  const check = args[0] === "--check";
  let bad = 0;
  for (const dir of check ? args.slice(1) : args) {
    const { fixture, events, steps } = draft(dir);
    const expected = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const fx = JSON.stringify({ ...fixture, steps }, null, 2) + "\n";
    if (check) {
      const same = (f, s) => existsSync(join(dir, f)) && readFileSync(join(dir, f), "utf8") === s;
      if (!same("expected.jsonl", expected) || !same("fixture.json", fx)) {
        console.log(`${dir}: the draft differs from what's committed`);
        bad++;
      }
    } else {
      writeFileSync(join(dir, "expected.jsonl"), expected);
      writeFileSync(join(dir, "fixture.json"), fx);
      console.log(`${dir}: ${events.length} events, ${steps.length} steps`);
    }
  }
  process.exit(bad ? 1 : 0);
}

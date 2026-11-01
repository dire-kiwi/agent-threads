#!/usr/bin/env node
// Compares the events a backend produced for a fixture with the fixture's expected.jsonl, by the
// rules in spec/fixtures/README.md ("Comparing events"). Backends can call it from their tests or
// implement the same rules natively.
//
//   node spec/tools/check-events.mjs spec/fixtures/claude/plain-reply actual.jsonl
//
// It exits 0 if they match, and 1 with the first difference if they don't (an event that isn't a
// valid ThreadEvent is one).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./lib/main.mjs";
import { branch, def, validate } from "./lib/schema.mjs";

const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Fields that are the backend's own business, and harness payloads, which aren't compared. */
const DROP = new Set(["raw", "created_at", "updated_at", "seq"]);

/**
 * A value as compared, by its schema: the fields in DROP left out, and optional fields that are
 * false or "" (which the protocol lets a backend leave out) too. Required fields stay, whatever
 * their value. Values with no properties in the schema (a tool's input, structured output, an
 * app's metadata) are the harness's or the app's own, and stay as they are.
 */
function clean(v, schema) {
  const s = branch(schema, v);
  if (Array.isArray(v)) return s?.items ? v.map((x) => clean(x, s.items)) : v;
  if (!v || typeof v !== "object" || !s?.properties) return v;
  const required = new Set(s.required ?? []);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROP.has(k) || x === undefined) continue;
    if ((x === false || x === "") && !required.has(k)) continue;
    out[k] = s.properties[k] ? clean(x, s.properties[k]) : x;
  }
  return out;
}

/**
 * An item.updated's patch as compared. Its fields are operations (setting a field to false isn't
 * the same as leaving it unchanged), so they all stay but DROP's; their values are cleaned by the
 * patched item's schema.
 */
function cleanPatch(patch, itemSchema) {
  const out = {};
  for (const [k, x] of Object.entries(patch ?? {})) {
    if (DROP.has(k)) continue;
    const p = itemSchema?.properties?.[k];
    out[k] = p && x !== null ? clean(x, p) : x;
  }
  return out;
}

/**
 * A stream of events as compared: cleaned, with thread.run left out, a thread.updated that
 * changes nothing (once cleaned) dropped, and runs of deltas to the same item joined (with the
 * first one's offset).
 */
export function normalize(events) {
  const out = [];
  const itemSchemas = new Map(); // item id -> its schema, for patches
  let lastThread = null;
  for (const e of events) {
    const c = clean(e, def("ThreadEvent"));
    if (c.type === "item.added") itemSchemas.set(e.item?.id, branch(def("Item"), e.item));
    if (c.type === "item.updated") c.patch = cleanPatch(e.patch, itemSchemas.get(e.item_id));
    if (c.type === "thread.updated") {
      delete c.thread.run;
      const t = JSON.stringify(sortKeys(c.thread));
      if (t === lastThread) continue;
      lastThread = t;
    }
    const prev = out[out.length - 1];
    if (c.type === "delta" && prev?.type === "delta" && prev.item_id === c.item_id && prev.kind === c.kind) {
      prev.text = (prev.text ?? "") + (c.text ?? "");
      continue;
    }
    out.push(c);
  }
  return out;
}

/** The first event a backend sent that isn't a valid ThreadEvent, and why. */
export function checkValid(events) {
  for (const [i, e] of events.entries()) {
    const errors = validate(e, def("ThreadEvent"), "event");
    if (errors.length) return `event ${i + 1} (${e?.type}) isn't a valid ThreadEvent: ${errors.slice(0, 3).join("; ")}`;
  }
  return null;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

/** Problems with the seq numbers of the events a backend sent. */
export function checkSeq(events) {
  let seq = 0;
  for (const [i, e] of events.entries()) {
    if (e.type === "delta") {
      if (e.seq !== seq) return `event ${i + 1} (a delta) has seq ${e.seq}, not ${seq}, the seq of the saved event before it`;
    } else if (e.seq !== ++seq) return `event ${i + 1} (${e.type}) has seq ${e.seq}, not ${seq}`;
  }
  return null;
}

/** The first delta whose offset isn't the length of its item's text before it. */
export function checkOffsets(events) {
  const texts = new Map(); // item id -> its text so far
  for (const [i, e] of events.entries()) {
    if (e.type === "item.added" && typeof e.item.text === "string") texts.set(e.item.id, e.item.text);
    if (e.type === "item.updated" && typeof e.patch.text === "string") texts.set(e.item_id, e.patch.text);
    if (e.type !== "delta") continue;
    const text = texts.get(e.item_id) ?? "";
    if (e.offset !== text.length) return `event ${i + 1} (a delta) has offset ${e.offset}, not ${text.length}, the length of its item's text before it`;
    texts.set(e.item_id, text + e.text);
  }
  return null;
}

const PLACEHOLDER = /^\{\{([a-z0-9_]+)\}\}$/;

/**
 * Compare a backend's events with a fixture's expected ones.
 * @returns {{ ok: true, bindings: Record<string, unknown> } | { ok: false, error: string }}
 */
export function compare(expectedEvents, actualEvents) {
  const invalid = checkValid(actualEvents);
  if (invalid) return { ok: false, error: invalid };
  const seqProblem = checkSeq(actualEvents);
  if (seqProblem) return { ok: false, error: seqProblem };
  const offsetProblem = checkOffsets(actualEvents);
  if (offsetProblem) return { ok: false, error: offsetProblem };
  const want = normalize(expectedEvents);
  const got = normalize(actualEvents);
  const bindings = {};
  const bound = new Map(); // value -> placeholder, so two placeholders can't share a value
  const diff = (w, g, path) => {
    if (typeof w === "string" && PLACEHOLDER.test(w)) {
      const name = PLACEHOLDER.exec(w)[1];
      if (g === undefined) return `${path}: expected a value for {{${name}}}, got nothing`;
      if (name in bindings) return same(bindings[name], g) ? null : `${path}: expected {{${name}}} (${JSON.stringify(bindings[name])}), got ${JSON.stringify(g)}`;
      const key = JSON.stringify(g);
      if (bound.has(key)) return `${path}: {{${name}}} got ${key}, which is already {{${bound.get(key)}}}`;
      bindings[name] = g;
      bound.set(key, name);
      return null;
    }
    if (typeof w === "number" && typeof g === "number") {
      return Math.abs(w - g) <= 1e-9 * Math.max(1, Math.abs(w)) ? null : `${path}: expected ${w}, got ${g}`;
    }
    if (Array.isArray(w)) {
      if (!Array.isArray(g)) return `${path}: expected an array, got ${JSON.stringify(g)}`;
      if (w.length !== g.length) return `${path}: expected ${w.length} entries, got ${g.length}: ${JSON.stringify(g).slice(0, 300)}`;
      for (let i = 0; i < w.length; i++) {
        const d = diff(w[i], g[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    if (w && typeof w === "object") {
      if (!g || typeof g !== "object" || Array.isArray(g)) return `${path}: expected an object, got ${JSON.stringify(g)}`;
      for (const k of Object.keys(w)) {
        const d = diff(w[k], g[k], `${path}.${k}`);
        if (d) return d;
      }
      const extra = Object.keys(g).filter((k) => !(k in w));
      if (extra.length) return `${path}: unexpected ${extra.map((k) => `${k}: ${JSON.stringify(g[k]).slice(0, 200)}`).join(", ")}`;
      return null;
    }
    return same(w, g) ? null : `${path}: expected ${JSON.stringify(w)}, got ${JSON.stringify(g)}`;
  };
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (i >= want.length) return { ok: false, error: `unexpected event ${i + 1} (once normalized): ${JSON.stringify(got[i]).slice(0, 400)}` };
    if (i >= got.length) return { ok: false, error: `missing event ${i + 1} (once normalized): ${JSON.stringify(want[i]).slice(0, 400)}` };
    const d = diff(want[i], got[i], `event ${i + 1} (${want[i].type})`);
    if (d) return { ok: false, error: `${d}\n  expected: ${JSON.stringify(want[i]).slice(0, 600)}\n  got:      ${JSON.stringify(got[i]).slice(0, 600)}` };
  }
  return { ok: true, bindings };
}

const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

if (isMain(import.meta.url)) {
  const [fixture, actualPath] = process.argv.slice(2);
  if (!fixture || !actualPath) {
    console.error("usage: node spec/tools/check-events.mjs <fixture dir or expected.jsonl> <actual events .jsonl>");
    process.exit(2);
  }
  const expectedPath = statSync(fixture).isDirectory() ? join(fixture, "expected.jsonl") : fixture;
  const r = compare(readJsonl(expectedPath), readJsonl(actualPath));
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  console.log("ok");
}

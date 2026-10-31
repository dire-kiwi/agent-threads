#!/usr/bin/env node
// Compares the events a backend produced for a fixture with the fixture's expected.jsonl, by the
// rules in spec/fixtures/README.md ("Comparing events"). Backends can call it from their tests or
// implement the same rules natively.
//
//   node spec/tools/check-events.mjs spec/fixtures/claude/plain-reply actual.jsonl
//
// It exits 0 if they match, and 1 with the first difference if they don't.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Fields that are the backend's own business, and harness payloads, which aren't compared. */
const DROP = new Set(["raw", "created_at", "updated_at", "seq"]);
/** Harness data, compared as it is (no false or "" removed). */
const VERBATIM = new Set(["input", "structured"]);

function clean(v, key) {
  if (Array.isArray(v)) return v.map((x) => clean(x));
  if (!v || typeof v !== "object") return v;
  if (VERBATIM.has(key)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROP.has(k) || x === false || x === "" || x === undefined) continue;
    out[k] = VERBATIM.has(k) ? x : clean(x, k);
  }
  return out;
}

/**
 * A stream of events as compared: cleaned, with thread.run left out, a thread.updated that
 * changes nothing (once cleaned) dropped, and runs of deltas to the same item joined.
 */
export function normalize(events) {
  const out = [];
  let lastThread = null;
  for (const e of events) {
    const c = clean(e);
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

const PLACEHOLDER = /^\{\{([a-z0-9_]+)\}\}$/;

/**
 * Compare a backend's events with a fixture's expected ones.
 * @returns {{ ok: true, bindings: Record<string, unknown> } | { ok: false, error: string }}
 */
export function compare(expectedEvents, actualEvents) {
  const seqProblem = checkSeq(actualEvents);
  if (seqProblem) return { ok: false, error: seqProblem };
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

if (import.meta.url === `file://${process.argv[1]}`) {
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

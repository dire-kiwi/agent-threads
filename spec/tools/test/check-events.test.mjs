// check-events: a backend's events match a fixture's expected ones despite what the rules let
// differ (its own ids and timestamps, raw payloads, deltas cut differently, a thread.updated that
// only changes the run), and don't when something that matters differs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "../check-events.mjs";
import { fixtureDirs } from "../lib/fixtures.mjs";

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** The expected events as a backend might really send them. */
function asBackendWould(expected) {
  const fill = (v) => {
    if (typeof v === "string") return v.replace(/^\{\{([a-z0-9_]+)\}\}$/, "real-$1");
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const out = [];
  for (const e of expected.map(fill)) {
    if (e.type === "delta" && e.text.length > 1) {
      const half = Math.ceil(e.text.length / 2);
      out.push({ ...e, text: e.text.slice(0, half) }, { ...e, text: e.text.slice(half) });
      continue;
    }
    if (e.type === "item.added") e.item = { ...e.item, created_at: "2026-11-01T00:00:00Z", raw: { from: "harness" } };
    if (e.type === "thread.updated") {
      e.thread = { ...e.thread, run: { id: "run-1", spawner: "direct" }, updated_at: "2026-11-01T00:00:01Z" };
      out.push(e, { ...e, thread: { ...e.thread, run: { id: "run-1", spawner: "direct", started_at: "2026-11-01T00:00:00Z" } } });
      continue;
    }
    out.push(e);
  }
  let seq = 0;
  return out.map((e) => ({ ...e, seq: e.type === "delta" ? seq : ++seq }));
}

for (const dir of fixtureDirs()) {
  const name = dir.split("/").slice(-2).join("/");
  const expected = readJsonl(join(dir, "expected.jsonl"));

  test(`${name}: what a backend would send matches`, () => {
    const r = compare(expected, asBackendWould(expected));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.bindings.thread, "real-thread");
  });

  test(`${name}: a changed item doesn't match`, () => {
    const actual = asBackendWould(expected);
    const i = actual.findIndex((e) => e.type === "item.added" && e.item.type === "user_message");
    actual[i] = { ...actual[i], item: { ...actual[i].item, text: actual[i].item.text + "!" } };
    assert.equal(compare(expected, actual).ok, false);
  });
}

test("a missing event doesn't match", () => {
  const expected = readJsonl(join(fixtureDirs()[0], "expected.jsonl"));
  // Without its last thread.updated (and the copy of it that only changes the run).
  const actual = asBackendWould(expected.slice(0, -1));
  assert.match(compare(expected, actual).error, /missing event/);
});

test("two placeholders can't be the same value", () => {
  const ev = (seq, id, turn) => ({ type: "item.added", thread_id: "t", seq, item: { id, type: "notice", level: "info", text: "x", turn_id: turn } });
  const expected = [ev(1, "{{n1}}", "{{t1}}"), ev(2, "{{n2}}", "{{t1}}")];
  assert.equal(compare(expected, [ev(1, "a", "x"), ev(2, "b", "x")]).ok, true);
  assert.match(compare(expected, [ev(1, "a", "x"), ev(2, "a", "x")]).error, /already \{\{n1\}\}/);
  assert.match(compare(expected, [ev(1, "a", "x"), ev(2, "b", "y")]).error, /expected \{\{t1\}\}/);
});

test("seq numbers must have no gaps, and a delta has the last saved one", () => {
  const add = (seq) => ({ type: "item.added", thread_id: "t", seq, item: { id: "a", type: "assistant_message", text: "" } });
  const delta = (seq) => ({ type: "delta", thread_id: "t", seq, item_id: "a", kind: "text", text: "hi" });
  assert.match(compare([add(1)], [add(2)]).error, /has seq 2, not 1/);
  assert.match(compare([add(1), delta(1)], [add(1), delta(2)]).error, /a delta/);
});

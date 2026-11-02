// The usage in each fixture's expected.jsonl adds up to what the recording says, checked against the
// session itself rather than through draft-expected.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureDirs } from "../lib/fixtures.mjs";
import { loadSession } from "../lib/session.mjs";

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a}, not ${b}`);

for (const dir of fixtureDirs()) {
  const { meta, runs } = loadSession(dir);
  const outs = [...runs.values()].flat().filter((e) => e.dir === "out" && e.msg).map((e) => e.msg);
  const expected = readJsonl(join(dir, "expected.jsonl"));
  const turns = expected.filter((e) => e.type === "item.added" && e.item.type === "turn_result").map((e) => e.item.usage);
  const thread = expected.findLast((e) => e.type === "thread.updated").thread.usage;

  if (meta.harness === "claude") {
    test(`claude/${meta.scenario}: each turn used what its result says since the last one`, () => {
      const results = outs.filter((m) => m.type === "result");
      assert.equal(turns.length, results.length);
      results.forEach((r, i) => {
        const models = Object.values(r.model_usage_since_last_result ?? {});
        const sum = (k) => models.reduce((n, m) => n + (m[k] ?? 0), 0);
        assert.equal(turns[i].input_tokens, sum("inputTokens"));
        assert.equal(turns[i].output_tokens, sum("outputTokens"));
        assert.equal(turns[i].cache_read_tokens, sum("cacheReadInputTokens"));
        assert.equal(turns[i].cache_write_tokens, sum("cacheCreationInputTokens"));
        close(turns[i].cost_usd, sum("costUSD"), `turn ${i + 1}'s cost`);
      });
      // total_cost_usd is the session's so far, across a resume too, and from before the thread's
      // first turn in it for a session it adopted: the thread's share of each session is how far
      // it grew from before its first turn there. A thread can have several (new_session).
      const sessions = Map.groupBy(results, (r) => r.session_id);
      const cost = (r) => Object.values(r.model_usage_since_last_result ?? {}).reduce((n, m) => n + (m.costUSD ?? 0), 0);
      const share = [...sessions.values()].reduce((n, rs) => n + rs.at(-1).total_cost_usd - rs[0].total_cost_usd + cost(rs[0]), 0);
      close(thread.cost_usd, share, "the thread's cost");
    });
  } else {
    // The thread's own Codex threads (one per session: new_session starts another), as against its
    // subagents'.
    const own = new Set(outs.filter((x) => x.result?.thread).map((x) => x.result.thread.id));
    const asUsage = (t) => ({
      input_tokens: t.inputTokens - t.cachedInputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cachedInputTokens,
      cache_write_tokens: t.cacheWriteInputTokens ?? 0,
    });
    const add = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

    test(`codex/${meta.scenario}: each turn used what its model calls did`, () => {
      // Each run: the `last` of every report from the turn's start to its end, if Codex reported
      // any tokens in the run. A Codex turn that proposed a plan goes on in the next (the answer to
      // it): they're one turn of the thread's.
      const used = [];
      for (const entries of runs.values()) {
        const msgs = entries.filter((e) => e.dir === "out" && e.msg?.method).map((e) => e.msg);
        let reported = false;
        let turn = null;
        let planned = false;
        for (const m of msgs) {
          if (!own.has(m.params?.threadId)) continue;
          if (m.method === "turn/started") turn ??= { ...zero };
          if (m.method === "item/completed" && m.params.item?.type === "plan") planned = true;
          if (m.method === "thread/tokenUsage/updated") {
            reported = true;
            if (turn) turn = add(turn, asUsage(m.params.tokenUsage.last));
          }
          if (m.method === "turn/completed") {
            if (planned && m.params.turn?.status === "completed") {
              planned = false;
              continue;
            }
            used.push(reported ? (turn ?? { ...zero }) : undefined);
            turn = null;
            planned = false;
          }
        }
      }
      assert.deepEqual(turns, used);
    });

    test(`codex/${meta.scenario}: the thread used what Codex's totals say`, () => {
      const totals = outs.filter((m) => m.method === "thread/tokenUsage/updated" && own.has(m.params.threadId));
      if (!totals.length) return assert.equal(thread, undefined);
      // A revert doesn't take Codex's totals back, so they're no check on a thread that reverted.
      if (outs.some((m) => m.method === "thread/reverted")) return;
      // Each session's totals at the end, less what they were when the thread adopted it (its first
      // report, which a resumed session sends before its turn starts) for one it didn't start.
      const started = new Set(
        [...runs.values()].flat().filter((e) => e.dir === "in" && e.msg?.method === "thread/start").map((e) => e.msg.id),
      );
      const startedThreads = new Set(
        [...runs.values()].flat().filter((e) => e.dir === "out" && e.msg?.result?.thread && started.has(e.msg.id)).map((e) => e.msg.result.thread.id),
      );
      let sum = { ...zero };
      for (const [id, ts] of Map.groupBy(totals, (m) => m.params.threadId)) {
        sum = add(sum, asUsage(ts.at(-1).params.tokenUsage.total));
        if (!startedThreads.has(id)) sum = add(sum, Object.fromEntries(Object.entries(asUsage(ts[0].params.tokenUsage.total)).map(([k, v]) => [k, -v])));
      }
      assert.deepEqual(thread, sum);
    });
  }
}

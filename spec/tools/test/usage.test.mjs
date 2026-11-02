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
    test(`codex/${meta.scenario}: the thread used what Codex's totals say`, () => {
      // The thread's own Codex threads (one per session: new_session starts another), as against its
      // subagents'. A session it adopted counts from its start, as the backend doesn't know its
      // totals before.
      const own = new Set(outs.filter((x) => x.result?.thread).map((x) => x.result.thread.id));
      const totals = outs.filter((m) => m.method === "thread/tokenUsage/updated" && own.has(m.params.threadId));
      if (!totals.length) return assert.equal(thread, undefined);
      const sum = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
      for (const ts of Map.groupBy(totals, (m) => m.params.threadId).values()) {
        const t = ts.at(-1).params.tokenUsage.total;
        sum.input_tokens += t.inputTokens - t.cachedInputTokens;
        sum.output_tokens += t.outputTokens;
        sum.cache_read_tokens += t.cachedInputTokens;
        sum.cache_write_tokens += t.cacheWriteInputTokens ?? 0;
      }
      assert.deepEqual(thread, sum);
    });
  }
}

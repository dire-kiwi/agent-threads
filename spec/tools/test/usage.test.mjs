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
      // total_cost_usd is the session's so far, across a resume too.
      close(thread.cost_usd, results.at(-1).total_cost_usd, "the thread's cost");
    });
  } else {
    test(`codex/${meta.scenario}: the thread used what Codex's totals say`, () => {
      const totals = outs.filter((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === outs.find((x) => x.result?.thread)?.result.thread.id);
      if (!totals.length) return assert.equal(thread, undefined);
      const t = totals.at(-1).params.tokenUsage.total;
      assert.deepEqual(thread, {
        input_tokens: t.inputTokens - t.cachedInputTokens,
        output_tokens: t.outputTokens,
        cache_read_tokens: t.cachedInputTokens,
        cache_write_tokens: t.cacheWriteInputTokens ?? 0,
      });
    });
  }
}

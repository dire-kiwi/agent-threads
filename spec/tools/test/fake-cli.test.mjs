// The fake CLI replays every fixture: playing the recorded backend's part (with its own request
// ids, to check they're mapped), it must get the recorded output back and a passing report. And it
// must catch a backend that sends the wrong thing.
//
//   node --test 'spec/tools/test/*.test.mjs'

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fixtureDirs, fixturesDir as fixtures } from "../lib/fixtures.mjs";
import { loadSession } from "../lib/session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = resolve(here, "../fake-cli.mjs");

/** Start the fake CLI for a fixture, collecting its output lines. */
function start(dir, argv, state) {
  const child = spawn(process.execPath, [fakeCli, ...argv], {
    env: { ...process.env, AGENT_THREADS_FIXTURE: dir, AGENT_THREADS_FIXTURE_STATE: state },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = [];
  let stderr = "";
  let waiter = null;
  createInterface({ input: child.stdout }).on("line", (l) => {
    out.push(JSON.parse(l));
    waiter?.();
  });
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const until = async (n) => {
    while (out.length < n) {
      const more = new Promise((r) => (waiter = r));
      const gone = exited.then(() => "exited");
      if ((await Promise.race([more, gone])) === "exited" && out.length < n) {
        throw new Error(`the fake CLI exited after ${out.length} of ${n} outputs: ${stderr}`);
      }
    }
  };
  return { child, out, until, exited, stderr: () => stderr };
}

/** A backend's own ids for its requests, different from the recorded ones. */
function remap(harness, msg) {
  if (harness === "claude" && msg.type === "control_request") return { ...msg, request_id: `mine-${msg.request_id}` };
  if (harness === "codex" && msg.method !== undefined && msg.id !== undefined) return { ...msg, id: msg.id + 1000 };
  return msg;
}

function expectedOut(harness, msg, sentIds) {
  if (harness === "claude" && msg.type === "control_response" && sentIds.has(msg.response.request_id)) {
    return { ...msg, response: { ...msg.response, request_id: `mine-${msg.response.request_id}` } };
  }
  if (harness === "codex" && msg.method === undefined && msg.id !== undefined && sentIds.has(msg.id)) return { ...msg, id: msg.id + 1000 };
  return msg;
}

for (const dir of fixtureDirs()) {
  const { meta, runs } = loadSession(dir);
  test(`replays ${meta.harness}/${meta.scenario}`, async () => {
    const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
    for (const [n, entries] of runs) {
      const [spawnEntry, ...rest] = entries;
      const cli = start(dir, spawnEntry.argv.slice(1), state);
      const sentIds = new Set();
      let outs = 0;
      const want = [];
      for (const e of rest) {
        if (e.dir === "out" && e.msg !== undefined) {
          want.push(expectedOut(meta.harness, e.msg, sentIds));
          outs++;
        } else if (e.dir === "in") {
          await cli.until(outs);
          if (meta.harness === "claude" && e.msg.type === "control_request") sentIds.add(e.msg.request_id);
          if (meta.harness === "codex" && e.msg.method !== undefined && e.msg.id !== undefined) sentIds.add(e.msg.id);
          cli.child.stdin.write(JSON.stringify(remap(meta.harness, e.msg)) + "\n");
        } else if (e.dir === "close") {
          await cli.until(outs);
          cli.child.stdin.end();
        }
      }
      const { code } = await cli.exited;
      assert.equal(cli.stderr().includes("fake-cli:"), false, cli.stderr());
      assert.deepEqual(cli.out, want);
      assert.equal(code, rest.find((e) => e.dir === "exit")?.code ?? 0);
      const report = JSON.parse(readFileSync(join(state, `run-${n}.json`), "utf8"));
      assert.equal(report.ok, true, report.error);
      assert.equal(report.matched, report.expected);
    }
  });
}

test("catches an input that doesn't match", async () => {
  const dir = join(fixtures, "claude/plain-reply");
  const { runs } = loadSession(dir);
  const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
  const cli = start(dir, runs.get(1)[0].argv.slice(1), state);
  cli.child.stdin.write(JSON.stringify({ type: "control_request", request_id: "a", request: { subtype: "initialize" } }) + "\n");
  await cli.until(1);
  cli.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "something else" }, parent_tool_use_id: null }) + "\n");
  const { code } = await cli.exited;
  assert.equal(code, 97);
  assert.match(cli.stderr(), /input 2 of 2 doesn't match/);
  const report = JSON.parse(readFileSync(join(state, "run-1.json"), "utf8"));
  assert.equal(report.ok, false);
});

test("catches arguments that don't match", async () => {
  const dir = join(fixtures, "claude/plain-reply");
  const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
  const cli = start(dir, ["-p", "--output-format", "stream-json"], state);
  const { code } = await cli.exited;
  assert.equal(code, 97);
  assert.match(cli.stderr(), /arguments don't match/);
});

test("accepts a SIGTERM once everything was sent", async () => {
  const dir = join(fixtures, "codex/plain-reply");
  const { runs } = loadSession(dir);
  const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
  const [spawnEntry, ...rest] = runs.get(1);
  const cli = start(dir, spawnEntry.argv.slice(1), state);
  let outs = 0;
  for (const e of rest) {
    if (e.dir === "out" && e.msg !== undefined) outs++;
    if (e.dir === "in") {
      await cli.until(outs);
      cli.child.stdin.write(JSON.stringify(e.msg) + "\n");
    }
    if (e.dir === "close") break;
  }
  await cli.until(outs);
  cli.child.kill("SIGTERM");
  await cli.exited;
  const report = JSON.parse(readFileSync(join(state, "run-1.json"), "utf8"));
  assert.equal(report.ok, true, report.error);
});

test("takes an input sooner than the recording has it", async () => {
  // The test's interrupt can reach the CLI before the backend's automatic answer to a permission.
  const dir = join(fixtures, "claude/interrupt");
  const { runs } = loadSession(dir);
  const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
  const [spawnEntry, ...rest] = runs.get(1);
  const interrupt = rest.find((e) => e.dir === "in" && e.msg.type === "control_request" && e.msg.request.subtype === "interrupt");
  const answer = rest.find((e) => e.dir === "in" && e.msg.type === "control_response");
  assert.ok(rest.indexOf(answer) < rest.indexOf(interrupt));
  const cli = start(dir, spawnEntry.argv.slice(1), state);
  let outs = 0;
  for (const e of rest) {
    if (e.dir === "out" && e.msg !== undefined) outs++;
    if (e.dir === "in" && e !== interrupt) {
      await cli.until(outs);
      if (e === answer) cli.child.stdin.write(JSON.stringify(interrupt.msg) + "\n");
      cli.child.stdin.write(JSON.stringify(e.msg) + "\n");
    }
    if (e.dir === "close") {
      await cli.until(outs);
      cli.child.stdin.end();
    }
  }
  await cli.exited;
  const report = JSON.parse(readFileSync(join(state, "run-1.json"), "utf8"));
  assert.equal(report.ok, true, report.error);
  assert.equal(report.matched, report.expected);
});

/** Play a fixture's first run with the recorded inputs, changing the permission answer. */
async function answerDifferently(scenario, change) {
  const dir = join(fixtures, scenario);
  const { runs } = loadSession(dir);
  const state = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
  const [spawnEntry, ...rest] = runs.get(1);
  const cli = start(dir, spawnEntry.argv.slice(1), state);
  let outs = 0;
  for (const e of rest) {
    if (e.dir === "out" && e.msg !== undefined) outs++;
    if (e.dir === "in" || e.dir === "close") {
      try {
        await cli.until(outs);
      } catch {
        break; // it has given up
      }
      if (e.dir === "close") cli.child.stdin.end();
      else {
        const msg = e.msg.type === "control_response" ? change(structuredClone(e.msg)) : e.msg;
        cli.child.stdin.write(JSON.stringify(msg) + "\n");
      }
    }
  }
  const { code } = await cli.exited;
  return { code, stderr: cli.stderr(), report: JSON.parse(readFileSync(join(state, "run-1.json"), "utf8")) };
}

test("catches an allowed tool whose input the backend changed", async () => {
  const r = await answerDifferently("claude/permission-allow", (m) => {
    m.response.response.updatedInput = { command: "echo DIFFERENT_COMMAND" };
    return m;
  });
  assert.equal(r.code, 97);
  assert.equal(r.report.ok, false);
  assert.match(r.stderr, /DIFFERENT_COMMAND/);
});

test("takes an allow without updatedInput as the input it was asked about", async () => {
  const r = await answerDifferently("claude/permission-allow", (m) => {
    delete m.response.response.updatedInput;
    return m;
  });
  assert.equal(r.report.ok, true, r.report.error);
});

test("catches a denial with a different message", async () => {
  const r = await answerDifferently("claude/permission-deny", (m) => {
    m.response.response.message = "Something else.";
    return m;
  });
  assert.equal(r.code, 97);
  assert.equal(r.report.ok, false);
  assert.match(r.stderr, /Something else/);
});

test("catches a different answer to a question", async () => {
  const r = await answerDifferently("claude/ask-user-question", (m) => {
    const answers = m.response.response.updatedInput.answers;
    for (const q of Object.keys(answers)) answers[q] = "Red";
    return m;
  });
  assert.equal(r.code, 97);
  assert.equal(r.report.ok, false);
});

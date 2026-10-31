#!/usr/bin/env node
// The fake `claude` / `codex`: it replays a recorded session (a fixture's session.jsonl) on stdout
// while checking that what the backend writes to its stdin is what the recorded backend wrote.
// Backends' conformance tests use it as the harness binary, so they run without a CLI or a login.
// See spec/tools/README.md for how a test runner uses it.
//
//   AGENT_THREADS_FIXTURE=spec/fixtures/claude/plain-reply  node spec/tools/fake-cli.mjs -p ...
//
// Environment:
//   AGENT_THREADS_FIXTURE        the fixture directory (or its session.jsonl). Required.
//   AGENT_THREADS_FIXTURE_STATE  a directory for this test's state: which of the fixture's runs is
//                                next, and a report for each run (run-1.json...). Required for a
//                                fixture with several runs; recommended always.
//   AGENT_THREADS_FIXTURE_SPEED  how fast to replay: 0 (the default) sends each output as soon as
//                                the inputs before it have arrived; 1 keeps the recorded timing.
//
// It replays one run per process. Outputs go out in their recorded order; at each recorded input
// it waits for the backend's next line and checks it (consecutive recorded inputs may arrive in any
// order, and one the recording has later may come sooner). At a recorded `close` it waits for stdin to close; at `exit` it exits as the CLI did. If
// an input doesn't match, it says why on stderr, writes the report, and exits with code 97.

import { openSync, closeSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Context, argvKey, same } from "./lib/canon.mjs";
import { flag, loadSession } from "./lib/session.mjs";

const MISMATCH = 97;
const fixture = process.env.AGENT_THREADS_FIXTURE;
const stateDir = process.env.AGENT_THREADS_FIXTURE_STATE;
const speed = Number(process.env.AGENT_THREADS_FIXTURE_SPEED ?? 0);

if (!fixture) {
  process.stderr.write("fake-cli: AGENT_THREADS_FIXTURE isn't set (the fixture directory to replay)\n");
  process.exit(2);
}

const { meta, runs } = loadSession(fixture);
const harness = meta.harness;
const argv = [harness, ...process.argv.slice(2)];
let runNo;
runNo = pickRun();
const entries = runs.get(runNo);
const ctx = new Context(harness);
let matched = 0;
const expected = entries.filter((e) => e.dir === "in").length;

/** Which run this process replays: the next unclaimed one in the state directory. */
function pickRun() {
  if (stateDir) {
    mkdirSync(stateDir, { recursive: true });
    for (let n = 1; n <= runs.size; n++) {
      try {
        closeSync(openSync(join(stateDir, `run-${n}.claimed`), "wx"));
        return n;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    fail(`the backend started the CLI more times than the fixture's ${runs.size} run(s)`, 1);
  }
  if (runs.size === 1) return 1;
  // Without a state directory, a Claude run can still be told apart by what it resumes.
  const resume = flag(argv.slice(1), "--resume");
  for (const [n, es] of runs) if (flag(es[0].argv.slice(1), "--resume") === resume) return n;
  fail("the fixture has several runs: set AGENT_THREADS_FIXTURE_STATE so the fake CLI can tell which is next", 1);
}

function report(ok, error) {
  if (!stateDir) return;
  writeFileSync(join(stateDir, `run-${runNo}.json`), JSON.stringify({ run: runNo, ok, error, matched, expected }) + "\n");
}

function fail(why, run = runNo) {
  const msg = `fake-cli: ${meta.harness}/${meta.scenario} run ${run}: ${why}`;
  process.stderr.write(msg + "\n");
  if (runNo !== undefined) report(false, why);
  process.exit(MISMATCH);
}

// ---------- stdin ----------

const queue = [];
let eof = false;
let wake = null;
const poke = () => {
  const w = wake;
  wake = null;
  w?.();
};
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    try {
      queue.push(JSON.parse(line));
    } catch {
      fail(`the backend wrote a line that isn't JSON: ${line.slice(0, 200)}`);
    }
    poke();
  })
  .on("close", () => {
    eof = true;
    poke();
  });
const arrival = () => new Promise((r) => (wake = r));

// A backend stopping the CLI with a signal is fine once it has sent everything it should have.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    const done = matched === expected;
    report(done, done ? undefined : `stopped by ${sig} after ${matched} of ${expected} inputs`);
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]);
  });
}

const show = (v) => JSON.stringify(v);

// ---------- replay ----------

async function replay() {
  const [spawn, ...rest] = entries;
  const want = argvKey(harness, spawn.argv);
  const got = argvKey(harness, argv);
  if (!same(want, got)) fail(`its arguments don't match the recording's:\n  expected ${show(want)}\n  got      ${show(got)}`);

  const early = new Set();
  let lastT = 0;
  for (let i = 0; i < rest.length; i++) {
    const e = rest[i];
    if (speed > 0 && e.t > lastT) await new Promise((r) => setTimeout(r, (e.t - lastT) * speed));
    lastT = Math.max(lastT, e.t);
    switch (e.dir) {
      case "out": {
        if (e.msg === undefined) {
          process.stdout.write(e.line + "\n");
          break;
        }
        ctx.sent(e.msg);
        process.stdout.write(JSON.stringify(ctx.rewrite(e.msg)) + "\n");
        break;
      }
      case "err":
        process.stderr.write(e.text + "\n");
        break;
      case "in": {
        // This and the recorded inputs right after it, in any order. An input the recording has
        // later (one the backend sent sooner than the recorded backend did) is taken early.
        let j = i;
        while (j + 1 < rest.length && rest[j + 1].dir === "in") j++;
        const group = [];
        for (let g = i; g <= j; g++) if (!early.has(g)) group.push(g);
        while (group.length) {
          while (!queue.length && !eof) await arrival();
          if (!queue.length) fail(`stdin closed while it waited for ${show(ctx.key(rest[group[0]].msg))}`);
          const actual = queue.shift();
          const k = ctx.key(actual);
          const at = group.findIndex((g) => same(ctx.key(rest[g].msg), k));
          if (at >= 0) {
            ctx.matched(rest[group[at]].msg, actual);
            group.splice(at, 1);
            matched++;
            continue;
          }
          const later = rest.findIndex((g, n) => n > j && g.dir === "in" && !early.has(n) && same(ctx.key(g.msg), k));
          if (later < 0) {
            const wanted = group.map((g) => "  " + show(ctx.key(rest[g].msg))).join("\n");
            fail(`input ${matched + 1} of ${expected} doesn't match.\n expected${group.length > 1 ? " one of" : ""}:\n${wanted}\n got:\n  ${show(k)}`);
          }
          early.add(later);
          ctx.matched(rest[later].msg, actual);
          matched++;
        }
        i = j;
        break;
      }
      case "close":
        while (!eof) {
          if (queue.length) fail(`the backend sent more than the recording has: ${show(ctx.key(queue[0]))}`);
          await arrival();
        }
        if (queue.length) fail(`the backend sent more than the recording has: ${show(ctx.key(queue[0]))}`);
        break;
      case "exit": {
        if (queue.length) fail(`the backend sent more than the recording has: ${show(ctx.key(queue[0]))}`);
        report(true);
        await new Promise((r) => process.stdout.write("", r));
        if (e.signal) {
          process.removeAllListeners(e.signal);
          process.kill(process.pid, e.signal);
        }
        process.exit(e.code ?? 0);
      }
    }
  }
  report(true);
}

replay().catch((e) => fail(e.stack ?? String(e)));

#!/usr/bin/env node
// Records real Claude Code and Codex sessions into spec/fixtures/<harness>/<scenario>/session.jsonl.
// It needs the CLIs and a login, so it's run by hand (not in CI) when a fixture is added or the
// CLIs change; see spec/tools/README.md.
//
//   node spec/tools/record.mjs claude plain-reply   # one scenario
//   node spec/tools/record.mjs codex all            # every scenario of a harness
//
// Each session runs in a fresh temporary directory (seeded by scenarios/common.mjs), with its own
// CLAUDE_CONFIG_DIR or CODEX_HOME that has only the login linked in, so the user's settings, MCP
// servers, skills and history stay out of it. The recording is sanitized before it's written.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Proc } from "./lib/proc.mjs";
import { sanitizer } from "./lib/sanitize.mjs";
import { seedWorkdir } from "./scenarios/common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const harnesses = {
  claude: {
    bin: "claude",
    module: "./scenarios/claude.mjs",
    version: () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    setup(tmp) {
      const config = join(tmp, "config");
      mkdirSync(config);
      const from = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
      if (existsSync(from)) symlinkSync(from, join(config, ".credentials.json"));
      const env = cleanEnv((k) => k === "CLAUDECODE" || k.startsWith("CLAUDE_") || k === "AI_AGENT");
      env.CLAUDE_CONFIG_DIR = config;
      return { env, paths: [[config, "/config"]] };
    },
  },
  codex: {
    bin: "codex",
    module: "./scenarios/codex.mjs",
    version: () => execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    setup(tmp) {
      const home = join(tmp, "codex-home");
      mkdirSync(home);
      const from = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
      if (existsSync(from)) symlinkSync(from, join(home, "auth.json"));
      const env = cleanEnv((k) => k.startsWith("CODEX_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_") || k === "AI_AGENT");
      env.CODEX_HOME = home;
      return { env, paths: [[home, "/codex-home"]] };
    },
  },
};

function cleanEnv(drop) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop(k)) env[k] = v;
  return env;
}

async function record(harnessName, scenarioName, scenario, mod) {
  const h = harnesses[harnessName];
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "at-rec-")));
  const work = join(tmp, "work");
  mkdirSync(work);
  seedWorkdir(work);
  const { env, paths } = h.setup(tmp);
  // The CLIs keep their own temporary files under the system's (Claude's are in claude-<uid>), shown as /tmp.
  const system = realpathSync(tmpdir());
  const clean = sanitizer([
    [work, "/work"],
    ...paths,
    [repo, "/repo"],
    [tmp, "/tmp/recording"],
    [basename(tmp), "recording"],
    ...(system !== "/tmp" ? [[system + "/", "/tmp/"]] : []),
  ]);
  const entries = [];
  let runs = 0;
  const ctx = {
    work,
    tmp,
    spawn(args, onMessage) {
      return new Proc({ run: ++runs, bin: h.bin, args, cwd: work, env, record: (e) => entries.push(e), onMessage });
    },
  };
  process.stderr.write(`recording ${harnessName}/${scenarioName}... `);
  try {
    await scenario.run(ctx);
  } finally {
    for (const e of entries) if (e.dir === "spawn") e.argv[0] = h.bin;
    const dir = join(repo, "spec/fixtures", harnessName, scenarioName);
    mkdirSync(dir, { recursive: true });
    const meta = {
      dir: "meta",
      harness: harnessName,
      scenario: scenarioName,
      description: scenario.description,
      cli: h.version(),
      model: scenario.model ?? mod.MODEL,
      recorded: new Date().toISOString().slice(0, 10),
    };
    const lines = clean([meta, ...entries]).map((e) => JSON.stringify(e));
    writeFileSync(join(dir, "session.jsonl"), lines.join("\n") + "\n");
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`${entries.length} entries, ${runs} run(s)\n`);
  }
}

const [harnessName, which = "all"] = process.argv.slice(2);
if (!harnesses[harnessName]) {
  console.error("usage: node spec/tools/record.mjs <claude|codex> <scenario|all>");
  process.exit(2);
}
const mod = await import(harnesses[harnessName].module);
const names = which === "all" ? Object.keys(mod.scenarios) : which.split(",");
for (const name of names) {
  const scenario = mod.scenarios[name];
  if (!scenario) throw new Error(`no ${harnessName} scenario ${name}; there are: ${Object.keys(mod.scenarios).join(", ")}`);
  await record(harnessName, name, scenario, mod);
}

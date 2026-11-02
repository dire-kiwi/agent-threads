// Smoke tests of the whole app, server and frontend, with the fake CLI replaying recorded sessions
// (spec/fixtures) in place of claude and codex: it checks that what the backend sends the CLI is
// what the recording has, so these need no login and cost nothing.

import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { FIXTURES, SHIM, runs, startServer, stopRuns, type Server } from "./server.ts";

let server: Server | undefined;
const ON_PURPOSE = "failing on purpose";
// Every test's server is stopped, and checked to have gone with everything it started, whether the
// test passed or not.
test.afterEach(async ({}, testInfo) => {
  const s = server;
  server = undefined;
  const problems: string[] = [];
  if (testInfo.expectedStatus === "failed" && !testInfo.error?.message?.includes(ON_PURPOSE)) problems.push(`it didn't fail on purpose: ${testInfo.error?.message}`);
  if (s) {
    await s.stop().catch((e: Error) => problems.push(e.message));
    problems.push(...(await s.remains()).map((r) => `${r} outlived its teardown`));
  }
  // So that a test that's meant to fail (test.fail()) doesn't pass whatever its teardown finds.
  if (problems.length) testInfo.expectedStatus = "passed";
  expect(problems).toEqual([]);
});

const LOOKUP = "Look up order 42 with the lookup_order tool and tell me in one short sentence what's in it.";

/** Starts a thread from the new-thread form. */
async function start(page: Page, text: string, harness?: string) {
  if (harness) await page.getByText(harness, { exact: true }).click();
  await page.getByLabel("First message").fill(text);
  await page.getByRole("button", { name: "Start", exact: true }).click();
}

const connection = (page: Page) => page.getByTestId("connection");

test("Claude Code: the app's tool is drawn as an order card, and a reload starts again from a snapshot", async ({ page }) => {
  server = await startServer({ CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/app-tool") });
  await page.goto(server.url);
  await start(page, LOOKUP);

  const check = async () => {
    const card = page.getByTestId("order-card");
    await expect(card).toContainText("Order #42");
    await expect(card).toContainText("Shipped");
    await expect(card).toContainText("3× blue widget");
    await expect(card).toContainText("$36.00");
    await expect(page.getByText("Order 42 contains 3 blue widgets and shipped on 2026-10-30.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Threads" })).toContainText("Look up order 42");
  };
  await check();
  await page.reload();
  await check();
});

test("a snapshot cut off by the connection dropping is taken again on the next connection", async ({ page }) => {
  server = await startServer({ CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/app-tool") });
  await page.goto(server.url);
  await start(page, LOOKUP);
  await expect(page.getByTestId("order-card")).toContainText("Shipped");

  // From now on, the first time the page asks for a snapshot, the connection drops before the
  // answer comes. The page reconnects, asks again, and shows the thread.
  let dropped = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const toServer = ws.connectToServer();
    ws.onMessage((message) => {
      if (!dropped && typeof message === "string" && JSON.parse(message).method === "snapshot") {
        dropped++;
        ws.close();
        toServer.close();
        return;
      }
      toServer.send(message);
    });
  });
  await page.reload();
  await expect(connection(page)).toHaveText("Connected");
  await expect(page.getByTestId("order-card")).toContainText("Shipped");
  await expect(page.getByText("Order 42 contains 3 blue widgets and shipped on 2026-10-30.")).toBeVisible();
  await expect(page.getByText("the connection to the server dropped")).toHaveCount(0);
  expect(dropped).toBe(1);
});

test("Codex: a command asks first, and runs once the user allows it", async ({ page }) => {
  server = await startServer({ CHAT_FAKE_CODEX: join(FIXTURES, "codex/permission-allow") });
  await page.goto(server.url);
  await start(page, "Run this shell command: touch allowed.txt — then reply with just: created", "Codex");
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText("created", { exact: true })).toBeVisible();
});

test("Codex: the app's tool as a dynamic tool", async ({ page }) => {
  server = await startServer({ CHAT_FAKE_CODEX: join(FIXTURES, "codex/app-tool") });
  await page.goto(server.url);
  await start(page, LOOKUP, "Codex");
  await expect(page.getByTestId("order-card")).toContainText("Shipped");
  await expect(page.getByText("Order 42 contains 3 blue widgets and shipped on October 30, 2026.")).toBeVisible();
});

test("the client reconnects when the server restarts, and the thread carries on", async ({ page }) => {
  const env = { CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/resume"), CHAT_FAKE_STATE: mkdtempSync(join(tmpdir(), "chat-e2e-fake-")) };
  server = await startServer(env);
  const { PORT, CHAT_DATA } = server.env;
  await page.goto(server.url);
  await start(page, "Remember the word pineapple. Reply with just: ok");
  await expect(page.getByText("ok", { exact: true })).toBeVisible();

  await server.stop();
  await expect(connection(page)).toHaveText("Reconnecting…");
  server = await startServer({ ...env, CHAT_DATA: CHAT_DATA! }, { port: Number(PORT) });
  await expect(connection(page)).toHaveText("Connected");

  // A new process, resuming Claude's session.
  await page.getByLabel("Message the agent").fill("What word did I ask you to remember? Reply with just the word.");
  await page.getByLabel("Message the agent").press("Enter");
  await expect(page.getByText("pineapple", { exact: true })).toBeVisible();
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
});

test("with the shim, a turn waiting on the user outlives a server restart", async ({ page }) => {
  test.skip(!existsSync(SHIM), "agent-threads-shim isn't built (make shim)");
  server = await startServer(
    { CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/permission-allow"), CHAT_SHIM: SHIM, CHAT_FAKE_STATE: mkdtempSync(join(tmpdir(), "chat-e2e-fake-")) },
    { supervised: true },
  );
  await page.goto(server.url);
  await start(page, "Run this shell command with the Bash tool: touch allowed.txt — then reply with just: created");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Restart server" }).click();
  await server.listening();
  await expect(connection(page)).toHaveText("Connected");
  await expect(page.getByText("picked it up again")).toBeVisible();

  // The same request, still open: answering it carries on the same run.
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText("created", { exact: true })).toBeVisible();
});

test("a supervised server and its run with a request open are stopped after a test fails", async ({ page }) => {
  test.skip(!existsSync(SHIM), "agent-threads-shim isn't built (make shim)");
  // What's tested is the teardown that follows (afterEach's).
  test.fail();
  server = await startServer(
    { CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/permission-allow"), CHAT_SHIM: SHIM, CHAT_FAKE_STATE: mkdtempSync(join(tmpdir(), "chat-e2e-fake-")) },
    { supervised: true },
  );
  await page.goto(server.url);
  await start(page, "Run this shell command with the Bash tool: touch allowed.txt — then reply with just: created");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  // So that afterEach's check that none of it is left is worth something.
  const running = await server.remains();
  expect(running).toHaveLength(3);
  expect(running.at(-1)).toMatch(/^its run /);
  throw new Error(`${ON_PURPOSE}, with the request open`);
});

for (const source of ["proc", "ps"] as const) {
  test(`a run is stopped with whatever its program started, though that outlives the program (${source})`, async () => {
    test.skip(!existsSync(SHIM), "agent-threads-shim isn't built (make shim)");
    const data = mkdtempSync(join(tmpdir(), "chat-e2e-"));
    const dir = join(data, "runs", "run_left");
    mkdirSync(dir, { recursive: true });
    const ready = join(data, "ready");
    // The program starts one that ignores SIGTERM (and says its pid once it does), and goes itself
    // on SIGTERM.
    const child = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const program = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    // As a backend runs it: with its stdio at /dev/null (the shim keeps it, so a pipe would never close).
    expect(spawnSync(SHIM, [dir, "--", process.execPath, "-e", program], { stdio: "ignore" }).status).toBe(0);
    let started: number | undefined;
    try {
      await expect.poll(() => existsSync(ready)).toBe(true);
      started = Number(readFileSync(ready, "utf8"));
      expect(runs(data, source)[0]!.left()).toContain(started);

      expect(await stopRuns(data, source)).toEqual([]);
      // The program went on SIGTERM, and the shim with it, saying so; what it started had SIGKILL.
      expect(existsSync(join(dir, "exit"))).toBe(true);
      expect(runs(data, source)[0]!.left()).toEqual([]);
      // Told apart from left(): gone, once it's reaped.
      await expect.poll(() => exists(started!), { timeout: 2_000 }).toBe(false);
    } finally {
      if (started !== undefined && exists(started)) process.kill(started, "SIGKILL");
    }
  });

  test(`a run's pids that have since gone to other processes aren't taken for its (${source})`, async () => {
    const data = mkdtempSync(join(tmpdir(), "chat-e2e-"));
    const dir = join(data, "runs", "run_stale");
    mkdirSync(dir, { recursive: true });
    // Another process, in a session and group of its own (as a shim's and a program's are), which
    // the pids of a run that's long over may since have been given to; and a pid that's gone.
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const gone = spawnSync("true").pid;
    try {
      await expect.poll(() => exists(other.pid!)).toBe(true);
      // Written a minute ago (since the machine started), before it started.
      const ago = new Date(Date.now() - 60_000);
      const write = (name: string, content: string) => {
        writeFileSync(join(dir, name), content);
        utimesSync(join(dir, name), ago, ago);
      };
      write("exit", '{"code":0,"signal":null}');
      for (const [shim, program] of [
        [gone, other.pid!],
        [other.pid!, gone],
        [other.pid!, other.pid!],
      ]) {
        write("shim.pid", String(shim));
        write("pid", String(program));
        expect(runs(data, source)[0]!.left()).toEqual([]);
        expect(await stopRuns(data, source)).toEqual([]);
      }
      // Written just now, as it started: only its session tells it from the run's program.
      writeFileSync(join(dir, "shim.pid"), String(gone));
      writeFileSync(join(dir, "pid"), String(other.pid));
      expect(runs(data, source)[0]!.left()).toEqual([]);
      expect(await stopRuns(data, source)).toEqual([]);
      // Nothing was sent to it: it would have gone on SIGTERM.
      expect(exists(other.pid!)).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
  });

  test(`a run whose pids have since gone to another run's shim and program takes nothing of that run's (${source})`, async () => {
    test.skip(!existsSync(SHIM), "agent-threads-shim isn't built (make shim)");
    // Another run, in another data directory: its program starts one more process, in its group.
    const elsewhere = mkdtempSync(join(tmpdir(), "chat-e2e-"));
    const otherDir = join(elsewhere, "runs", "run_other");
    mkdirSync(otherDir, { recursive: true });
    const ready = join(elsewhere, "ready");
    const child = `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const program = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    expect(spawnSync(SHIM, [otherDir, "--", process.execPath, "-e", program], { stdio: "ignore" }).status).toBe(0);
    const pids: number[] = [];
    try {
      await expect.poll(() => existsSync(ready)).toBe(true);
      const other = runs(elsewhere, source)[0]!;
      pids.push(other.shim()!, other.program()!, Number(readFileSync(ready, "utf8")));
      const [shim, prog, started] = pids as [number, number, number];
      expect(other.left()).toEqual(expect.arrayContaining(pids));

      const data = mkdtempSync(join(tmpdir(), "chat-e2e-"));
      const dir = join(data, "runs", "run_stale");
      mkdirSync(dir, { recursive: true });
      const write = (name: string, content: string, at: Date) => {
        writeFileSync(join(dir, name), content);
        utimesSync(join(dir, name), at, at);
      };
      // Written a minute ago, before the other run's shim and program started: neither is the
      // run's, nor is what's in their session and group.
      const ago = new Date(Date.now() - 60_000);
      write("exit", '{"code":0,"signal":null}', ago);
      for (const [s, p] of [
        [shim, prog],
        [shim, spawnSync("true").pid!],
      ]) {
        write("shim.pid", String(s), ago);
        write("pid", String(p), ago);
        expect(runs(data, source)[0]!.left()).toEqual([]);
        expect(await stopRuns(data, source)).toEqual([]);
      }
      // Its shim's written as the other's was: only the program's start tells its group isn't the run's.
      write("shim.pid", String(shim), statSync(join(otherDir, "shim.pid")).mtime);
      write("pid", String(prog), ago);
      expect(runs(data, source)[0]!.left()).toEqual([shim]);
      // Nothing was sent to them: they'd have gone on SIGTERM.
      for (const pid of pids) expect(exists(pid)).toBe(true);

      // While the other run is still stopped with what its program started.
      expect(await stopRuns(elsewhere, source)).toEqual([]);
      expect(other.left()).toEqual([]);
      await expect.poll(() => exists(started), { timeout: 2_000 }).toBe(false);
    } finally {
      for (const pid of pids) if (exists(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test(`a run whose pids have since gone to leaders that have exited but aren't reaped takes nothing of their session's or group's (${source})`, async () => {
    test.skip(spawnSync("python3", ["-c", ""]).status !== 0, "there's no python3");
    for (const zombie of ["session", "group"] as const) {
      const data = mkdtempSync(join(tmpdir(), "chat-e2e-"));
      const dir = join(data, "runs", "run_stale");
      mkdirSync(dir, { recursive: true });
      const out = join(data, "leaders.json");
      // A session, written to shim.pid as a shim does, with a group of its own whose leader exits and
      // leaves one it started. Either the session's leader exits too, or it waits on the group's
      // without reaping it; and its parent doesn't reap it.
      const leaders = spawn("python3", ["-c", LEADERS, zombie, join(dir, "shim.pid"), out], { stdio: "ignore" });
      let them: { session: number; group: number; left: number } | undefined;
      try {
        await expect.poll(() => (them = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined)).toBeTruthy();
        const { session, group, left } = them!;
        const ago = new Date(Date.now() - 60_000);
        const write = (name: string, content: string) => {
          writeFileSync(join(dir, name), content);
          utimesSync(join(dir, name), ago, ago);
        };
        write("exit", '{"code":0,"signal":null}');
        write("pid", String(group));
        if (zombie === "session") {
          // Written a minute ago, before the session started: nothing in it is the run's.
          utimesSync(join(dir, "shim.pid"), ago, ago);
          expect(runs(data, source)[0]!.left()).toEqual([]);
          expect(await stopRuns(data, source)).toEqual([]);
        } else {
          // Its shim's the session's leader, but the group's leader started after `pid` was written.
          expect(runs(data, source)[0]!.left()).toEqual([session]);
        }
        // Nothing was sent to it: it would have gone on SIGTERM.
        expect(exists(left)).toBe(true);
      } finally {
        for (const pid of [them?.left, them?.session]) if (pid !== undefined && exists(pid)) process.kill(pid, "SIGKILL");
        leaders.kill("SIGKILL");
      }
    }
  });
}

/**
 * Forks a session leader (which writes its pid to argv[2]), which forks a group's leader, which
 * forks one more and exits. With argv[1] "session" the session's leader reaps the group's and exits,
 * and with "group" it waits for it without reaping it. Once that's so, says their pids in argv[3]
 * (as JSON), and waits, reaping nothing.
 */
const LEADERS = `
import json, os, sys, time
zombie, shim_pid, out = sys.argv[1:4]
r, w = os.pipe()
def say(what, pid):
    os.write(w, ("%s %d\\n" % (what, pid)).encode())
session = os.fork()
if session == 0:
    os.setsid()
    with open(shim_pid, "w") as f:
        f.write(str(os.getpid()))
    group = os.fork()
    if group == 0:
        os.setpgid(0, 0)
        if os.fork() == 0:
            say("left", os.getpid())
            while True:
                time.sleep(1)
        os._exit(0)
    if zombie == "session":
        os.waitpid(group, 0)
        say("group", group)
        os._exit(0)
    os.waitid(os.P_PID, group, os.WEXITED | os.WNOWAIT)
    say("group", group)
    while True:
        time.sleep(1)
os.close(w)
told = os.fdopen(r)
them = dict(told.readline().split() for _ in range(2))
if zombie == "session":
    os.waitid(os.P_PID, session, os.WEXITED | os.WNOWAIT)
with open(out + ".new", "w") as f:
    json.dump({"session": session, "group": int(them["group"]), "left": int(them["left"])}, f)
os.rename(out + ".new", out)
while True:
    time.sleep(1)
`;

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the server takes WebSockets only from its own pages, and survives malformed input", async () => {
  server = await startServer({ CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/plain-reply") });
  const { port } = new URL(server.url);
  const ws = `ws://127.0.0.1:${port}/ws`;
  /** Whether a socket opened with these headers is taken, and if it is, the socket. */
  const connect = (options: WebSocket.ClientOptions) =>
    new Promise<WebSocket | null>((resolve) => {
      const s = new WebSocket(ws, options);
      s.on("open", () => resolve(s));
      s.on("error", () => resolve(null));
    });

  // Another site's page, or one reached through a rebound DNS name, is refused.
  expect(await connect({ origin: "https://attacker.example" })).toBeNull();
  expect(await connect({ origin: "http://127.0.0.1:1" })).toBeNull();
  expect(await connect({ headers: { host: `attacker.example:${port}` }, origin: `http://attacker.example:${port}` })).toBeNull();
  // Vite's dev server's port is only the app's under pnpm dev.
  expect(await connect({ headers: { host: "localhost:5173" }, origin: "http://localhost:5173" })).toBeNull();
  // The app's own page, and a client that isn't a browser, are taken.
  (await connect({ origin: `http://127.0.0.1:${port}` }))!.close();
  const client = (await connect({}))!;

  // Frames that aren't requests, and a URL that doesn't decode, don't take the server down.
  for (const frame of ["null", "42", '"x"', "[]", '{"id":1}', '{"id":1,"method":"list","params":7}', '{"id":2,"method":"toString"}']) client.send(frame);
  expect((await fetch(`${server.url}/%E0`)).status).toBe(400);
  const reply = await new Promise((resolve) => {
    client.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id === 9) resolve(msg);
    });
    client.send(JSON.stringify({ id: 9, method: "list" }));
  });
  expect(reply).toEqual({ id: 9, result: [] });

  // Nor do frames the socket itself can't take: text that isn't UTF-8, and one too big. They end
  // that socket only.
  for (const send of [(s: WebSocket) => s.send(Buffer.from([0xff]), { binary: false }), (s: WebSocket) => s.send("x".repeat(17 * 1024 * 1024))]) {
    const bad = (await connect({}))!;
    const closed = new Promise((r) => bad.on("close", r));
    send(bad);
    await closed;
  }
  expect((await fetch(server.url)).status).toBe(200);
  const again = (await connect({}))!;
  const listed = await new Promise((resolve) => {
    again.on("message", (data) => resolve(JSON.parse(String(data))));
    again.send(JSON.stringify({ id: 1, method: "list" }));
  });
  expect(listed).toEqual({ id: 1, result: [] });
  again.close();
  client.close();
});

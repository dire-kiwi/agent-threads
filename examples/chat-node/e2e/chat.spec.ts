// Smoke tests of the whole app, server and frontend, with the fake CLI replaying recorded sessions
// (spec/fixtures) in place of claude and codex: it checks that what the backend sends the CLI is
// what the recording has, so these need no login and cost nothing.

import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
}

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

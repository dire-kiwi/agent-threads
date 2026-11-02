// Smoke tests of the whole app, server and frontend, with the fake CLI replaying recorded sessions
// (spec/fixtures) in place of claude and codex: it checks that what the backend sends the CLI is
// what the recording has, so these need no login and cost nothing.

import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, SHIM, startServer, type Server } from "./server.ts";

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
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
  // The answered request stays where it was asked, with its answer, after a reload too.
  for (const again of [false, true]) {
    if (again) await page.reload();
    const card = page.getByRole("group", { name: /Permission for/ });
    await expect(card).toContainText("Allowed");
    await expect(card.getByRole("button")).toHaveCount(0);
  }
});

test("a thread opens at a window of its latest items, and loads the earlier ones", async ({ page }) => {
  server = await startServer({ CHAT_FAKE_CLAUDE: join(FIXTURES, "claude/app-tool") });
  await page.goto(server.url);
  await start(page, LOOKUP);
  await expect(page.getByTestId("order-card")).toContainText("Shipped");
  // Two items at a time: the snapshot is a window, and the pages before it come as it's at the top.
  const pages: { before: number; limit: number }[] = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      const m = JSON.parse(String(f.payload));
      if (m.method === "items_before") pages.push(m.params);
    }),
  );
  const url = new URL(page.url());
  url.searchParams.set("page", "2");
  await page.goto(url.href);
  await expect(page.getByText(LOOKUP)).toBeVisible();
  await expect(page.getByTestId("order-card")).toContainText("Shipped");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.every((p) => p.limit === 2)).toBe(true);
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

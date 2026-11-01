// Smoke tests of the whole app, server and frontend, with the fake CLI replaying recorded sessions
// (spec/fixtures) in place of claude and codex: it checks that what the backend sends the CLI is
// what the recording has, so these need no login and cost nothing.

import { expect, test, type Page } from "@playwright/test";
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

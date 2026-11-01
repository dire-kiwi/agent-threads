// The smoke tests (e2e/): each starts the server itself, replaying recorded sessions with the fake
// CLI, and drives the built frontend (pnpm build first; pnpm test:e2e does both). CHAT_E2E_BROWSER
// runs them in a browser of your own (its executable's path) instead of Playwright's Chromium.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.CHAT_E2E_BROWSER ? { launchOptions: { executablePath: process.env.CHAT_E2E_BROWSER } } : {}),
  },
});

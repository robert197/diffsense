import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for diffsense E2E. Mobile-first product, so the default
 * project emulates a phone; a desktop project is included too.
 *
 * Auth: the GitHub "Authorize" button cannot be clicked under automation
 * (GitHub gates it on a focused human click), so we reuse a saved authenticated
 * session captured once — see playwright/README.md. Point STORAGE_STATE at it.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
const STORAGE_STATE = process.env.STORAGE_STATE ?? "auth.json";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Public pages — no auth needed.
    { name: "public", testMatch: /public\.spec\.ts/, use: { ...devices["iPhone 14"] } },
    // Authed flow — requires STORAGE_STATE captured once.
    {
      name: "mobile-authed",
      testMatch: /(authed|add-repos)\.spec\.ts/,
      use: { ...devices["iPhone 14"], storageState: STORAGE_STATE },
    },
    {
      name: "desktop-authed",
      testMatch: /(authed|add-repos)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
    },
  ],
});

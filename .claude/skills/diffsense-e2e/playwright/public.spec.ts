import { expect, test } from "@playwright/test";

/**
 * Public surface — no authentication. Verifies the app is up and the unauthed
 * entry point is correct. Runs without a saved session.
 */
test.describe("diffsense public", () => {
  test("home page shows the product and a GitHub sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/diffsense/i);
    await expect(page.getByRole("link", { name: /sign in with github/i })).toBeVisible();
  });

  test("protected routes redirect unauthenticated users to login", async ({ page }) => {
    const res = await page.goto("/repos");
    // Either bounced to /login or to the GitHub OAuth authorize screen.
    await expect(page).toHaveURL(/\/login|github\.com\/login\/oauth\/authorize/);
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});

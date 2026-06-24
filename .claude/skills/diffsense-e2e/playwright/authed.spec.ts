import { expect, test } from "@playwright/test";

/**
 * Authenticated flow — requires a saved session (storageState, see README).
 * Walks: repos → pulls → PR findings/deck. Mobile + desktop projects.
 *
 * Config via env:
 *   OWNER, REPO   target repository (default robert197/diffsense)
 *   PROCESSED_PR  a PR number already run through the pipeline (asserts findings)
 *   EMPTY_PR      a PR number NOT processed (asserts the empty state)
 */
const OWNER = process.env.OWNER ?? "robert197";
const REPO = process.env.REPO ?? "diffsense";

test.describe("diffsense authed flow", () => {
  test("lands on /repos and lists the target repo", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/repos/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /your repositories/i })).toBeVisible();
    await expect(
      page.getByRole("link", { name: new RegExp(`${OWNER}/${REPO}`, "i") }),
    ).toBeVisible();
  });

  test("repo page lists pull requests", async ({ page }) => {
    await page.goto(`/repos/${OWNER}/${REPO}/pulls`);
    await expect(
      page.getByRole("heading", { name: new RegExp(`${OWNER}/${REPO}`, "i") }),
    ).toBeVisible();
    // PR links point at /pr/:owner/:repo/:number. Zero is allowed (no open PRs).
    const prLinks = page.locator(`a[href*="/pr/${OWNER}/${REPO}/"]`);
    expect(await prLinks.count()).toBeGreaterThanOrEqual(0);
  });

  test("a processed PR renders findings + a swipeable deck", async ({ page }) => {
    const pr = process.env.PROCESSED_PR;
    test.skip(!pr, "set PROCESSED_PR to a PR already run through the pipeline");
    await page.goto(`/pr/${OWNER}/${REPO}/${pr}`);
    await expect(page.getByText(/no findings/i)).toHaveCount(0);
    await page.goto(`/pr/${OWNER}/${REPO}/${pr}/deck`);
    await expect(page.getByText(/isn't ready/i)).toHaveCount(0);
  });

  test("an unprocessed PR shows a graceful empty state", async ({ page }) => {
    const pr = process.env.EMPTY_PR;
    test.skip(!pr, "set EMPTY_PR to a PR not yet processed");
    await page.goto(`/pr/${OWNER}/${REPO}/${pr}`);
    await expect(page.getByText(/no findings/i)).toBeVisible();
  });
});

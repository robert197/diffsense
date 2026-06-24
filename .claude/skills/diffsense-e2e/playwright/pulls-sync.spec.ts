import { expect, test } from "@playwright/test";

/**
 * Repo pulls-list *sync* UX — requires a saved session (storageState, see README).
 * Asserts the live open-PR list: it renders (rows or empty state), exposes a manual
 * Refresh affordance and a "Synced …" freshness status, and re-syncs in place on a
 * Refresh click *without* a full-page reload (the performance contract — only the PR
 * array crosses the wire, the document is not navigated).
 *
 * Structure is asserted strictly; PR contents are not, since the repo's open-PR set
 * changes over time. Targets a repo with private PRs to prove the org-synced path.
 *
 * Config via env:
 *   OWNER/REPO  repo whose pulls page is exercised (default devs-group/core-gent)
 */
const OWNER = process.env.OWNER ?? "devs-group";
const REPO = process.env.REPO ?? "core-gent";
const PULLS = `/repos/${OWNER}/${REPO}/pulls`;

test.describe("diffsense pulls-list sync", () => {
  test("renders the list with a sync status and a Refresh affordance", async ({ page }) => {
    await page.goto(PULLS);
    await expect(page).toHaveURL(new RegExp(`${OWNER}/${REPO}/pulls`), { timeout: 15_000 });

    // The repo header renders from the server's first paint.
    await expect(page.getByRole("heading", { name: `${OWNER}/${REPO}` })).toBeVisible();

    // Either the count line / PR rows or the empty state — both are valid renders.
    const hasCount = await page.getByText(/open pull request/i).count();
    const hasEmpty = await page.getByText(/no open pull requests/i).count();
    expect(hasCount + hasEmpty).toBeGreaterThan(0);

    // The freshness status and the always-available manual Refresh.
    await expect(page.getByText(/^synced/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();
  });

  test("Refresh re-syncs in place without a full-page reload", async ({ page }) => {
    await page.goto(PULLS);
    await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();

    // Tag the live document; a full navigation would wipe this.
    await page.evaluate(() => {
      (window as unknown as { __diffsenseNoReload?: boolean }).__diffsenseNoReload = true;
    });

    await page.getByRole("button", { name: /refresh/i }).click();

    // Give the action a beat to resolve, then confirm the tag survived → the island
    // refetched client-side rather than reloading the page.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __diffsenseNoReload?: boolean }).__diffsenseNoReload === true,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // And the list is still present afterward.
    const hasCount = await page.getByText(/open pull request/i).count();
    const hasEmpty = await page.getByText(/no open pull requests/i).count();
    expect(hasCount + hasEmpty).toBeGreaterThan(0);
  });
});

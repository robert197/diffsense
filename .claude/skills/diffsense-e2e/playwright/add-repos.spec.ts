import { expect, test } from "@playwright/test";

/**
 * Add Repositories / organisation-sync flow — requires a saved session
 * (storageState, see README). Asserts the diffsense-side modal: it opens, lists
 * installed groups and/or installable targets, exposes the manual Refresh
 * affordance, and shows the "opened on GitHub" hint when a target is clicked.
 *
 * The actual GitHub grant (install/approve) cannot be automated (SKILL.md §3), so
 * these assertions stop at the modal + routing. Structure is asserted strictly;
 * the presence of a specific org is a soft check, since whether ORG shows as an
 * installed group vs. an install/request target depends on the captured session.
 *
 * Config via env:
 *   ORG   organisation expected to be syncable (default devs-group; soft-checked)
 */
const ORG = process.env.ORG ?? "devs-group";

test.describe("diffsense add-repositories flow", () => {
  test("the Add repositories trigger is on /repos", async ({ page }) => {
    await page.goto("/repos");
    await expect(page).toHaveURL(/\/repos/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /add repositories/i })).toBeVisible();
  });

  test("opening the modal lists groups/targets and exposes Refresh", async ({ page }) => {
    await page.goto("/repos");
    await page.getByRole("button", { name: /add repositories/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /add repositories/i })).toBeVisible();

    // The lazy load resolves to either installed groups or the installable-targets
    // section (or both). Wait out the loading state, then assert structure.
    await expect(dialog.getByText(/loading your repositories/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    const hasInstalled = await dialog.getByRole("link", { name: /manage repositories/i }).count();
    const hasTargets = await dialog.getByText(/add an organisation or account/i).count();
    const hasInstallNew = await dialog.getByRole("link", { name: /install on another/i }).count();
    expect(hasInstalled + hasTargets + hasInstallNew).toBeGreaterThan(0);

    // The manual refresh affordance is always available in the loaded view.
    await expect(dialog.getByRole("button", { name: /refresh/i })).toBeVisible();

    // Soft: ORG should be syncable — either an installed group or a target.
    const orgVisible = await dialog.getByText(new RegExp(ORG, "i")).count();
    if (orgVisible === 0) {
      test.info().annotations.push({
        type: "note",
        description: `${ORG} not surfaced in this session — install it on GitHub or accept the org invite to exercise the synced state.`,
      });
    }
  });

  test("clicking an install/request target shows the opened-on-GitHub hint", async ({ page }) => {
    await page.goto("/repos");
    await page.getByRole("button", { name: /add repositories/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/loading your repositories/i)).toHaveCount(0, {
      timeout: 15_000,
    });

    const target = dialog.getByRole("link", { name: /install|request access/i }).first();
    const hasTarget = await target.count();
    test.skip(hasTarget === 0, "no installable targets in this session (every account already synced)");

    // The link opens GitHub in a new tab; don't follow it — just assert the
    // in-modal feedback so the reviewer knows to refresh on return.
    await target.click({ noWaitAfter: true });
    await expect(dialog.getByText(/on github/i).first()).toBeVisible();
  });
});

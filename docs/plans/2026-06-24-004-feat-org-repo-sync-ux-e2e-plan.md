---
title: "feat: Org repo sync — return-to-tab UX seam + agent-browser e2e on devs-group"
type: feat
date: 2026-06-24
depth: standard
status: ready
origin: none (solo invocation)
---

# feat: Org repo sync — return-to-tab UX seam + agent-browser e2e on devs-group

## Summary

The "Add Repositories" modal already lets any reviewer onboard their organisation's
repos: it lists installed accounts with their (private-included) repos, and renders
role-aware **Install** / **Request access** cards for orgs without diffsense yet
(`apps/web/components/repos/AddRepositoriesModal.tsx`, `apps/web/lib/addableRepos.ts`,
`apps/web/app/repos/actions.ts`). Shipped across #43–#46. The org-sync *logic* is
done and well-tested.

Two gaps remain against the request "great UX … sync organisation repos … verify
private repos from **devs-group** can be synced e2e":

1. **The return-to-tab seam.** Install/Request opens GitHub in a new tab. After the
   reviewer approves and returns to the diffsense tab, the open modal still shows the
   pre-install state — the newly-synced org and its private repos only appear if they
   manually close and reopen the modal. This is the one rough edge in an otherwise
   clean flow.
2. **No e2e coverage of this flow.** The existing `diffsense-e2e` driver
   (`arc-drive.sh`) walks home → login → repos → pulls → deck, but never opens the
   Add Repositories modal or asserts org-repo sync. Nothing verifies that
   devs-group's private repos become reachable.

This plan closes the seam (auto-refresh on tab refocus + an explicit manual refresh
affordance + lightweight "opened on GitHub" feedback) and adds agent-browser (Arc/CDP)
and Playwright e2e coverage that asserts the devs-group sync path.

---

## Problem Frame

A reviewer on a team shipping AI code wants their org's repos (including private ones
like `devs-group/*`) reviewable in diffsense. "Syncing" an org = installing the GitHub
App on it; only GitHub can grant that, so the modal is a browse-and-route surface. The
domain logic for this is complete. What's missing is (a) the small UX discontinuity
when the reviewer comes back from GitHub's install screen, and (b) any automated proof
that the whole path works end to end against a real org with private repos.

**In scope:** the modal's return-to-tab refresh behavior, manual refresh, per-target
"opened" feedback; agent-browser + Playwright e2e for the Add Repositories / org-sync
flow against devs-group.

**Out of scope:** changing how installs are granted (GitHub owns that), persisting
installations/repos to Postgres (they stay ephemeral per existing design), the
role-aware install/request computation (already correct in `addableRepos.ts`), and the
deck/findings pipeline (covered by existing e2e).

---

## Requirements

- **R1.** When the Add Repositories modal is open and the diffsense browser tab regains
  focus (reviewer returns from GitHub's install/approve screen), the modal refreshes its
  data so a just-synced org and its private repos appear without a manual close/reopen.
- **R2.** The modal exposes an explicit, always-available **Refresh** affordance for the
  case where focus events don't fire (e.g. install completed in a window the reviewer
  never left) — so the reviewer is never stuck looking at stale state.
- **R3.** Clicking **Install** / **Request access** gives immediate in-modal feedback
  that the action opened on GitHub and the list will refresh on return — no silent
  new-tab jump.
- **R4.** Auto-refresh must not fight the existing concurrency guards: no duplicate
  in-flight loads, no stale write onto a closed modal, no refresh storm on rapid focus
  toggles.
- **R5.** An agent-browser (Arc/CDP) e2e driver exercises the Add Repositories flow and
  asserts org-repo sync against **devs-group** — its presence as an installed group
  (with private repos visible) or as a role-appropriate installable target.
- **R6.** A Playwright spec asserts the same modal flow headlessly for CI-style repeat
  runs (modal opens, lists installed groups, renders install/request targets).

---

## Key Technical Decisions

- **Refresh trigger: `visibilitychange` (+ `focus` fallback), gated on modal-open.**
  When the reviewer approves on GitHub and switches back, the diffsense tab fires
  `document.visibilitychange` → `visibilityState === "visible"`. Listen only while the
  dialog is open; tear down on close. `focus` is a secondary trigger for same-window
  cases. Rationale: this is the exact moment fresh installation data exists; it needs no
  polling and no server round-trip until the reviewer is actually looking.
- **Reuse the existing `load()` + `genRef`/`loadingRef` guards (R4).** The component
  already drops concurrent loads (`loadingRef`) and invalidates stale results across a
  generation counter (`genRef`). The refocus handler calls the same `load()`; the guards
  already make it safe. Add a short debounce/"only if not already loading" check rather
  than new machinery.
- **Don't auto-refresh while loading or on error-retry churn.** If a load is in flight,
  the refocus is a no-op (guard already handles it). After an error, the existing "Try
  again" path stays the manual recovery.
- **Per-target feedback is local UI state, not a server call (R3).** Clicking a target
  marks it "Opened on GitHub" inline; the actual state change comes from the refresh on
  return. No new server action.
- **e2e stays in the `diffsense-e2e` skill, not the app test suite.** Browser e2e needs
  the isolated Docker stack + manual one-time GitHub App authorization documented in
  `SKILL.md`. New driver script sits beside `arc-drive.sh`; new Playwright spec beside
  `authed.spec.ts`. Keeps unit/integration (`vitest`) fast and hermetic.
- **devs-group assertion is role-agnostic.** The test cannot assume whether `robert197`
  is admin or member of devs-group. It asserts devs-group appears *either* as an
  installed group with ≥1 private repo *or* as an installable target with the correct
  Install/Request label — both are valid "can be synced" outcomes.

---

## Implementation Units

### U1. Auto-refresh the modal when the tab regains focus

**Goal:** Close the return-to-tab seam (R1, R4) — a synced org and its private repos
appear when the reviewer comes back from GitHub, no manual reopen.

**Requirements:** R1, R4.

**Dependencies:** none.

**Files:**
- `apps/web/components/repos/AddRepositoriesModal.tsx` (modify)
- `apps/web/components/repos/AddRepositoriesModal.test.tsx` (modify)

**Approach:** In `AddRepositoriesModal`, add an effect that — only while `open` is true —
subscribes to `document` `visibilitychange` and `window` `focus`. On a
`visibilityState === "visible"` / focus event, call the existing `load()` (already
guarded by `loadingRef`/`genRef`, so a no-op when a load is mid-flight). Remove listeners
on close and on unmount. Keep the existing `onOpenChange` reset semantics untouched —
the refocus handler is additive. Guard against firing while `state.status === "loading"`
to avoid redundant churn.

**Patterns to follow:** existing `load`/`onOpenChange` concurrency handling in the same
file (`loadingRef`, `genRef` generation counter, lines ~46–96). Mirror its comment
density.

**Test scenarios:**
- Modal open + tab fires `visibilitychange` to visible → `loadAddableRepos` called again
  (data refetched). Assert call count increments from the initial open.
- Modal open + an in-flight load + focus event → no duplicate `loadAddableRepos` call
  (loadingRef guard). 
- Modal closed + visibilitychange/focus → `loadAddableRepos` NOT called (listener torn
  down).
- Listeners removed on unmount (no refetch after unmount). Covers R4.
- Refocus after a completed load swaps stale groups for fresh ones (mock returns a new
  installed group on the second call; assert it renders).

**Verification:** With the modal open, switching away and back triggers a fresh
`loadAddableRepos`; component tests for the four scenarios pass; no duplicate-load or
stale-write regressions in existing tests.

---

### U2. Manual Refresh affordance + per-target "opened on GitHub" feedback

**Goal:** Give a reliable manual refresh (R2) for when focus events don't fire, and make
the Install/Request click visibly lead somewhere (R3).

**Requirements:** R2, R3.

**Dependencies:** U1 (shares the `load()` entry point and loaded state).

**Files:**
- `apps/web/components/repos/AddRepositoriesModal.tsx` (modify)
- `apps/web/components/repos/AddRepositoriesModal.test.tsx` (modify)

**Approach:** Add a small **Refresh** button in the loaded-state header (next to the
filter or the "Add an organisation or account" section) that calls `load()`; show the
existing spinner while reloading. In `InstallableTargets`, when a target's Install/Request
link is clicked, set local state marking that account as "opened" and render an inline
hint ("Opened on GitHub — Refresh when you're done") near the button or the section
footer. Local component state only; cleared on close (reuse the `onOpenChange` reset). Do
not block the link's default new-tab navigation.

**Patterns to follow:** the existing "Try again" button styling and the
`text-primary hover:underline` affordances already in `Body`/`InstallableTargets`.

**Test scenarios:**
- Loaded state renders a Refresh control; clicking it calls `loadAddableRepos` again.
- Refresh while loading is a no-op (loadingRef guard).
- Clicking an Install target renders the "Opened on GitHub" hint for that account and not
  for others.
- Clicking Request access on a member-org target shows the same opened hint with
  request-appropriate copy.
- Closing and reopening the modal clears the opened-state hints (reset semantics).

**Verification:** Reviewer can always force a refresh; clicking a target shows immediate
feedback; tests for the scenarios pass.

---

### U3. agent-browser (Arc/CDP) e2e driver for the Add Repositories / org-sync flow

**Goal:** Prove the org-repo sync flow end to end against a real org with private repos —
**devs-group** — using agent-browser attached to logged-in Arc (R5).

**Requirements:** R5.

**Dependencies:** U1, U2 (asserts the refresh affordance exists), but the script also
passes against the pre-U1/U2 modal for the core sync assertions.

**Files:**
- `.claude/skills/diffsense-e2e/scripts/arc-drive-add-repos.sh` (create)
- `.claude/skills/diffsense-e2e/SKILL.md` (modify — add a "§4c Add Repositories / org
  sync" subsection documenting the driver and the devs-group expectation)

**Approach:** New bash driver mirroring `arc-drive.sh`'s structure (CDP attach, `ab()`
helper, `pass`/`fail`). Steps: attach to Arc on `CDP_PORT`; open `/repos`; assert the
"Add repositories" button is present; click it (or open the modal) and snapshot; assert
the modal lists at least one installed account group; assert **devs-group** appears
*either* as an installed group with a private repo row *or* as an installable target
labeled Install/Request; assert the Refresh affordance is present (U2). Read page **text**
(`ab get text`) for the section copy, not just `snapshot -i`, per the empty-state gotcha
already documented. Parameterize `ORG` (default `devs-group`) and `OWNER` so the assertion
is configurable. Exit non-zero on hard failures; emit notes (not failures) when devs-group
isn't installed yet (so the run guides the operator to install rather than red-failing on
an environment gap).

**Patterns to follow:** `.claude/skills/diffsense-e2e/scripts/arc-drive.sh` verbatim for
CDP attach, color helpers, snapshot-vs-text discipline, and the SKILL.md §4a style.

**Test scenarios:** `Test expectation: none — this is an e2e driver script, not a unit.`
Manual verification path documented in SKILL.md: run `up.sh`, authorize once, then
`arc-drive-add-repos.sh` and confirm PASS lines for the modal + devs-group sync assertion.

**Verification:** Running the driver against the isolated stack with Arc logged in prints
PASS for: Add repositories button present, modal lists installed groups, devs-group is
syncable (installed-with-private-repo OR install/request target), Refresh affordance
present.

---

### U4. Playwright spec for the Add Repositories modal flow

**Goal:** CI-repeatable headless assertion of the modal flow using the saved
authenticated session (R6).

**Requirements:** R6.

**Dependencies:** U1, U2.

**Files:**
- `.claude/skills/diffsense-e2e/playwright/add-repos.spec.ts` (create)
- `.claude/skills/diffsense-e2e/playwright/README.md` (modify — note the new spec)

**Approach:** New spec reusing the `storageState` auth pattern from `authed.spec.ts`.
Navigate to `/repos`; click "Add repositories"; wait for the dialog; assert the dialog
title renders; assert at least one installed-account group OR the "Add an organisation or
account" section is present (environment-tolerant); assert the Refresh control is visible;
assert clicking an installable target shows the "Opened on GitHub" hint (U2) without
asserting the external navigation. Keep assertions resilient to whether devs-group is
installed in the captured session — assert the *structure* of the modal, with a soft check
for devs-group by name.

**Patterns to follow:** `.claude/skills/diffsense-e2e/playwright/authed.spec.ts` (auth via
storageState, `expect(page.locator(...))` assertions) and `playwright.config.ts`.

**Test scenarios:** the spec *is* the test. Cases inside it:
- Authed session opens `/repos` and the "Add repositories" trigger is visible.
- Clicking it opens a dialog titled "Add repositories".
- The dialog shows at least one account group or the install/request section.
- The Refresh control is visible.
- Clicking an install/request target reveals the opened-on-GitHub hint.

**Verification:** `npx playwright test -c .../playwright.config.ts add-repos.spec.ts`
passes against the isolated stack with a captured auth session.

---

## System-Wide Impact

- Touches only `apps/web/components/repos/AddRepositoriesModal.tsx` for app code — no
  server actions, schema, or `packages/core` changes. The `"use server"`
  `loadAddableRepos` action is unchanged (the refresh just calls it again).
- e2e additions are confined to the `diffsense-e2e` skill directory; they don't run in the
  default `vitest` suite and don't gate app CI.
- No new dependencies. `visibilitychange`/`focus` are platform APIs; agent-browser and
  Playwright are already part of the e2e skill.

---

## Risks & Mitigations

- **Refresh storm on rapid focus toggles** → mitigated by the existing `loadingRef` guard
  plus a "skip if already loading" check (U1). Add a test asserting no duplicate call
  during an in-flight load.
- **`visibilitychange` not firing in some browsers/automation** → the manual Refresh
  affordance (U2, R2) is the guaranteed fallback; the e2e asserts it exists.
- **devs-group role unknown in the test environment** → assertion is role-agnostic
  (installed-with-private-repo OR install/request target), so the test passes whether
  robert197 is admin or member, and degrades to an informative note if devs-group isn't
  reachable yet rather than a hard fail (U3).
- **e2e can't automate GitHub's Authorize button** (documented gotcha) → tests assume the
  one-time manual authorization from `SKILL.md §3`; no attempt to automate it.

---

## Test Strategy

- **Unit/component (vitest, hermetic):** U1 and U2 add cases to
  `AddRepositoriesModal.test.tsx` covering refocus refetch, in-flight guard, listener
  teardown, manual refresh, and per-target opened feedback. These run in normal CI.
- **e2e (manual / skill-driven):** U3 (agent-browser/Arc) and U4 (Playwright) live in the
  `diffsense-e2e` skill, run against the isolated Docker stack per `SKILL.md`, and assert
  the devs-group org-sync path. Not part of default CI; invoked via the skill.
- Run `pnpm --filter @diffsense/web test` (or repo test script) after U1/U2; verify
  existing modal/action/addableRepos tests still pass (no regression to concurrency
  guards).

---

## Deferred to Follow-Up Work

- Persisting installations/repos to Postgres for an installation webhook → live UI update
  (would remove even the refresh-on-return step). Out of scope; current design is
  ephemeral-by-request.
- A real-time installation webhook listener that pushes "org synced" to an open modal.
- Wiring U4 into an actual CI workflow (today CI is gitignored locally per project memory).

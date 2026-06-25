---
title: "feat: Pulls-list sync — return-to-tab refresh, manual sync & changed-PR feedback on the repo pulls page"
type: feat
date: 2026-06-24
depth: standard
status: ready
origin: none (solo invocation)
---

# feat: Pulls-list sync — return-to-tab refresh, manual sync & changed-PR feedback on the repo pulls page

## Summary

The repo pulls page (`apps/web/app/repos/[owner]/[repo]/pulls/page.tsx`,
`http://localhost:3001/repos/devs-group/core-gent/pulls`) is a `force-dynamic`
server component that fetches open PRs **once per navigation** via
`session.github.listOpenPullRequests`. There is no client interactivity: when a
reviewer comes back to the tab after opening a PR, merging, or pushing a commit,
the list is stale until they hard-reload the page, and a full reload re-runs the
whole server render (auth + GitHub round-trip + full HTML) — slow and heavy for
"did anything change?".

This branch already shipped the proven sync seam for the **Add Repositories**
modal (`AddRepositoriesModal.tsx`): return-to-tab refresh on
`visibilitychange`/`focus`, an always-available manual **Refresh**, and
`loadingRef`/`genRef` concurrency guards. This plan brings that same
developer-loved UX to the **pulls list**, but performant: a client island
revalidates the PR list through a lightweight server action instead of a full
page reload, shows a "last synced / syncing…" status, and visibly flags PRs that
appeared or changed since the last sync.

The result: a reviewer leaves the pulls page open, works in GitHub, returns, and
the list is already current — new PRs in, merged/closed PRs gone, updated PRs
flagged — with a clear, professional sync affordance and no jarring full-page
flash.

---

## Problem Frame

A reviewer triaging a repo's open PRs keeps the pulls page open while they bounce
to GitHub and back. Today the page only reflects reality at navigation time:
`export const dynamic = "force-dynamic"` means every visit refetches, but nothing
refetches *without* a navigation, and a manual reload is a full server round-trip
that throws away and rebuilds the entire page. There is no signal of how fresh the
list is, no way to nudge a refresh, and no indication of what changed.

"Syncing PR changes" here = keeping the rendered open-PR list converged with
GitHub's current open-PR set (new PRs appear, merged/closed disappear, updated
PRs reflect new `updatedAt`/title/draft state) **cheaply and visibly**, the moment
the reviewer is looking.

**In scope:** a client-revalidating pulls list (first paint server-rendered,
refresh-on-refocus + manual refresh + guards), a sync-status affordance
(last-synced relative time + syncing indicator), changed/new-PR visual feedback,
a `"use server"` action to refetch the list without a full navigation, reauth
handling on token expiry, and agent-browser + Playwright e2e against
`devs-group/core-gent`.

**Out of scope:** real-time push (webhooks/SSE) of PR changes, persisting PRs to
Postgres, the per-PR review/deck pipeline (`/pr/...` is unchanged), background
merge-status sync (already shipped, #31), pagination/filtering of the PR list, and
closed/merged PR history (the page stays open-PR-only).

---

## Requirements

- **R1.** When the pulls page is open and the browser tab regains focus (reviewer
  returns from GitHub), the PR list refreshes so newly-opened PRs appear,
  merged/closed PRs disappear, and updated PRs reflect their new state — without a
  manual full-page reload.
- **R2.** The page exposes an always-available **Refresh** affordance for when
  focus events don't fire, so the reviewer is never stuck on stale data.
- **R3.** The page shows lightweight sync status: a relative "last synced" time and
  a syncing indicator while a refresh is in flight — so freshness is legible at a
  glance and the refresh never feels like a silent or jarring reload.
- **R4.** Sync is performant: a refresh refetches **only the PR list** through a
  server action (no full-page navigation/re-render), is guarded against duplicate
  in-flight loads and stale writes, and throttles refocus refetches so rapid tab
  toggles don't storm GitHub.
- **R5.** PRs that are new or changed since the previous synced view are visually
  flagged (a subtle accent / "new" or "updated" marker) so the reviewer sees *what*
  changed, not just *that* it changed. The flag clears on the next sync.
- **R6.** A token expiry during a client refresh (GitHub 401) routes the reviewer to
  re-auth (`/login`) rather than failing silently or showing a broken list, matching
  the server page's existing `GitHubAuthError` handling.
- **R7.** Agent-browser (Arc/CDP) and Playwright e2e exercise the pulls-sync flow
  against `devs-group/core-gent`: list renders, Refresh affordance present, sync
  status visible, refocus triggers a refetch.

---

## Key Technical Decisions

- **Client island over the server list; server still does first paint.** Keep
  `page.tsx` as the server component that authenticates, does the initial
  `listOpenPullRequests`, and handles the initial-load `GitHubAuthError` redirect —
  then hand the result to a new `PullsList` client component as `initialPulls`.
  First paint stays server-rendered (fast, SEO-irrelevant but no loading flash);
  all subsequent syncs are client-driven. Rationale: preserves the current
  first-load behavior and auth guard while adding the live seam exactly where the
  Add Repositories modal added it.
- **Refetch via a `"use server"` action, not `router.refresh()`.** A new
  `loadOpenPullRequests(owner, repo)` action re-checks the session itself (an action
  is an independently-invokable endpoint — same discipline as `loadAddableRepos`)
  and returns just the PR array or `{ error: "reauth" }`. This is the performance
  win over the `force-dynamic` reload: only the list crosses the wire, not the whole
  page. `router.refresh()` would re-run the entire server render and remount the
  tree — heavier and it flashes.
- **Mirror the modal's `visibilitychange`(+`focus`) + `loadingRef`/`genRef`
  guards (R1, R4).** Reuse the exact, already-reviewed concurrency pattern from
  `AddRepositoriesModal.tsx` (post-close/unmount race already hardened in commit
  8359223): listen only while mounted, drop concurrent loads via `loadingRef`,
  invalidate stale results via a `genRef` generation counter. Don't invent new
  machinery.
- **Throttle refocus refetches with a min-interval (R4).** Add a small "skip if
  synced within the last N seconds" guard (e.g. 10s) on the *refocus* trigger only,
  so flipping between tabs repeatedly doesn't hammer `listOpenPullRequests`
  (`MAX_PAGES` × `per_page` GitHub calls each time). The manual **Refresh** button
  bypasses the throttle — an explicit click always syncs.
- **Change detection is client-side by `(number, updatedAt)` (R5).** Diff the
  incoming list against the previously-rendered one: a number not seen before =
  "new"; a number whose `updatedAt` advanced = "updated". Keep the set of changed
  numbers in state; clear it on the *next* successful sync. No server support
  needed — `updatedAt` is already on `PullRequest`. PRs that vanished (merged/closed)
  simply aren't in the new list, so they drop out naturally.
- **`relativeTime` for "last synced", reusing `lib/ui.ts`.** The existing helper
  already renders relative timestamps for PR rows; reuse it for the sync status so
  the formatting is consistent. Store the last-synced epoch in state; re-render is
  driven by sync events (no always-on ticking timer required for v1).
- **e2e lives in the `diffsense-e2e` skill, beside the org-sync drivers.** Same
  rationale as the org-sync plan: browser e2e needs the isolated Docker stack +
  one-time GitHub App auth from `SKILL.md`. New driver beside `arc-drive.sh`; new
  Playwright spec beside `add-repos.spec.ts`. Targets `devs-group/core-gent`.

---

## High-Level Technical Design

Data + control flow for one pulls-page session:

```
page.tsx (server)                         PullsList (client island)
  requireSession()                          props: { owner, repo, initialPulls }
  listOpenPullRequests() ──initialPulls──►  state: pulls, changed:Set<number>,
  (401 → /login redirect)                          lastSynced, status
                                            ┌───────────────────────────────┐
                                            │ sync():                        │
  visibilitychange / focus  ───────────────►│  loadingRef guard → skip if    │
  (throttled ≥ MIN_INTERVAL on refocus)     │    in-flight                   │
  manual Refresh click (bypass throttle) ──►│  gen = ++genRef                │
                                            │  loadOpenPullRequests(owner,repo)
                                            │   ├─ {error:"reauth"} → /login │
                                            │   └─ pulls[] → if gen current: │
                                            │       diff vs current →        │
                                            │       set changed, pulls,      │
                                            │       lastSynced=now           │
                                            └───────────────────────────────┘
  render: PullRow[] (changed → accent/marker) + SyncStatus(lastSynced, status)
```

`loadOpenPullRequests` is a thin server action: re-check session → call the same
`session.github.listOpenPullRequests` → map `GitHubAuthError` to
`{ error: "reauth" }`, rethrow others. Directional only; not a signature spec.

---

## Implementation Units

### U1. `loadOpenPullRequests` server action

**Goal:** Provide a lightweight, independently-invokable endpoint that refetches one
repo's open PRs without a full-page navigation (R4) and signals reauth on 401 (R6).

**Requirements:** R4, R6.

**Dependencies:** none.

**Files:**
- `apps/web/app/repos/[owner]/[repo]/pulls/actions.ts` (create)
- `apps/web/app/repos/[owner]/[repo]/pulls/actions.test.ts` (create)

**Approach:** A `"use server"` action `loadOpenPullRequests(owner, repo)` mirroring
`apps/web/app/repos/actions.ts`'s `loadAddableRepos` shape: call `getSession()`,
return `{ error: "reauth" }` when absent; otherwise `session.github
.listOpenPullRequests(owner, repo)` and return `{ pulls }`. Catch `GitHubAuthError`
→ `{ error: "reauth" }`; let other errors throw (the client surfaces a retry).
Define a small result union (`{ pulls: PullRequest[] } | { error: "reauth" }`).
Validate/normalize `owner`/`repo` minimally (non-empty strings) so the action isn't
a blind passthrough.

**Patterns to follow:** `apps/web/app/repos/actions.ts` (session re-check, `reauth`
mapping, JSDoc explaining why an action re-checks the session) and
`apps/web/app/repos/actions.test.ts` for the test harness shape.

**Test scenarios:**
- No session → returns `{ error: "reauth" }`, GitHub not called.
- Valid session → returns `{ pulls }` from `listOpenPullRequests` with owner/repo
  passed through unchanged. Assert the mapped array is returned verbatim.
- `listOpenPullRequests` throws `GitHubAuthError` → returns `{ error: "reauth" }`.
- `listOpenPullRequests` throws a non-auth error → the action rethrows (not
  swallowed into a fake empty list).
- Empty/blank owner or repo → guarded (rejects or returns reauth/empty per chosen
  contract) without calling GitHub.

**Verification:** Action returns the PR list for an authed session, `reauth` on
401/no-session, and rethrows real errors; `actions.test.ts` passes.

---

### U2. `PullsList` client island with the sync seam + sync status

**Goal:** Make the list keep itself current — refresh on tab refocus (R1), manual
Refresh (R2), legible sync status (R3), performant guarded/throttled refetch (R4),
reauth on token expiry (R6) — without a full-page reload.

**Requirements:** R1, R2, R3, R4, R6.

**Dependencies:** U1.

**Files:**
- `apps/web/components/pulls/PullsList.tsx` (create)
- `apps/web/components/pulls/PullsList.test.tsx` (create)
- `apps/web/app/repos/[owner]/[repo]/pulls/page.tsx` (modify)

**Approach:** Extract the list rendering (the `<ul>` of `PullRow`, the count line,
and the empty state) out of `page.tsx` into a `"use client"` `PullsList` that takes
`{ owner, repo, initialPulls }`. Internal state: `pulls`, `status`
(`idle`/`syncing`/`error`), `lastSynced` epoch, and `genRef`/`loadingRef` refs
copied from the modal pattern. A `sync(opts?: { manual })` function calls
`loadOpenPullRequests(owner, repo)` under the guards; on `{ error: "reauth" }` it
redirects to `/login` (`useRouter().push` or `window.location`); on success and when
`gen === genRef.current`, it replaces `pulls`, sets `lastSynced = Date.now()`, and
clears `status`. Add the `visibilitychange`/`focus` effect (mounted-only, torn down
on unmount) that calls `sync()` — gated by a `MIN_REFOCUS_INTERVAL_MS` throttle
(skip if `Date.now() - lastSynced < interval`). The header renders a **Refresh**
button (calls `sync({ manual: true })`, bypassing the throttle, disabled/spinner
while `status === "syncing"`) and a `SyncStatus` line: "Synced {relativeTime
(lastSynced)}" with a `Loader2` spinner + "Syncing…" while in flight. `page.tsx`
keeps `requireSession` + the initial `listOpenPullRequests` + initial-load
`GitHubAuthError` redirect, then renders `<PullsList initialPulls={pulls} … />`
inside the existing `<main>`/`AppHeader` shell. Keep `export const dynamic =
"force-dynamic"` so a hard navigation still server-fetches fresh initial data.

**Patterns to follow:** `apps/web/components/repos/AddRepositoriesModal.tsx`
verbatim for `loadingRef`/`genRef`, the `visibilitychange`+`focus` effect with
mounted-guard teardown (hardened in commit 8359223), and the manual `RefreshCw`
button styling; `apps/web/components/ui/button.tsx` for the Refresh control;
`lib/ui.ts` `relativeTime` for the synced timestamp; the existing empty-state and
count-line markup moved from `page.tsx`.

**Test scenarios:**
- Renders `initialPulls` immediately (no loading flash); count line and rows match.
- Tab fires `visibilitychange` to visible after the throttle window → `sync` calls
  `loadOpenPullRequests` and the list updates (mock returns a changed set). Assert
  call happened and rows re-rendered.
- Refocus within `MIN_REFOCUS_INTERVAL_MS` of last sync → no refetch (throttle).
- Manual **Refresh** click → always calls `loadOpenPullRequests` (bypasses
  throttle); spinner/"Syncing…" shows while in flight, clears after.
- In-flight load + a second trigger → only one `loadOpenPullRequests` call
  (`loadingRef` guard).
- `loadOpenPullRequests` resolves after unmount → no state update / no error
  (mounted-guard + `genRef`). Covers R4.
- Action returns `{ error: "reauth" }` → router push to `/login`, list not replaced.
- Empty result → empty state renders; non-empty→empty transition (all PRs merged)
  drops the rows and shows the empty state.

**Verification:** Leaving the page and returning refetches (outside the throttle),
Refresh always syncs with visible status, reauth routes to login, no
duplicate-load/stale-write/post-unmount regressions; `PullsList.test.tsx` passes and
the existing pulls page still renders its first paint.

---

### U3. Changed / new-PR visual feedback

**Goal:** Show *what* changed across a sync — flag PRs that are new or updated since
the previous synced view, clearing on the next sync (R5).

**Requirements:** R5.

**Dependencies:** U2.

**Files:**
- `apps/web/components/pulls/PullsList.tsx` (modify)
- `apps/web/components/pulls/PullRow.tsx` (modify)
- `apps/web/components/pulls/PullsList.test.tsx` (modify)

**Approach:** In `PullsList.sync`, before replacing `pulls`, diff incoming vs
current: build a `changed: Set<number>` where a `number` absent from the prior list
is "new" and a `number` whose `updatedAt` advanced is "updated" (track which via a
small `Map<number, "new" | "updated">` if both markers are wanted). Store it in
state; clear it at the start of the *next* successful sync. Pass an optional
`change?: "new" | "updated"` prop into `PullRow`; render a subtle accent — a `Badge`
("New"/"Updated") or a left-border/dot accent using existing tokens
(`border-success`/`text-success` already used for the PR glyph). Keep it tasteful
and professional (no flashing); the marker is informational, not an alert. The very
first paint (`initialPulls`) shows no markers — there's no prior view to diff
against.

**Patterns to follow:** `apps/web/components/ui/badge.tsx` (existing `Draft` badge
usage in `PullRow`), and the `text-success`/`border-border-strong` token palette
already in `PullRow.tsx`.

**Test scenarios:**
- First paint: no rows are marked new/updated.
- Sync adds a PR number not previously present → that row is marked "new"; others
  unmarked.
- Sync where an existing PR's `updatedAt` advanced → that row is marked "updated".
- Sync where a PR's `updatedAt` is unchanged → no marker on that row.
- Markers from one sync are cleared on the next successful sync.
- A merged/closed PR (absent from new list) is simply gone (no stale marker).

**Verification:** After a refocus/refresh that brings new or updated PRs, exactly
those rows carry a tasteful marker and the markers clear on the following sync;
tests pass.

---

### U4. agent-browser (Arc/CDP) + Playwright e2e for pulls sync

**Goal:** Prove the pulls-sync UX end to end against `devs-group/core-gent` (R7).

**Requirements:** R7.

**Dependencies:** U2, U3.

**Files:**
- `.claude/skills/diffsense-e2e/scripts/arc-drive-pulls-sync.sh` (create)
- `.claude/skills/diffsense-e2e/playwright/pulls-sync.spec.ts` (create)
- `.claude/skills/diffsense-e2e/SKILL.md` (modify — add a "§4d Pulls list sync"
  subsection)
- `.claude/skills/diffsense-e2e/playwright/README.md` (modify — note the new spec)

**Approach:** Arc driver mirrors `arc-drive-add-repos.sh`: attach to Arc on
`CDP_PORT`, open `/repos/devs-group/core-gent/pulls`, assert the page renders (PR
rows OR the empty state — environment-tolerant), assert the **Refresh** affordance
and the "Synced …" status are present (read page **text** via `ab get text`, per the
documented empty-state gotcha), click Refresh and assert the syncing/refreshed
state, and simulate a refocus (blur/focus or visibility toggle via CDP) to confirm
the list reloads. Parameterize `OWNER`/`REPO` (default `devs-group`/`core-gent`).
Emit notes (not hard failures) when the repo has zero open PRs so the run guides
rather than red-fails on an environment gap. Playwright spec reuses the
`storageState` auth pattern from `authed.spec.ts`/`add-repos.spec.ts`: navigate to
the pulls page, assert the Refresh control and synced-status are visible, assert the
list structure (rows or empty state), and assert clicking Refresh re-issues the
load without a full navigation (e.g. no full document reload / spinner appears).

**Patterns to follow:** `.claude/skills/diffsense-e2e/scripts/arc-drive-add-repos.sh`
(CDP attach, `ab()` helper, `pass`/`fail`, snapshot-vs-text discipline) and
`.claude/skills/diffsense-e2e/playwright/add-repos.spec.ts` (storageState auth,
resilient structural assertions), `playwright.config.ts`.

**Test scenarios:** `Test expectation: none — these are e2e driver/spec artifacts,
not unit tests.` Manual verification path documented in SKILL.md: run `up.sh`,
authorize once, then `arc-drive-pulls-sync.sh` and confirm PASS lines for list
render, Refresh present, synced status present, refocus refetch.

**Verification:** Running the driver against the isolated stack with Arc logged in
prints PASS for: pulls page renders, Refresh affordance present, synced status
present, refocus/Refresh triggers a refetch; `npx playwright test … pulls-sync
.spec.ts` passes against the captured session.

---

## System-Wide Impact

- App-code changes are confined to the pulls route:
  `apps/web/app/repos/[owner]/[repo]/pulls/{page.tsx,actions.ts}` and
  `apps/web/components/pulls/{PullsList.tsx,PullRow.tsx}`. No `packages/core`,
  schema, or server-pipeline changes; `lib/github.ts` `listOpenPullRequests` is
  reused unchanged.
- No new dependencies. `visibilitychange`/`focus` are platform APIs; `Loader2`/
  `RefreshCw`/`Badge`/`Button`/`relativeTime` already exist in the web app.
- e2e additions live in the `diffsense-e2e` skill directory; they don't run in the
  default `vitest` suite and don't gate app CI.
- Behavior parity: the page's first paint and auth-redirect behavior are unchanged;
  the sync seam is purely additive on top of the current server render.

---

## Risks & Mitigations

- **Refresh storm / GitHub rate limits on rapid tab toggles** → the
  `MIN_REFOCUS_INTERVAL_MS` throttle on refocus plus the `loadingRef` in-flight
  guard (U2); a test asserts no refetch within the throttle window and no duplicate
  in-flight call. Manual Refresh intentionally bypasses the throttle (explicit
  user intent).
- **Stale write / post-unmount setState** (the bug class fixed in 8359223 for the
  modal) → reuse the same `genRef` generation counter + mounted guard; a test
  resolves a load after unmount and asserts no state update.
- **`visibilitychange` not firing in some automation/browsers** → the always-present
  manual **Refresh** (R2) is the guaranteed fallback; e2e asserts it exists.
- **False "updated" markers from `updatedAt` churn** → marker is informational and
  self-clearing on next sync, so a spurious flag is low-cost; diff strictly on
  `updatedAt` advancing, not on any field, to limit noise.
- **Token expiry mid-session** → action returns `reauth`, client routes to `/login`
  (R6); a test covers the redirect path so a refresh never shows a broken list.

---

## Test Strategy

- **Unit/component (vitest, hermetic):** U1 `actions.test.ts` (session re-check,
  reauth mapping, rethrow); U2/U3 `PullsList.test.tsx` (initial paint, refocus
  refetch + throttle, manual refresh, in-flight + post-unmount guards, reauth
  redirect, changed/new markers and their clearing). These run in normal CI.
- **e2e (manual / skill-driven):** U4 Arc driver + Playwright spec live in
  `diffsense-e2e`, run against the isolated Docker stack per `SKILL.md`, target
  `devs-group/core-gent`. Not part of default CI; invoked via the skill.
- After U1–U3, run the web test suite (`pnpm --filter @diffsense/web test`) and
  confirm the existing pulls page render and modal/action tests still pass (no
  regression to the shared concurrency-guard pattern).

---

## Deferred to Follow-Up Work

- Real-time push of PR changes (installation/PR webhooks → SSE/WebSocket) so the
  list updates without any refocus. This plan's refocus+manual model is the
  performant ephemeral baseline.
- An always-on ticking "synced N seconds ago" timer (v1 re-renders the relative
  time on sync events only).
- Pagination / filtering / closed-and-merged history on the pulls page.
- Wiring U4 into an actual CI workflow (CI is gitignored locally per project
  memory).

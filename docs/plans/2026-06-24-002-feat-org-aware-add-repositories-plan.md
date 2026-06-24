---
title: "feat: Org-aware Add Repositories onboarding (surface installable orgs + auto-return)"
type: feat
date: 2026-06-24
status: ready
depth: standard
branch: feat/add-repositories-modal
---

# feat: Org-aware Add Repositories onboarding

## Summary

Close the chicken-and-egg in the Add Repositories modal: a GitHub **App** user token can't
list an organisation's repos until the App is installed there, so org repos (e.g.
`devs-group/core-gent`) never appear and the user has no in-app path to fix that. This
adds (1) **installable-account cards** — the user's GitHub orgs (and personal account)
that don't yet have diffsense, each linking to the canonical install page; (2) a **Setup
URL route** so that after installing on GitHub the user is bounced straight back to
`/repos` with the new repos visible; and (3) **member-vs-owner copy** setting the
expectation that installing on an org you don't own files a request to its owners.

**Target branch:** `feat/add-repositories-modal` (continue on it; do not create a new branch).

---

## Problem Frame

The Add Repositories modal (`apps/web/components/repos/AddRepositoriesModal.tsx`) lists repos
from `loadAddableRepos`, which reads `/user/repos` via the session's GitHub-App user token.
That token only surfaces repos in accounts where the App is **reachable** — so for an org
without diffsense, *zero* repos come back and the org is invisible. The user can't add what
they can't see. Today the only escape is the generic "Install on another account" footer
link, which is easy to miss and gives no signal about *which* orgs are installable.

Result: a user in `devs-group` sees core-gent vanish once the App isn't installed there, with
no obvious way to onboard the org. We need to surface the orgs themselves as install targets,
make the post-install return seamless, and set correct expectations about org-owner approval.

---

## Requirements

- **R1** — The modal surfaces the user's organisations (and personal account) that do **not** yet have diffsense installed, as "Install on `<account>`" cards.
- **R2** — Each install card opens the canonical GitHub App install page (`https://github.com/apps/<slug>/installations/new`); per-account `target_id` deep links are not used (they 404 — see origin plan 001 / PR #44).
- **R3** — When the user token cannot read `/user/orgs`, the feature degrades gracefully: no crash, the existing generic "Install on another account" affordance remains.
- **R4** — A route handler at `apps/web/app/api/github/setup` accepts GitHub's post-install redirect and sends the user back to `/repos` (with an `installed` marker), so a completed install auto-returns and the refreshed list reflects new repos.
- **R5** — The modal communicates that installing on an org the user doesn't own files a request to the org's owners for approval.
- **R6** — Accounts that already have an installation are not shown as install cards (no duplicates with the existing repo groups).
- **R7** — The Setup URL redirect target is a fixed internal path (no open redirect), consistent with the OAuth callback.

---

## Key Technical Decisions

### KTD1 — Surface installable *accounts*, not org repos

We cannot list an un-installed org's repos (the token can't see them). So the unit of
onboarding is the **account**: list orgs the user belongs to (`GET /user/orgs`) plus their
personal account, subtract accounts that already have an installation, and present the
remainder as install targets. This is the only thing we *can* show pre-install, and it's
exactly what unblocks core-gent: install on `devs-group` → its repos appear.

### KTD2 — One canonical install URL (reuse the 001/PR-#44 decision)

All install links use `https://github.com/apps/<slug>/installations/new` (via the existing
`buildInstallUrl`). GitHub's install page already lists the accounts the user can install on
and routes owner-approval requests. We do **not** revive per-account `target_id` deep links —
they 404 (already removed in PR #44). The cards are a discoverability layer over the same
canonical URL.

### KTD3 — Setup URL is a thin redirect, not a callback that mutates state

GitHub redirects to the App's configured **Setup URL** after install with `installation_id`
and `setup_action`. We do not need to exchange anything or persist via this route — the next
`/repos` render + the modal's existing reopen-refetch already pick up the new installation
through the normal `/user/installations` path. So the handler just redirects to
`${WEB_BASE_URL}/repos?installed=1` (fixed internal path, mirroring the OAuth callback's
no-open-redirect rule). The `installed=1` marker is available for a future toast/auto-open but
is not required to function.

### KTD4 — Graceful degradation when `/user/orgs` is unreadable

A GitHub-App user token may lack org-membership read. `listUserOrganizations` failing with a
non-auth error must not sink the modal: the action catches it and returns an empty
installable-targets list, leaving the existing generic footer link as the fallback (R3).
`GitHubAuthError` still propagates to the `reauth` path, as elsewhere.

### KTD5 — Member-vs-owner is static copy, not a per-org role probe

Determining whether the user owns each org would need `/user/memberships/orgs` per org. For
this slice we show a single explanatory line near the cards ("installing on an org you don't
own requests approval from its owners"). A per-card "you'll need approval" badge driven by
membership role is deferred (see Scope Boundaries).

---

## High-Level Technical Design

```
loadAddableRepos (server action)
  ├─ listInstallations() ─────────────┐  (accounts with diffsense)
  ├─ listAccessibleRepositories() ────┤→ groups[] (existing)
  └─ listUserOrganizations() ─────────┘  GET /user/orgs   (may fail → [])
        │
        ▼  subtract installed account logins (case-insensitive); add personal account
  installableTargets[] = { account, accountType }   ← orgs/personal WITHOUT diffsense
        │
        ▼
  { groups, installableTargets, installNewUrl }
        │
        ▼
  AddRepositoriesModal
    ├─ installed groups → repos (existing add/added)
    ├─ "Install on <account>" cards  → installNewUrl (canonical)  + owner-approval note
    └─ footer "Install on another account" (existing fallback)

GitHub install completes ──redirect──▶ /api/github/setup?installation_id&setup_action
                                          └─▶ 302 /repos?installed=1  (fixed internal path)
```

---

## Implementation Units

### U1. GitHub client: list the user's organisations

**Goal:** Add a read method returning the orgs the signed-in user belongs to, for the modal's installable-account list.

**Requirements:** R1, R3

**Dependencies:** none

**Files:**
- `apps/web/lib/github.ts` (add `Organization` interface, `listUserOrganizations()` to `GitHubClient`, `mapOrganization`)
- `apps/web/lib/github.test.ts` (tests)

**Approach:** Mirror the paginated read pattern of `listInstallations`/`listAccessibleRepositories`.
Call `GET /user/orgs?per_page=100&page=N` (bare array response), paginate up to `MAX_PAGES`, map
each to `{ login, id, avatarUrl }`. Reuse the existing `get()` helper so 401 → `GitHubAuthError`
and rate-limit handling are inherited. `Organization` carries `login` + `id` (+ `avatarUrl` for
parity with `Installation`; display uses `login`).

**Patterns to follow:** `listAccessibleRepositories` pagination loop; `mapInstallation` / `mapRepository` mappers; `asArray`.

**Test scenarios:**
- Happy path: one page of orgs → mapped `{ login, id, avatarUrl }[]`.
- Pagination: 100 then a short page → concatenated; stops on the short page.
- Bound: a full `MAX_PAGES` of 100 stops at the cap.
- Empty: `[]` response → `[]`.
- Auth: 401 → throws `GitHubAuthError`.
- Rate limit: 403 with `x-ratelimit-remaining: 0` → throws `GitHubRateLimitError`.

---

### U2. Server action: compute installable targets

**Goal:** Extend `loadAddableRepos` to return the accounts (orgs + personal) the user can onboard but that don't yet have diffsense.

**Requirements:** R1, R3, R6

**Dependencies:** U1

**Files:**
- `apps/web/lib/addableRepos.ts` (add `InstallableTarget` type; extend `AddableReposResult`; pure helper `computeInstallableTargets`)
- `apps/web/app/repos/actions.ts` (call `listUserOrganizations`, build targets, include in result)
- `apps/web/lib/addableRepos.test.ts` and `apps/web/app/repos/actions.test.ts` (tests)

**Approach:** In the action, fetch `listUserOrganizations()` alongside the existing parallel
reads; wrap it in a `.catch` that re-throws `GitHubAuthError` but maps any other error to `[]`
(KTD4). Add the signed-in user's **personal account** as a candidate target too (login from the
session; type `User`). A pure `computeInstallableTargets(orgs, personalLogin, installations)`
returns `{ account, accountType }[]` = candidates whose login is **not** in the installed-account
set (case-insensitive), sorted alphabetically. Extend the success result to
`{ groups, installableTargets, installNewUrl }`. `installableTargets` may be empty (R3 fallback).

**Patterns to follow:** the existing `Promise.all` + per-call `.catch` resilience in `loadAddableRepos`; `buildAddableGroups` purity split; `isOrgAccount` for type labelling.

**Test scenarios (computeInstallableTargets — pure):**
- Orgs minus installed: 2 orgs, 1 installed → only the un-installed org returned.
- Personal account included when not installed; excluded when an installation exists for it.
- Case-insensitive match between org login and installation account login.
- Empty orgs + personal already installed → `[]`.
- Sort order alphabetical; `accountType` is `Organization` for orgs, `User` for personal.

**Test scenarios (loadAddableRepos — action, fake client):**
- Happy path: orgs returned, one already installed → `installableTargets` excludes it; `groups` unchanged.
- `listUserOrganizations` throws a non-auth error → `installableTargets: []`, groups still returned (no throw).
- `listUserOrganizations` throws `GitHubAuthError` → `{ error: "reauth" }`.
- Result always includes `installNewUrl`.

---

### U3. GitHub App Setup URL route handler

**Goal:** Accept GitHub's post-install redirect and bounce the user back to `/repos` so the new install is reflected without a manual refresh.

**Requirements:** R4, R7

**Dependencies:** none

**Files:**
- `apps/web/app/api/github/setup/route.ts` (new `GET` handler)
- `apps/web/app/api/github/setup/route.test.ts` (tests)
- `.env.example` (document the Setup URL must be configured on the GitHub App as `${WEB_BASE_URL}/api/github/setup`)

**Approach:** `export const dynamic = "force-dynamic"`. A `GET` that reads `loadAuthConfig()` and
returns `NextResponse.redirect(`${config.webBaseUrl}/repos?installed=1`)`. The redirect target is a
**fixed internal path** built from config, never from request params (KTD3, R7) — GitHub's
`installation_id`/`setup_action` query params are ignored for routing (they may be logged later but
must not influence the destination). No session mutation, no token exchange. Mirror the OAuth
callback route's structure and its no-open-redirect comment.

**Patterns to follow:** `apps/web/app/api/auth/callback/route.ts` (force-dynamic, `loadAuthConfig`, `NextResponse.redirect` to a fixed internal URL).

**Test scenarios:**
- Redirects (307/302) to `${WEB_BASE_URL}/repos?installed=1`.
- The redirect target ignores `installation_id` / `setup_action` query params (no open redirect; destination is config-derived).
- Works regardless of `setup_action` value (`install` / `update`).

---

### U4. Modal: installable-account cards + owner-approval copy

**Goal:** Render the installable accounts as cards in the modal and set member-vs-owner expectations.

**Requirements:** R1, R2, R5, R6

**Dependencies:** U2

**Files:**
- `apps/web/components/repos/AddRepositoriesModal.tsx`
- `apps/web/components/repos/AddRepositoriesModal.test.tsx`

**Approach:** Consume `installableTargets` and `installNewUrl` from the loaded state. Render a
section (e.g. "Add an organisation or account") of cards — one per target — each showing the
account name with the org/user icon (`isOrgAccount`) and an "Install" affordance that opens
`installNewUrl` in a new tab (`target="_blank" rel="noopener noreferrer"`, matching the existing
links). Show a single explanatory line near the section: installing on an org you don't own
sends a request to its owners to approve (R5). When `installableTargets` is empty, omit the
section (the existing footer link remains, R3). Keep the existing repo groups and filter intact.

**Execution note:** Component test-first for the new section's presence/empty-state branching.

**Patterns to follow:** existing `AccountGroup` header (icon + name via `isOrgAccount`); the existing install-link styling (`Plus`/`ExternalLink`, `Button asChild`); the modal's loaded-state rendering.

**Test scenarios:**
- Loaded state with installable targets → renders an "Install on `<org>`" card per target with `installNewUrl` href and `target="_blank"`.
- Owner-approval note is present when at least one installable target is shown.
- Empty `installableTargets` → no install-cards section; the generic "Install on another account" footer still renders.
- Already-installed accounts (present in `groups`) do not appear as install cards (covered by U2's exclusion; assert no duplicate card for an installed account).
- Filter still narrows the repo list and does not affect the install-cards section.

---

## Scope Boundaries

**In scope:** listing installable orgs/personal account, canonical install links, the Setup URL
redirect route, owner-approval copy, graceful `/user/orgs` fallback.

### Deferred to Follow-Up Work
- Per-card owner-vs-member badge driven by `/user/memberships/orgs` role (KTD5) — static copy for now.
- A toast / auto-open-modal on `/repos?installed=1` (the marker is emitted but only triggers a normal fresh render this slice).
- Webhook-driven live refresh of installations (the reopen-refetch + Setup URL return already cover the common case).
- Recording/observing `installation_id` from the Setup URL for analytics.

### Out of scope (not this product)
- Programmatically installing the App without GitHub's install UI (impossible for GitHub Apps).
- Any merge/approve/enforcement authority (diffsense stays advisory).

---

## System-Wide Impact

- **New GitHub API call** `GET /user/orgs` per modal open (paginated, lazy, bounded by `MAX_PAGES`); inherits the existing 10s timeout + rate-limit handling. Tolerates 403 (graceful empty).
- **New route** `/api/github/setup` — public GET, no auth required (it only redirects to a fixed internal path). No state change.
- **GitHub App configuration (out of band):** the App's **Setup URL** must be set to `${WEB_BASE_URL}/api/github/setup` and "Redirect on update" enabled, documented in `.env.example`. Without it, install simply doesn't auto-return (no breakage; manual refresh still works).
- No DB/schema changes, no `packages/core` changes, no worker changes.

---

## Risks & Dependencies

- **R-risk1 — `/user/orgs` visibility under a GitHub App user token.** It may return only orgs that have approved the app, or require members:read. Mitigation: graceful empty fallback (KTD4); the generic footer link still lets the user reach the install page. Verify actual behavior during implementation; if consistently empty, the cards add little and the footer carries the flow (note in PR).
- **R-risk2 — Setup URL not configured on the App.** Auto-return won't fire. Mitigation: documented in `.env.example`; behavior degrades to manual refresh, no error.
- **R-risk3 — Personal account already installed but listed.** Mitigation: exclusion is case-insensitive against the installed-account set (U2).

---

## Verification

- `pnpm test` (web suite) green incl. new U1/U2/U3/U4 tests.
- `pnpm --filter @diffsense/web build` succeeds (typecheck).
- `pnpm lint` clean.
- Manual (when a live session is available): open the modal as a user in an org without diffsense → the org appears as an install card → clicking it opens GitHub's install page → after installing, GitHub returns to `/repos?installed=1` and the org's repos are listed.

---
title: "feat: Installation-sourced Add Repositories with role-aware access requests"
type: feat
date: 2026-06-24
status: ready
depth: standard
branch: feat/add-repositories-modal
---

# feat: Installation-sourced Add Repositories

## Summary

Rework the Add Repositories modal so it fully supports **private org repos**. A GitHub App
can only see repos in accounts where it is installed, so the modal's source of truth becomes
the **installation** itself: for each installed account, list its repos via the installation
(which includes private repos), and for accounts without an installation, offer a role-aware
**Install** (you're an org admin) or **Request access** (you're a member → GitHub asks the
owners) card. Selected-repository installs get a "Manage repositories on GitHub" link so the
user can widen access. This drops the `/user/repos` browse path, which can't surface private
org repos and lists repos the App can't actually review.

**Target branch:** `feat/add-repositories-modal` (continue on it; do not create a new branch).

---

## Problem Frame

Verified on a live install: an `all repos` installation returns its **private** repos fine
(48 repos incl. 12 private). So private visibility is not the blocker — the blocker is that an
org with **no installation** (e.g. `devs-group`) is entirely invisible to the App, and the
current modal's browse list comes from `/user/repos` (`listAccessibleRepositories`), which a
GitHub-App user token does not reliably populate with private org repos. Worse, `/user/repos`
lists repos the App can't review (not in any installation), so "Add" on them is meaningless.

The fix is to flip the model: the modal lists what the App **can** review (installation repos,
private included) and, for everything else, drives the install/request flow at the account
level — the only way a GitHub App ever gains repo access.

---

## Requirements

- **R1** — For each account that has a diffsense installation, the modal lists that installation's repositories (private included), each linking to its PR list (`/repos/<owner>/<repo>/pulls`).
- **R2** — The modal no longer sources repos from `/user/repos`; `listAccessibleRepositories` (and now-dead `Repository.ownerId`) are removed.
- **R3** — Accounts the user belongs to **without** an installation are shown as install cards, labelled by the user's role: **admin → "Install"**, **member → "Request access"**, plus the personal account when not installed.
- **R4** — Role is read from `GET /user/memberships/orgs` (`{ login, role, state }`); when it's unreadable, the cards degrade gracefully (no role cards, generic "Install on another account" link remains).
- **R5** — Install/Request cards keep the owner-approval note (installing on an org you don't own files a request to its owners).
- **R6** — For an installed account whose `repository_selection` is `selected`, the modal shows a "Manage repositories on GitHub" link to that installation's configure page; for `all`, no such link.
- **R7** — All cards/links use the canonical install URL (`https://github.com/apps/<slug>/installations/new`); the Setup URL route (`/api/github/setup`) continues to auto-return the user to `/repos` after install/approval.

---

## Key Technical Decisions

### KTD1 — Installation repositories are the source of truth

The reviewable set is exactly what the App can see: `listInstallationRepositories` (already
implemented, `GET /user/installations/{id}/repositories`, returns private repos). The modal
lists these directly instead of `/user/repos`. Every listed repo is reviewable by definition,
so the per-repo "add vs added" distinction disappears — a repo is in the list because the App
is on it. This also makes the modal consistent with the existing `/repos` page, which already
sources from installations.

### KTD2 — Role-aware Install vs Request via `/user/memberships/orgs`

`GET /user/memberships/orgs` returns each org the user belongs to with `role` (`admin`/`member`)
and `state` (`active`/`pending`). This supersedes the `/user/orgs` call added in the prior slice
(richer: it carries role). Admins can install directly; members can't, so for them the same
canonical install URL becomes a **request** to the org owners — GitHub routes the approval. The
card label reflects that ("Install" vs "Request access").

### KTD3 — Selected-repository installs get a manage link

`repository_selection` on the installation is `all` or `selected`. For `selected`, the App only
sees the chosen repos, so the user needs a path to add more — the installation's configure page
(`html_url`, e.g. `…/settings/installations/{id}`). For `all`, every repo is already listed, so
no link is needed. `mapInstallation` must capture both `repository_selection` and `html_url`.

### KTD4 — Graceful degradation everywhere external

A GitHub-App user token may not read `/user/memberships/orgs`. As with the prior slice, a
non-auth failure maps to "no role cards" and the generic install link remains; `GitHubAuthError`
still propagates to reauth. The per-installation repo fetch keeps its existing resilience
(non-auth failure for one account degrades just that group).

---

## High-Level Technical Design

```
loadAddableRepos (server action)
  ├─ listInstallations() ──────────────┐  now carries repository_selection + configureUrl
  │   for each installation:            │
  │     listInstallationRepositories()──┤→ groups[] = { account, accountType,
  │       (GET /user/installations/{id}/repositories, incl PRIVATE)   repositorySelection,
  │                                      │                              manageUrl?, repos[] }
  ├─ listUserMemberships() ─────────────┘  GET /user/memberships/orgs  (may fail → [])
  │     { login, role, state }
  ▼  installable = (orgs from memberships ∪ personal) − installed accounts
       each tagged installType: role==admin → "install" ; role==member → "request"
  ▼
  { groups, installableTargets, installNewUrl }
  ▼
AddRepositoriesModal
  ├─ installed account → its repos (private incl.) → each links to /pulls
  │     + "Manage repositories on GitHub" when repositorySelection === "selected"
  └─ install cards → "Install" (admin) / "Request access" (member) + owner-approval note

install / approval ──▶ /api/github/setup ──▶ /repos  (reopen-refetch shows new repos)
```

---

## Implementation Units

### U1. GitHub client: installation metadata + memberships; drop dead browse path

**Goal:** Capture `repository_selection` + configure URL on installations, add a memberships read, and remove the `/user/repos` browse path now that it's unused.

**Requirements:** R2, R3, R4, R6

**Dependencies:** none

**Files:**
- `apps/web/lib/github.ts`
- `apps/web/lib/github.test.ts`

**Approach:**
- Extend `Installation` with `repositorySelection: "all" | "selected"` and `configureUrl: string` (from `html_url`); update `mapInstallation` to read `repository_selection` and `html_url`.
- Add `listUserMemberships(): Promise<OrgMembership[]>` where `OrgMembership = { login, role: "admin" | "member", state: string }`, calling `GET /user/memberships/orgs?per_page=100&page=N` (mapping `organization.login`, `role`, `state`), paginated like the other list methods.
- Remove `listAccessibleRepositories` and `Repository.ownerId` (now dead), and remove the `Organization` type + `listUserOrganizations` added in the prior slice (superseded by memberships). Confirm no remaining consumers before deleting.

**Patterns to follow:** `mapInstallation`, the paginated `listUserOrganizations`/`listInstallationRepositories` loops, `asArray`/`asRecord`.

**Test scenarios:**
- `mapInstallation` maps `repository_selection: "selected"` and `html_url` → `repositorySelection`/`configureUrl`; defaults `repository_selection` to `"all"` when absent.
- `listUserMemberships` maps `{ organization: { login }, role, state }` → `{ login, role, state }`; paginates and stops on a short page; caps at `MAX_PAGES`; `[]` when none.
- `listUserMemberships` throws `GitHubAuthError` on 401 and `GitHubRateLimitError` on a rate-limited 403.
- No test references `listAccessibleRepositories`/`ownerId`/`Organization` after removal (compile + existing suite green).

---

### U2. Pure shaper: groups from installations + role-aware targets

**Goal:** Reshape `addableRepos.ts` to build groups from installation repos and compute install/request targets from memberships.

**Requirements:** R1, R3, R5, R6

**Dependencies:** U1

**Files:**
- `apps/web/lib/addableRepos.ts`
- `apps/web/lib/addableRepos.test.ts`

**Approach:**
- Replace `buildAddableGroups(accessible, installedFullNames, …)` with a shaper that takes the installations plus their fetched repo lists and returns `AddableGroup = { account, accountType, repositorySelection, manageUrl: string | null, repos: Repository[] }`. `manageUrl` is the installation's `configureUrl` when `repositorySelection === "selected"`, else `null`. Sort repos most-recently-pushed first; sort groups alphabetically (or actionable-first if useful). Drop `AddableRepo`/`added` (every listed repo is reviewable).
- Change `computeInstallableTargets` to take `memberships: OrgMembership[]`, `personalLogin`, and `installations`; emit `InstallableTarget = { account, accountType, installType: "install" | "request" }` where `installType` is `request` when the membership role is `member`, else `install`; personal account is always `install`. Exclude accounts that already have an installation (case-insensitive). Sort alphabetically.

**Patterns to follow:** the existing `computeInstallableTargets` filter/sort; `isOrgAccount`; the installed-account `Set` lowercasing.

**Test scenarios:**
- Group shaping: an installation with 2 repos → one group with those repos (private flag preserved); `manageUrl` set only when `repositorySelection === "selected"`.
- `computeInstallableTargets`: admin membership → `install`; member membership → `request`; personal → `install`; already-installed org excluded (case-insensitive); empty memberships + installed personal → `[]`; alphabetical order.

---

### U3. Server action: assemble installation groups + targets

**Goal:** Rewire `loadAddableRepos` to the new sources.

**Requirements:** R1, R3, R4, R7

**Dependencies:** U1, U2

**Files:**
- `apps/web/app/repos/actions.ts`
- `apps/web/app/repos/actions.test.ts`

**Approach:** Fetch `listInstallations()` and `listUserMemberships()` (the latter wrapped in a
`.catch` that re-throws `GitHubAuthError`, maps other errors to `[]` — KTD4) together; then fetch
each installation's repos (existing per-installation `.catch` resilience). Build groups via the
U2 shaper and targets via `computeInstallableTargets(memberships, session.login, installations)`.
Drop the `listAccessibleRepositories` call. Result stays `{ groups, installableTargets, installNewUrl }`;
`GitHubAuthError` anywhere → `{ error: "reauth" }`.

**Patterns to follow:** the current `loadAddableRepos` `Promise.all` + per-call `.catch`; `appSlug`/`buildInstallUrl`.

**Test scenarios:**
- Installed account → group with its installation repos; selected install → group `manageUrl` set.
- Memberships: admin org not installed → `install` target; member org → `request` target.
- `listUserMemberships` throws non-auth → targets degrade (personal only); throws `GitHubAuthError` → `{ error: "reauth" }`.
- A per-installation repo fetch failing (non-auth) degrades only that group; result always includes `installNewUrl`.

---

### U4. Modal: installation repo groups, manage link, Install/Request cards

**Goal:** Render the reshaped data — reviewable repo groups with an optional manage link, and role-labelled install cards.

**Requirements:** R1, R3, R5, R6

**Dependencies:** U3

**Files:**
- `apps/web/components/repos/AddRepositoriesModal.tsx`
- `apps/web/components/repos/AddRepositoriesModal.test.tsx`

**Approach:** Each group renders its repos as rows linking to `/repos/<owner>/<repo>/pulls`
(reuse the existing row visuals; drop the add/added affordance — all are reviewable). When
`group.manageUrl` is set, show a "Manage repositories on GitHub" link (new tab) in the group
header. The install cards use `installType` for the label: `install` → "Install", `request` →
"Request access"; keep the owner-approval note. Keep the filter over repo name/fullName, the
loading/error/reauth/empty states, and the lifecycle guards (in-flight, reset-on-close) intact.

**Execution note:** Component test-first for the install-vs-request label and the manage-link conditional.

**Patterns to follow:** existing `AccountGroup`/`InstallableTargets`/`RepoRow` visuals; `isOrgAccount`; the existing install-link styling.

**Test scenarios:**
- Group with repos → rows link to `/repos/<owner>/<repo>/pulls`; a private repo still renders (with its private badge).
- `manageUrl` present → "Manage repositories on GitHub" link with that href + `target="_blank"`; absent → no link.
- Install card with `installType: "install"` → "Install"; `installType: "request"` → "Request access"; owner-approval note present.
- Empty `installableTargets` → no cards section; generic footer link remains.
- Filter narrows repo rows; reauth/unknown-error/empty states unchanged.

---

## Scope Boundaries

**In scope:** installation-sourced repo groups, role-aware install/request cards, selected-repo
manage link, removal of the `/user/repos` browse path and dead `ownerId`/`Organization`.

### Deferred to Follow-Up Work
- Pending-request state surfacing (`membership.state === "pending"`) as a "Requested" badge — copy-only expectation for now.
- A toast on `/repos?installed=1` (marker emitted; only a fresh render today).
- Webhook-driven live installation updates.

### Out of scope (not this product)
- Programmatic install without GitHub's UI (impossible for GitHub Apps).
- Any merge/approve/enforcement authority (advisory only).

---

## System-Wide Impact

- **New GitHub API call** `GET /user/memberships/orgs` per modal open (paginated, lazy, bounded; tolerates 403 → empty). Replaces the prior `/user/orgs` call.
- **Removed call** `GET /user/repos` (`listAccessibleRepositories`) — fewer calls, and the modal now matches the `/repos` page's installation-based model.
- **`Installation` interface gains** `repositorySelection` + `configureUrl`; the existing `/repos` page consumes `Installation` only by reading existing fields, so additive change is safe.
- No DB/schema/core/worker changes. No new dependencies.

---

## Risks & Dependencies

- **R-risk1 — `/user/memberships/orgs` visibility under a GitHub-App user token.** May be limited; mitigated by graceful empty fallback (the generic install link still works). Verify during implementation.
- **R-risk2 — Removing `listAccessibleRepositories` changes modal behavior.** Repos not in any installation no longer appear — intended (they aren't reviewable). The install/request cards are the path to add their account.
- **R-risk3 — `configureUrl` shape.** GitHub's installation `html_url` is the authoritative configure link; use it verbatim rather than constructing the path.

---

## Verification

- `pnpm test` (web) green incl. new U1–U4 tests; `pnpm lint` clean; `pnpm --filter @diffsense/web build` succeeds (typecheck).
- Manual (live session): as a `devs-group` member with no installation → the modal shows a "Request access" card for `devs-group`. After an owner installs diffsense on `devs-group` (all repos), reopening the modal lists `devs-group/core-gent` (private) linking to its PRs. For a selected-repo install, the "Manage repositories on GitHub" link opens the configure page.

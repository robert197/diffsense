---
title: "feat: Add Repositories button + modal (browse & add org/user repos)"
type: feat
date: 2026-06-24
status: ready
depth: standard
---

# feat: Add Repositories button + modal

## Summary

Add an **"Add repositories"** button on the `/repos` page that opens a modal listing
every repository the signed-in reviewer can reach — across their personal account and
all their GitHub organisations — so they can pick which repos diffsense reviews. Each
repo row shows whether diffsense is **already added** (the GitHub App is installed on
it) or **not yet added**; the primary action on a not-yet-added repo routes the user to
GitHub's App-installation screen for that account, the only place repo access can
actually be granted.

This closes the gap where the current `/repos` page can only *show* repos the App is
already installed on, with no in-product path to add more.

---

## Problem Frame

`apps/web/app/repos/page.tsx` lists repositories grouped by GitHub App **installation**
(`listInstallations` → `listInstallationRepositories`). A reviewer who wants diffsense on
a new repo has no affordance — the empty state just says "install the GitHub App … then
refresh." There is no button, no browse view, no select flow.

The request: a working "Add repositories" button + modal where the reviewer can see and
select **any** repo from their organisations or their own GitHub user.

**The hard constraint that shapes the whole design:** diffsense is a **GitHub App**
(`apps/web/lib/auth/oauth.ts` header — "GitHub Apps … access is governed by the App's
configured permissions and the installations the user can reach"). Reviews are driven by
PR webhooks, which GitHub only delivers for repos where the App is **installed**. A
user-to-server OAuth token can *read* the repos a user can access (`GET /user/repos`) but
**cannot grant the App access to a repo** — only GitHub's installation UI can. Therefore
"add a repo" fundamentally means "install / configure the App on that repo," and the
honest, fully-working flow surfaces the user's repos for discovery while routing the
actual grant to GitHub's trusted installation screen.

---

## Requirements

- **R1** — A visible "Add repositories" button on `/repos` (page header and empty state).
- **R2** — Clicking it opens an accessible modal (focus trap, Esc to close, overlay click to dismiss).
- **R3** — The modal lists repositories the signed-in user can access, grouped by account (personal user + each organisation).
- **R4** — Each repo indicates whether diffsense is already added (App installed) vs not yet added.
- **R5** — A not-yet-added repo offers an "Add" action that deep-links to GitHub's App-installation/configuration page for that repo's account.
- **R6** — An "Install on another account" affordance deep-links to the App's generic installation URL (`https://github.com/apps/<slug>/installations/new`).
- **R7** — A client-side filter/search narrows the list by repo name or `owner/name`.
- **R8** — Repo data loads lazily when the modal opens (not on every `/repos` render) and shows loading + error states.
- **R9** — 401 from GitHub during the modal load surfaces as a re-auth prompt; it must not silently blank the modal.

---

## Key Technical Decisions

### KTD1 — "Add" routes to GitHub's installation UI, not an in-app toggle

A custom in-modal toggle cannot make diffsense review a repo: the App must be installed
for webhooks to fire. So the modal is a **discovery + routing** surface — it lists the
user's repos and, for a not-yet-added one, links to GitHub's per-account App-configure
page (`https://github.com/apps/<slug>/installations/new/permissions?target_id=<accountId>`
or the account's existing installation `html_url`). This is the same boundary the current
empty state already lives behind; the modal just makes it browsable and per-repo. Rationale:
honesty over a fake success state — selecting a repo we can't actually receive webhooks for
would silently never produce reviews.

### KTD2 — "Already added" is computed by cross-referencing installed repos

The modal marks a repo **added** when its `fullName` is in the set of repos returned by
the existing installation calls. The server action fetches both (`/user/repos` for the
full accessible list; `listInstallations` + `listInstallationRepositories` for the
installed set) and returns each accessible repo annotated with `added: boolean`. No new
persistence — installation state remains the single source of truth (matches
`docs/ARCHITECTURE.md` — installations drive repo access).

### KTD3 — Lazy load via a Next.js Server Action

The repos page is a server component; the modal is interactive (client component). Repo
data loads on modal open through a **server action** (`loadAddableRepos`) co-located with
the page, so the user OAuth token never reaches the browser and the data isn't fetched on
every page render. Returns a typed, serialisable result (`{ groups }` or `{ error }`).
Mirrors the existing server-action pattern in `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.ts`.

### KTD4 — Add `@radix-ui/react-dialog` for the modal primitive

`apps/web` has no dialog primitive (only `@radix-ui/react-slot`). Add
`@radix-ui/react-dialog` and a shadcn-style `components/ui/dialog.tsx` wrapper — accessible
(focus trap, `aria-modal`, Esc, scroll lock) without hand-rolling it. Consistent with the
existing shadcn-primitive direction (commit `f847def`). Rationale over a hand-rolled modal:
accessibility correctness (R2) is easy to get subtly wrong.

### KTD5 — New `GITHUB_APP_SLUG` env for install URLs

The generic install URL needs the App's slug. Add `GITHUB_APP_SLUG` to env + `.env.example`.
The slug is **not secret** (it's in public install URLs), so it may be passed to the client
component. Build install URLs on the server (in the action) and pass them down as data, so
the client never needs the env directly.

---

## High-Level Technical Design

```
/repos (server component)
  ├─ <AddRepositoriesButton/>  (client) ──opens──▶ <AddRepositoriesModal/> (client, radix Dialog)
  │                                                     │ on open
  │                                                     ▼
  │                                           server action: loadAddableRepos()
  │                                                     │  (user OAuth token, server-only)
  │                                                     ├─ github.listAccessibleRepositories()   → GET /user/repos
  │                                                     ├─ github.listInstallations()             → installed set
  │                                                     │   + listInstallationRepositories(id)
  │                                                     └─ build install URLs (GITHUB_APP_SLUG)
  │                                                     ▼
  │                                  { groups: [{ account, accountType, installUrl,
  │                                               repos: [{ fullName, name, private, added }] }] }
  ▼
existing installation-grouped repo list (unchanged)
```

Add action: a not-yet-added repo's "Add" → opens `installUrl` (GitHub configure page) in a
new tab. On return + page refresh, the now-installed repo appears both in the modal
(as `added`) and in the existing `/repos` list.

---

## Implementation Units

### U1. GitHub client: list all accessible repositories

**Goal:** Add a read method that returns every repo the signed-in user can access across
personal + org accounts, for the modal's browse list.

**Requirements:** R3, R8

**Dependencies:** none

**Files:**
- `apps/web/lib/github.ts` (add `listAccessibleRepositories` to `GitHubClient`)
- `apps/web/lib/github.test.ts` (tests)

**Approach:** Mirror the existing paginated `listInstallationRepositories`. Call
`GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100`,
paginate up to `MAX_PAGES`, map via the existing `mapRepository`. Reuse the existing
`get()` helper so 401 → `GitHubAuthError` and rate-limit handling are inherited. Returns
`Repository[]` (the existing interface already carries `owner`, `name`, `fullName`,
`private`, `pushedAt`).

**Patterns to follow:** `listInstallationRepositories` pagination loop; `mapRepository`.

**Test scenarios:**
- Happy path: single page of repos → mapped `Repository[]` with correct `fullName`/`private`.
- Pagination: two pages (100 then <100) → both concatenated; stops when a page returns < `PER_PAGE`.
- Bound: a full `MAX_PAGES` of 100 stops at the cap (no unbounded loop).
- Auth: a 401 response → throws `GitHubAuthError`.
- Rate limit: 403 with `x-ratelimit-remaining: 0` → throws `GitHubRateLimitError`.
- Empty: `[]` response → `[]`.

---

### U2. App slug env + install-URL helper

**Goal:** Provide the App slug and a helper that builds GitHub installation/configure URLs.

**Requirements:** R5, R6

**Dependencies:** none

**Files:**
- `.env.example` (add `GITHUB_APP_SLUG`)
- `apps/web/lib/auth/config.ts` (read + expose `appSlug`; or a small `lib/githubApp.ts` helper)
- `apps/web/lib/githubApp.test.ts` (helper tests)

**Approach:** Add `GITHUB_APP_SLUG` to env and `.env.example` (documented as non-secret,
the App's public slug). Add a pure helper `buildInstallUrl(slug, opts?)` returning:
- generic: `https://github.com/apps/<slug>/installations/new`
- per-account: `https://github.com/apps/<slug>/installations/new/permissions?target_id=<accountId>` when an account id is available.
Keep slug reading at request time (not module load), consistent with `loadAuthConfig`'s
fail-at-request posture. Decide one home: extend `AuthConfig` (already the env gateway) vs
a new `lib/githubApp.ts`. Prefer a new small module to avoid bloating auth config with a
non-secret value.

**Patterns to follow:** `loadAuthConfig` env validation; `stripTrailingSlash` pure-helper style.

**Test scenarios:**
- `buildInstallUrl("diffsense-app")` → generic install URL.
- `buildInstallUrl("diffsense-app", { accountId: 42 })` → per-account URL with `target_id=42`.
- Missing slug → helper throws a clear "Missing GITHUB_APP_SLUG" error (so the modal can show a config error, not a broken link).

---

### U3. Dialog UI primitive

**Goal:** Add an accessible modal primitive the feature can compose.

**Requirements:** R2

**Dependencies:** none

**Files:**
- `apps/web/package.json` (add `@radix-ui/react-dialog`)
- `apps/web/components/ui/dialog.tsx` (shadcn-style wrapper: `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogClose`)

**Approach:** Add the dependency and a thin wrapper matching the existing `components/ui`
style (`cn`, CVA where used, Tailwind v4 tokens like `border-border`, `bg-card`). Overlay +
content with focus trap and scroll lock from radix. Keep it generic — no feature specifics.

**Patterns to follow:** existing `components/ui/button.tsx`, `card.tsx` (token usage, `cn`).

**Test scenarios:** `Test expectation: none — generic primitive, no branching behavior. Covered indirectly by U5's modal tests (open/close/focus).`

---

### U4. Server action: load addable repos

**Goal:** Server-only loader that returns the user's accessible repos grouped by account,
annotated with `added` and each account's install URL.

**Requirements:** R3, R4, R5, R6, R8, R9

**Dependencies:** U1, U2

**Files:**
- `apps/web/app/repos/actions.ts` (new server action `loadAddableRepos`)
- `apps/web/app/repos/actions.test.ts` (tests with a fake `GitHubClient`)

**Approach:** `"use server"`. Resolve `requireSession()`. Fetch in parallel:
`listAccessibleRepositories()` and the installed set (`listInstallations()` then
`Promise.allSettled` over `listInstallationRepositories`, reusing the page's resilience
pattern so one org's failure degrades only that group). Build `installedFullNames: Set<string>`.
Group accessible repos by `owner`; for each group resolve `accountType` (org vs user — from
the matching installation account, else default "User") and an `installUrl` (per-account when
an account id is known, else generic). Annotate each repo `added = installedFullNames.has(fullName)`.
Return `{ groups }`. On `GitHubAuthError`, return `{ error: "reauth" }` (R9) rather than
throwing — the modal renders a "sign in again" state. Sort: not-added before added, then by
`pushedAt` desc, so addable repos surface first.

**Patterns to follow:** `apps/web/app/repos/page.tsx` `Promise.allSettled` resilience;
`deck/actions.ts` server-action shape.

**Test scenarios:**
- Happy path: 3 accessible repos, 1 installed → returns groups with `added` true only for the installed one.
- Grouping: repos across a user and an org → two groups with correct `accountType`.
- Install URL: org group gets a per-account URL; falls back to generic when no account id.
- Sorting: not-added repos ordered before added within a group.
- Resilience: one installation's repo fetch rejects (non-auth) → that group still appears, `added` simply false for its repos; no throw.
- Auth: `listAccessibleRepositories` throws `GitHubAuthError` → returns `{ error: "reauth" }`, not a throw.
- Empty: user with no accessible repos → `{ groups: [] }`.

---

### U5. Add Repositories modal (button + modal client component)

**Goal:** The interactive button + modal: lazy-load on open, grouped list, added/not-added
badges, per-repo Add deep-link, filter, loading/error/empty states.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9

**Dependencies:** U3, U4

**Files:**
- `apps/web/components/repos/AddRepositoriesModal.tsx` (client component: trigger button + dialog)
- `apps/web/components/repos/AddRepositoriesModal.test.tsx` (tests)

**Approach:** `"use client"`. A `Button` ("Add repositories", `Plus` icon) as `DialogTrigger`.
On open, call `loadAddableRepos()` (server action) once, holding `idle | loading | loaded |
error` state. Render:
- **loading** → skeleton/spinner rows.
- **error: reauth** → message + link to `/login`.
- **loaded** → a text filter input (R7, client-side, matches `name` or `fullName`,
  case-insensitive) and grouped sections (org/user icon like the page, `Building2`/`User`).
  Each repo row: name, `fullName`, private `Lock` badge (reuse `RepoRow` visual language).
  Added repos show an "Added" badge (and link to `/repos/<owner>/<repo>/pulls`); not-added
  repos show an "Add" button/link → opens the group's `installUrl` in a new tab
  (`target="_blank" rel="noopener"`).
- Footer: "Install on another account" → generic install URL (R6).
- **empty** → "No repositories found" with the install-on-another-account CTA.

Keep server/client boundary clean: the action is imported and invoked from the client per
Next's server-action pattern. Do not pass the OAuth token or env to the client — only the
serialisable result.

**Patterns to follow:** `components/repos/RepoRow.tsx` visuals; `SignOutButton.tsx` /
`deck/SwipeDeck.tsx` for `"use client"` + server-action invocation style; page's
`Building2`/`User` account iconography.

**Execution note:** Component test-first for the state machine (idle→loading→loaded/error)
with a mocked action — the branching is the risk surface.

**Test scenarios:**
- Closed by default; clicking the button opens the dialog (R2) and triggers exactly one `loadAddableRepos` call.
- Loading → loaded transition renders grouped repos.
- Added repo shows "Added" badge + a link to its pulls page; not-added repo shows an "Add" link with the correct `installUrl` and `target="_blank"`.
- Filter: typing narrows visible repos by name and by `owner/name`; clearing restores all.
- Error: action returns `{ error: "reauth" }` → re-auth message + `/login` link, no repo list.
- Empty: `{ groups: [] }` → empty state with install-on-another-account CTA.
- Reopen does not duplicate-fetch unnecessarily (or refetches intentionally — assert the chosen behavior).
- Accessibility: Esc closes; focus moves into the dialog on open (radix-provided, assert dialog role/title present).

---

### U6. Wire the button into the repos page

**Goal:** Place the modal trigger on `/repos` (header + empty state) so it's reachable.

**Requirements:** R1

**Dependencies:** U5

**Files:**
- `apps/web/app/repos/page.tsx` (render `<AddRepositoriesModal/>` in the header actions and inside `EmptyState`)

**Approach:** Add `<AddRepositoriesModal/>` next to the existing "Continue reviewing" link
in the header row, and as the primary CTA inside `EmptyState` (replacing/augmenting the
"install … then refresh" copy with a real button). The page stays a server component; the
modal is a self-contained client island. No data fetching added to the page render (lazy
in the modal per U4/KTD3).

**Patterns to follow:** existing header flex row in `page.tsx`; `EmptyState` composition.

**Test scenarios:** `Test expectation: none — pure composition/wiring. Behavior covered by U5. Verify by rendering /repos and asserting the button is present (smoke).`

---

## Scope Boundaries

**In scope:** the button, the modal, the browse-and-route-to-install flow, accessible repo
listing, added/not-added annotation, filter, env + URL helper, dialog primitive.

### Deferred to Follow-Up Work
- Persisting a per-reviewer "tracked repos" set independent of installations (not needed — installations are the source of truth).
- Webhook-driven live refresh of the modal after an install completes (user refreshes for now).
- Pagination UI for very large accounts beyond `MAX_PAGES × 100` (inherits the existing cap; same deferral as `lib/github.ts`).
- Bulk multi-select "add N repos at once" (GitHub's install screen already handles multi-repo selection per account).

### Out of scope (not this product)
- Any merge/approve/enforcement control (diffsense stays advisory — `STRATEGY.md`).
- Programmatically installing the App without the GitHub installation UI (not possible for GitHub Apps).

---

## System-Wide Impact

- **New env var** `GITHUB_APP_SLUG` — must be set for install links to work; documented in `.env.example`. Without it the modal shows a config error rather than broken links (U2).
- **New dependency** `@radix-ui/react-dialog` in `apps/web` — small, already in the radix family used by the project.
- **No DB / schema changes**, no migrations, no changes to `packages/core` or the worker. Honors the `packages/core`-purity and provider-agnostic rules (this is GitHub-domain web code, not LLM).
- **New GitHub API call** `GET /user/repos` per modal open (paginated, lazy) — bounded by `MAX_PAGES`, inherits the existing 10s per-request timeout and rate-limit handling.

---

## Risks & Dependencies

- **R-risk1 — Users may expect in-app "Add" to instantly enable reviews.** Mitigation: clear copy in the modal that "Add" opens GitHub to grant access; added repos are clearly badged. (KTD1)
- **R-risk2 — `GET /user/repos` can be large for users in many orgs.** Mitigation: `MAX_PAGES` cap (existing), client-side filter, not-added-first sort surfaces the useful repos.
- **R-risk3 — Per-account install URL shape.** GitHub's `target_id` permissions URL is the documented path; if an account id isn't resolvable, fall back to the generic install URL (degrades gracefully, never a dead link).
- **Dependency:** the GitHub App must have "Request user authorization (OAuth) during installation" enabled (already required by issue #25 / `.env.example`).

---

## Verification

- `pnpm --filter @diffsense/web test` green (new unit tests U1, U2, U4, U5).
- `pnpm --filter @diffsense/web build` succeeds (transpilePackages/extensionAlias already configured — see memory `web-imports-core-build-config`).
- Manual: on `/repos`, the "Add repositories" button is visible; clicking opens the modal;
  the modal lists repos grouped by account with added/not-added states; "Add" opens GitHub's
  install page in a new tab; filter narrows the list; Esc closes.

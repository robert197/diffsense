---
title: "feat: Pause & resume review sessions"
type: feat
issue: 29
date: 2026-06-21
status: ready
depth: standard
---

# feat: Pause & resume review sessions (issue #29)

## Summary

Make a swipe-deck review resumable. Today the swipe deck (#27) starts at card 0 on
every load and keeps no per-reviewer state — a reload restarts the review and there is
no way to see what is half-finished. This slice persists, on **every swipe**, the
reviewer's per-card decision (and therefore their position) tied to **user + PR + head
SHA**, so they can stop anytime and pick up at the next unreviewed card — on the same
device or another. It adds a **"Continue reviewing"** dashboard that lists in-progress
reviews with `n / total` progress, and tells the reviewer when the deck they are
resuming was built against an older PR head SHA (the re-process path).

The persistence key is `(githubUserId, owner, repo, prNumber, headSha, fingerprint)`.
Position is **derived** from decisions (the next unreviewed card is the first card with
no decision) rather than stored as a separate cursor — one source of truth, no drift.

---

## Problem Frame

- **Who:** the Reviewer working a deck on the hosted web app (STRATEGY.md primary user).
- **Pain:** a deck is one sitting. Reload, logout, or switching laptop ↔ phone loses the
  place and the decisions. Large PRs are exactly the ones a reviewer wants to pause.
- **Goal:** review state is durable and portable; resuming is exact; a stale deck is
  surfaced, not silently resumed against dead code.
- **Boundary:** advisory only — swipes remain a 👍/👎 signal, never a merge/approve/block
  action. No new authority anywhere on these surfaces (matches #13/#27 posture).

---

## Requirements (from the issue)

| ID | Acceptance criterion | Lands in |
|----|----------------------|----------|
| R1 | Review position and per-card decisions persist on every swipe | U1, U2, U4, U5 |
| R2 | A dashboard lists in-progress reviews with progress (n/total) | U1, U4, U6 |
| R3 | Resuming returns the user to the next unreviewed card | U1, U5 |
| R4 | State survives reload and works across devices for the same user | U2, U4, U5 |
| R5 | If the PR head SHA changed, the user is told the deck is stale (re-process path) | U3, U5 |

---

## Key Technical Decisions

1. **Persist per-card decisions; derive position.** The issue asks to persist both
   "position in a deck" and "per-card decisions." Storing one decision row per card and
   computing the next unreviewed card from it makes position a pure function of decisions
   — no separate cursor that could drift from the decisions, and "resume to next
   unreviewed card" (R3) falls out exactly. `n / total` (R2) is `distinct decided cards in
   deck / deck card count`.

2. **Key by `githubUserId`, not login.** GitHub login can be renamed; the numeric id is
   stable identity. The `web_sessions` row already carries `githubUserId`; expose it on
   `ActiveSession` so the swipe action and dashboard can key writes/reads by user. This is
   what makes state cross-device for the *same user* (R4) and scoped per-reviewer.

3. **Key by `headSha`.** Reuse the deck's own persistence key. A new push yields a new deck
   (#26) and therefore a fresh, empty decision set against the new head — new code is
   re-reviewed from scratch, never silently "resumed." This is the same head-SHA
   invariant decks already use.

4. **Decision value = swipe sentiment (`up`/`down`).** Reuse the existing `swipeSentiment`
   mapping (right = 👍 `up`, left = 👎 `down`). No new vocabulary; consistent with the
   `reactions` precision signal. The progress write is **additive** to the existing
   reaction write in `recordSwipe`, not a replacement — reactions stay append-only (one
   row per swipe, the moat signal); progress is **upsert** (latest decision per card wins).

5. **Two staleness signals for R5, each at the right cost.**
   - *Deck page (resume, authoritative):* fetch the PR's **live** head SHA from GitHub once
     and compare to the resumed deck's `headSha`. Different → stale banner + re-process
     guidance. This is the "PR head SHA changed" check.
   - *Dashboard (cheap, DB-only):* a progress group whose `headSha` ≠ the PR's **latest
     persisted deck** `headSha` is flagged stale, with no GitHub fan-out across many PRs.
   Together they satisfy R5 without an N+1 GitHub burst on the dashboard.

6. **Pure logic in `core`, DB access in `apps/web` — follow the #27 precedent.** The
   resume math (`resumeState`) and the decision schema are pure domain → `packages/core`
   (no vendor import, deterministic — fits the "pipeline is deterministic" rule). The DB
   reads/writes live in `apps/web/lib/reviewProgress.ts`, exactly as `lib/deck.ts` and
   `lib/findings.ts` already read the shared Postgres directly without routing through a
   `core` port. No new `LLMProvider` use anywhere — this slice calls no model.

7. **Canonical schema + migration in `apps/app`; web mirrors it.** The `review_progress`
   table is declared in `apps/app/src/db/schema.ts` with migration `0009`, and mirrored in
   `apps/web/lib/db.ts` — the same lockstep split `decks`, `web_sessions`, and
   `card_localizations` already use (a shared schema package is still deferred).

---

## High-Level Technical Design

State flow on a single swipe and on a later resume:

```
SWIPE (every card)
  SwipeDeck (client) --FormData{owner,repo,prNumber,headSha,fingerprint,tier,sentiment}-->
  recordSwipe action (re-checks session → githubUserId)
    ├─ reactions.insert      (existing precision signal, append-only)
    └─ review_progress UPSERT (githubUserId,owner,repo,pr,headSha,fingerprint) := decision

RESUME (deck page load)
  getLatestDeck(pr) ─► deck (cards, headSha)
  getDecidedFingerprints(user, pr, deck.headSha) ─► Set<fingerprint>
  resumeState(deck.cards, decided) ─► { total, reviewed, nextIndex, complete }
  github.getPullRequestHead(pr) ─► liveHeadSha   (stale = liveHeadSha !== deck.headSha)
  <SwipeDeck initialIndex=nextIndex initialCounts=… headSha=deck.headSha stale=… />

DASHBOARD (/reviews)
  progressRows(user) + decks(user's PRs) ─► summarizeInProgress(...)
    per group: reviewed/total via resumeState; stale = headSha !== latest deck head
    keep reviewed>0 && reviewed<total ─► rows: owner/repo #n · n/total · [stale?]
```

`resumeState` is the single shared kernel: the deck page uses it for `nextIndex`, the
dashboard uses it for `reviewed/total`.

---

## Implementation Units

### U1. Core: review-progress schema + pure resume kernel

**Goal:** the deterministic, vendor-free heart — the decision schema and the function that
turns a deck + a set of decided fingerprints into resume state.

**Requirements:** R1, R2, R3.

**Dependencies:** none.

**Files:**
- `packages/core/src/deck/reviewProgress.ts` (new)
- `packages/core/src/deck/reviewProgress.test.ts` (new)
- `packages/core/src/index.ts` (export the new symbols)

**Approach:**
- `CardDecisionSchema = z.object({ fingerprint: z.string().min(1), decision: z.enum(["up","down"]) })`; export `type CardDecision`.
- `resumeState(cards: Card[], decided: Iterable<string>): { total: number; reviewed: number; nextIndex: number; complete: boolean }`:
  - `total = cards.length`; build a `Set` from `decided`.
  - `reviewed` = count of cards whose `fingerprint` ∈ set (distinct *cards in the deck*, so
    a decided fingerprint not present in this deck does not inflate the count).
  - `nextIndex` = index of the first card whose fingerprint ∉ set, else `total`.
  - `complete = total > 0 && reviewed === total`.
- Keep it allocation-light and order-preserving (cards are already rank-ordered).

**Patterns to follow:** sibling pure modules `packages/core/src/deck/buildDeck.ts` and
`packages/core/src/schemas/card.ts`; export style in `packages/core/src/index.ts`.

**Test scenarios** (`reviewProgress.test.ts`):
- Covers R3. Empty decided set → `nextIndex 0`, `reviewed 0`, `complete false`.
- Covers R3. Some decided (non-contiguous, e.g. cards 0 and 2 decided) → `nextIndex` is the
  first *undecided* card (1), not "after the last decided."
- Covers R3. First card decided, rest not → `nextIndex 1`.
- Covers R2. All cards decided → `reviewed === total`, `nextIndex === total`, `complete true`.
- Covers R2. A decided fingerprint absent from the deck is ignored (does not raise `reviewed`).
- Empty deck (`cards: []`) → `total 0`, `reviewed 0`, `nextIndex 0`, `complete false` (no
  false "complete" on an empty deck).
- Duplicate fingerprint across two cards → deciding it marks both as reviewed (documented
  consequence of fingerprint-keying, consistent with reactions/localizations).
- `CardDecisionSchema` rejects empty fingerprint and an out-of-set decision; accepts `up`/`down`.

---

### U2. DB: `review_progress` table (canonical + web mirror)

**Goal:** the durable store keyed to user + PR + head SHA + card.

**Requirements:** R1, R4.

**Dependencies:** none (independent of U1).

**Files:**
- `apps/app/src/db/schema.ts` (add `reviewProgress` table)
- `apps/app/src/db/migrations/0009_review_progress.sql` (new)
- `apps/app/src/db/migrations/meta/_journal.json` (append entry idx 9, tag `0009_review_progress`)
- `apps/web/lib/db.ts` (mirror `reviewProgress`; add to the `schema` object)

**Approach:**
- Columns: `id serial PK`, `github_user_id integer NOT NULL`, `owner text NOT NULL`,
  `repo text NOT NULL`, `pr_number integer NOT NULL`, `head_sha text NOT NULL`,
  `fingerprint text NOT NULL`, `decision text NOT NULL`,
  `updated_at timestamptz NOT NULL DEFAULT now()`.
- `UNIQUE (github_user_id, owner, repo, pr_number, head_sha, fingerprint)` — the upsert
  target; one decision per card per reviewer per head. This unique index also serves the
  deck-page read (its prefix is `github_user_id, owner, repo, pr_number, head_sha`).
- Index `review_progress_user_idx` on `(github_user_id)` for the dashboard listing.
- SQL file mirrors the `CREATE TABLE IF NOT EXISTS … --> statement-breakpoint … CREATE
  INDEX IF NOT EXISTS …` shape of `0008_card_localizations.sql`. Journal `when` continues
  the +86400000 cadence after `0008` (1782604800000).
- Web mirror copies the Drizzle table verbatim (snake↔camel column names) with the same
  unique + index, and adds `reviewProgress` to `const schema = { … }`.

**Patterns to follow:** `decks` / `card_localizations` declarations in
`apps/app/src/db/schema.ts` and their mirrors in `apps/web/lib/db.ts`; migration shape in
`apps/app/src/db/migrations/0008_card_localizations.sql`; journal format in
`apps/app/src/db/migrations/meta/_journal.json`.

**Test expectation:** none — pure schema/migration (no behavioral logic). Verified by
`db:migrate` applying cleanly and downstream unit tests in U4 asserting the write/read
contract against mocked Drizzle.

**Verification:** `pnpm db:migrate` against the local Postgres (port 5433 per project
memory) applies `0009` with no error; the table and constraints exist.

---

### U3. Adapter extensions: session user id + live PR head SHA

**Goal:** expose the two facts the resume + staleness paths need — the reviewer's stable
id and the PR's current head SHA.

**Requirements:** R4 (user id), R5 (live head SHA).

**Dependencies:** none.

**Files:**
- `apps/web/lib/auth/session.ts` (add `userId` to `ActiveSession`; set from `row.githubUserId`)
- `apps/web/lib/auth/session.test.ts` (assert `userId` is surfaced)
- `apps/web/lib/github.ts` (add `getPullRequestHead` to `GitHubClient` + impl + mapper)
- `apps/web/lib/github.test.ts` (cover the new method)

**Approach:**
- `ActiveSession.userId: number` — populated in `getSession()` from the session row's
  `githubUserId`. No new query; the row is already loaded.
- `getPullRequestHead(owner, repo, prNumber): Promise<{ headSha: string } | null>` —
  `GET /repos/{owner}/{repo}/pulls/{number}`, return `{ headSha: data.head.sha }`. `404`
  (PR gone) → `null`; `401` → `GitHubAuthError` (existing convention); rate-limit →
  `GitHubRateLimitError`; other non-OK → throw, matching the existing `get()` helper. Path
  segments `encodeURIComponent`-escaped like the sibling calls.

**Patterns to follow:** existing `GitHubClient` methods and `mapPullRequest`/`asRecord`
helpers in `apps/web/lib/github.ts`; the `getFileAtRef` error-class discipline.

**Test scenarios:**
- `github.test.ts` — `getPullRequestHead` returns `{ headSha }` from a stubbed
  `head.sha`; maps `401 → GitHubAuthError`; maps a rate-limited `403 → GitHubRateLimitError`;
  returns `null` on `404`.
- `session.test.ts` — a resolved session exposes `userId` equal to the row's
  `githubUserId` (extend the existing happy-path assertion).

---

### U4. Web progress store: write, read, and dashboard summary

**Goal:** the `apps/web` DB helper that records a decision, reads a deck's decided set, and
summarizes a reviewer's in-progress reviews.

**Requirements:** R1, R2, R4, R5 (dashboard staleness).

**Dependencies:** U1 (uses `resumeState`), U2 (the table + mirror), U3 not required.

**Files:**
- `apps/web/lib/reviewProgress.ts` (new)
- `apps/web/lib/reviewProgress.test.ts` (new)

**Approach:**
- `recordDecision({ githubUserId, owner, repo, prNumber, headSha, fingerprint, decision }): Promise<void>`
  — `insert(reviewProgress).values(...).onConflictDoUpdate({ target: [the 6 key cols], set: { decision, updatedAt: new Date() } })`. Latest decision per card wins.
- `getDecidedFingerprints({ githubUserId, owner, repo, prNumber, headSha }): Promise<CardDecision[]>`
  — select `fingerprint, decision` for the key prefix; return the decisions. The deck page
  derives the `Set<fingerprint>` (for `resumeState`) and the up/down counts from this.
- `summarizeInProgress(progressRows, deckRows): InProgressReview[]` — **pure**, exported,
  unit-tested without a DB (mirrors `latestDeckFromRows`):
  - group progress rows by `(owner, repo, prNumber, headSha)` → decided set + max `updatedAt`.
  - per `(owner, repo, prNumber)`, resolve the latest deck head (newest `createdAt`, ties by
    `id`) — reuse the same newest-row rule as `latestDeckFromRows`.
  - per group: find the deck row for that exact `headSha`; skip if absent (cannot show
    `n/total`). `{ total, reviewed } = resumeState(deck.cards, decided)`. Skip when
    `reviewed === total` (completed) or `reviewed === 0`. `stale = headSha !== latestHead`.
  - return rows `{ owner, repo, prNumber, headSha, reviewed, total, stale, updatedAt }`
    sorted by `updatedAt` desc. Malformed `deck.cards` (schema-parse failure) → skip that
    group, logged, never throw (same defensive posture as `latestDeckFromRows`).
- `listInProgress(githubUserId): Promise<InProgressReview[]>` — load the user's progress
  rows, load decks for the touched `(owner, repo, prNumber)` set, hand both to
  `summarizeInProgress`.

**Patterns to follow:** `apps/web/lib/deck.ts` (`recordSwipe` insert shape;
`latestDeckFromRows` newest-row + safe-parse discipline); `apps/web/lib/localize.ts`
upsert via `onConflictDoUpdate`; the mock-Drizzle test style in
`apps/web/lib/deck.test.ts` and `apps/web/lib/localizeStore.test.ts`.

**Test scenarios** (`reviewProgress.test.ts`):
- Covers R1. `recordDecision` upserts with the 6-column key and `decision`/`updatedAt` set
  (assert the captured `values` + `onConflictDoUpdate` target via the mock).
- Covers R2/R3. `summarizeInProgress`: one PR, deck of 3 cards, 1 decided → row with
  `reviewed 1, total 3, stale false`.
- Covers R2. Completed group (all decided) is excluded from the list.
- Zero-decision group is excluded (`reviewed 0`).
- Covers R5. A group whose `headSha` ≠ the PR's latest deck head → `stale true`; the
  latest-head group for the same PR is `stale false`.
- Group with no matching deck row → skipped (no crash).
- Malformed `cards` payload for a group → skipped + logged, other groups still returned.
- Multiple groups sorted by `updatedAt` desc.

---

### U5. Swipe persistence + resume wiring (deck page, action, component)

**Goal:** write progress on every swipe, resume at the next unreviewed card, and surface a
stale-deck banner.

**Requirements:** R1, R3, R4, R5.

**Dependencies:** U1, U2, U3, U4.

**Files:**
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.ts` (write progress in `recordSwipe`)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/SwipeDeck.tsx` (new props + `headSha` in FormData)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/SwipeDeck.test.tsx` (resume + headSha coverage)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.test.ts` (progress write coverage)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/page.tsx` (read decisions, compute resume, stale check, pass props)

**Approach:**
- **Action (`recordSwipe`):** capture `const session = await getSession(); if (!session) return;`.
  Read `headSha` from the FormData and validate it non-empty alongside the existing checks.
  After the existing `reactions` write, call
  `recordDecision({ githubUserId: session.userId, owner, repo, prNumber, headSha, fingerprint, decision: sentiment })`
  inside its own try/catch — a failed progress write is logged, never thrown (advisory;
  fire-and-forget from the client), exactly like the reaction write. If `headSha` is
  missing/empty, skip the progress write but still record the reaction (backward-safe).
- **Component (`SwipeDeck`):** add props `headSha: string`, `initialIndex?: number`,
  `initialCounts?: { up: number; down: number }`. Seed `useState(initialIndex ?? 0)` and
  `useState(initialCounts ?? { up: 0, down: 0 })`. Add `fd.set("headSha", headSha)` to the
  FormData built in `commit`. No change to the gesture/animation/guard logic. When
  `initialIndex >= total`, the existing `!current` branch renders `DeckDone` immediately
  (resume into a finished deck).
- **Page (`DeckPage`):** after `getLatestDeck`, when a deck exists:
  - `const decisions = await getDecidedFingerprints({ githubUserId: session.userId, owner, repo, prNumber, headSha: deck.headSha })`.
  - `const { nextIndex } = resumeState(deck.cards, decisions.map(d => d.fingerprint))`;
    compute `initialCounts` from decisions whose fingerprint is in the deck.
  - **Stale check:** `try { const live = await session.github.getPullRequestHead(owner, repo, prNumber); stale = !!live && live.headSha !== deck.headSha } catch (GitHubAuthError) { clearSessionRow(); redirect("/login") } catch { /* rate-limit/transient → leave stale=false, render normally */ }`.
  - Render a stale banner above the deck when `stale` (plain advisory copy: the deck was
    built against an earlier commit; a fresh deck appears once the new commit is processed;
    a Refresh/reload affordance). Pass `headSha`, `initialIndex=nextIndex`,
    `initialCounts` to `<SwipeDeck>`.

**Patterns to follow:** the existing `recordSwipe` validate-then-write structure in
`actions.ts`; the auth-error → `clearSessionRow` + `redirect` handling already in
`page.tsx`/`buildCardViews`; the `SwipeDeck.test.tsx` jsdom harness (`renderDeck`,
`firePointer`, `setReducedMotion`).

**Test scenarios:**
- `actions.test.ts` (new): Covers R1. A valid swipe with `headSha` writes a progress
  decision keyed by `githubUserId + owner + repo + prNumber + headSha + fingerprint` with
  the swipe sentiment (mock `getSession` → `{ userId }`, mock `recordDecision`). A swipe
  with empty `headSha` skips the progress write but still records the reaction. An
  unauthenticated call is a no-op. (Mock `lib/auth/session`, `lib/deck`, and
  `lib/reviewProgress`.)
- `SwipeDeck.test.tsx` (extend): Covers R3. `initialIndex = 2` renders the 3rd card first
  and the progress bar reads `2 / N`. Covers R1/R4. A swipe posts FormData that includes
  `headSha`. `initialIndex >= total` renders the completion state. `initialCounts` seeds
  the done-screen tally. Existing tests updated to pass the new required `headSha` prop.

**Verification:** swiping records a row; reloading the deck resumes at the next undecided
card; with a divergent live head SHA the banner shows.

---

### U6. "Continue reviewing" dashboard

**Goal:** a page listing the reviewer's in-progress reviews with `n / total` progress and a
resume link, reachable from the signed-in entry path.

**Requirements:** R2, R5 (stale badge).

**Dependencies:** U3 (session `userId`), U4 (`listInProgress`).

**Files:**
- `apps/web/app/reviews/page.tsx` (new server component)
- `apps/web/app/page.tsx` (signed-in: add a "Continue reviewing" link)
- `apps/web/app/repos/[owner]/[repo]/pulls/page.tsx` *or* `apps/web/app/repos/page.tsx`
  (add a header link to `/reviews`) — pick `repos/page.tsx` (the post-login landing).

**Approach:**
- `ReviewsPage` (`export const dynamic = "force-dynamic"`): `requireSession()` →
  `listInProgress(session.userId)`. Render each entry as a tappable row linking to
  `/pr/{owner}/{repo}/{prNumber}/deck`, showing `{owner}/{repo} #{prNumber}`, a
  `reviewed / total cards` label + a thin progress bar (reuse the deck's progress-bar
  visual idiom / `TIER_COLOR`-free neutral fill), a `Stale` badge when `stale`, and a
  relative `updated` time (`relativeTime`). Empty state: "No reviews in progress — swipe a
  PR's deck and your place is saved here."
- Reuse shared styles from `apps/web/lib/ui.ts` (`page`, `list`, `row`, `muted`, `badge`,
  `relativeTime`). Mobile-first, ≥44px rows, advisory copy, no merge controls.
- Add "Continue reviewing →" to the signed-in block of `app/page.tsx` and a header link on
  the repos page so the dashboard is discoverable from the entry path.

**Patterns to follow:** `apps/web/app/repos/[owner]/[repo]/pulls/page.tsx` (list of
tappable rows, `requireSession`, `force-dynamic`); `apps/web/app/page.tsx` signed-in block;
`apps/web/lib/ui.ts` styles.

**Test expectation:** none for the server component itself — consistent with this repo,
server components doing I/O are not unit-tested; the load-bearing logic (`summarizeInProgress`)
is covered in U4. Keep the page a thin render over `listInProgress`.

**Verification:** with in-progress decisions present, `/reviews` lists the PR with the
correct `n / total`, links into the deck, and badges a superseded head as stale.

---

## Scope Boundaries

**In scope:** per-card decision persistence on swipe; derived resume position; the
`/reviews` dashboard with `n/total` + stale badge; deck-page resume + live-head stale
banner; the `review_progress` table; the small session/github adapter extensions.

### Deferred to Follow-Up Work
- Triggering re-processing of a stale PR from the UI (a "Re-review now" button that enqueues
  #26 on demand). This slice **tells** the reviewer the deck is stale and lets the engine's
  existing path produce the fresh deck; it does not add a new trigger. The dashboard/banner
  copy points at the re-process path without owning it.
- Authorization (does this session user have access to *this* repo/PR?) — the known
  cross-cutting gap shared with the #13 `refute` and #27 swipe actions. `review_progress`
  carries no merge/approve authority; residual impact is per-user state scoped to a user
  who must already be signed in. Out of scope here, same as the prior slices.
- A shared schema package to remove the `apps/app` ↔ `apps/web` table mirror — still deferred.
- "Completed reviews" history / analytics on the dashboard — only *in-progress* is listed.

**Outside this product's identity:** any merge-gating, approve/block, or manager-facing
surveillance of who has/hasn't finished a review (STRATEGY.md "Not working on").

---

## Risks & Mitigations

- **Extra GitHub call per deck load (live head SHA).** Mitigation: one `GET pulls/{n}` call,
  wrapped so rate-limit/transient failures skip the stale check and still render the deck;
  only `401` is fatal (existing session-clear path). No fan-out.
- **Dashboard deck fetch breadth.** `listInProgress` loads decks for the PRs the user has
  touched; bounded by the user's own in-progress set. Acceptable for the slice; a fuller
  paginated dashboard is deferred. `summarizeInProgress` is pure and skips malformed/missing
  deck rows rather than throwing.
- **Fingerprint collisions within a deck.** Deciding a shared fingerprint marks both cards —
  consistent with reactions/localizations keying and documented in U1 tests. Acceptable.
- **Backward compatibility.** Older client posts without `headSha` still record the reaction;
  progress write is skipped, never errors.

---

## Test & Verification Strategy

- Unit (Vitest, `pnpm test`): U1 `resumeState`/schema; U3 github method + session userId;
  U4 `recordDecision` + `summarizeInProgress`; U5 `recordSwipe` action + `SwipeDeck` resume.
- Migration: `pnpm db:migrate` applies `0009` against local Postgres (port 5433).
- Lint/format/types: `pnpm lint`, `pnpm typecheck` clean.
- The non-negotiables hold: no vendor SDK enters `packages/core`; no `LLMProvider` use is
  added; ranking/selection/delivery stay untouched (this slice is read-model + persistence
  only); self-host unaffected (plain Postgres table).

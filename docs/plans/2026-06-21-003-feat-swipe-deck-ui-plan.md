---
title: "feat: Swipe deck UI (mobile-first)"
type: feat
issue: 27
date: 2026-06-21
depth: standard
status: ready
---

# feat: Swipe deck UI (mobile-first) — Issue #27

## Summary

Build the swipe deck review surface in `apps/web` — the heart of the product. A PR's
persisted Deck (`decks` table, produced by #26) renders as a stack of swipeable cards:
mobile-first with touch gestures, fully usable on desktop with click + keyboard. Each card
shows the highlighted code lines to scrutinize, the structural risk score/tier, the
"what could be wrong" suggestions, and the plain-language explanation. Swiping advances the
deck and records a per-card review decision (👍 looks good / 👎 flag) through the same
`reactions` precision-signal store the engine already learns from. A progress indicator
communicates the goal: by the end of the deck every changed hunk has been seen, attention
pulled to the risky parts first.

This is a read-model UI slice over the shared Postgres `decks`/`reactions` tables plus a
bounded GitHub content read to render real code. It does **not** touch `packages/core`
domain logic, the deterministic pipeline, or the LLM port. New web route lives beside the
existing #13 static card view, which stays intact.

---

## Problem Frame

STRATEGY.md's bet is that the scarce resource is **reviewer attention**, not AI output. #26
produced the ordered Deck (one card per changed hunk, ranked by structural risk) but left it
headless — persisted, re-fetchable, but with no reviewer-facing surface. #27 is that surface:
the swipe affordance that lets a reviewer move through the whole deck quickly, with the riskiest
changes first, recording a lightweight decision per card. The research grounding (Poulain et al.,
2021) warns that expert developers resist heavy game mechanics — so the swipe must **reduce
friction**, not add novelty. Motion is present but never blocks the next card.

**Current state:** `apps/web` is a Next.js 15 / React 19 read-model. It has GitHub OAuth + a
session-bound REST client (#25), a static findings list at `/pr/[owner]/[repo]/[number]` (#13),
and Drizzle access to shared Postgres declaring the `findings` + `reactions` tables in lockstep
(`apps/web/lib/db.ts`). The `decks` table exists (migration `0007_decks`) and is written by the
app worker; nothing in `apps/web` reads it yet.

---

## Requirements

Traceable to issue #27 acceptance criteria (AC#1–AC#6):

- **AC#1** — A PR's deck renders as swipeable cards on mobile and desktop.
- **AC#2** — Each card shows highlighted code, risk score, suggestions, and plain-language explanation.
- **AC#3** — Swiping advances and records a per-card review decision.
- **AC#4** — Progress toward "whole deck reviewed" is visible.
- **AC#5** — Touch gestures (mobile) and click/keyboard (desktop) both work.
- **AC#6** — Motion / micro-interactions present but never block reviewing.

**Non-negotiable repo rules honored (no change needed, but constrain the design):**
- `packages/core` imports no vendor SDK — **untouched**; web only *imports* core's pure Zod
  schemas (`Card`, `Deck`), which is allowed and is the intended use of the shared pure layer.
- LLM access only through the `LLMProvider` port — this slice makes **no LLM calls**.
- Deterministic pipeline; agentic only in the review unit — this slice is **pure read-model UI**,
  changes nothing in the pipeline.
- Self-host only, provider-agnostic — **no new runtime npm dependency**; gestures/animation are
  native Pointer Events + CSS. The only new web dep is the in-repo `@diffsense/core` workspace
  package (pure, vendor-free).

---

## Key Technical Decisions

**KTD-1 — Read the Deck, not the findings.** The swipe surface renders the `decks` table (the
#26 Deck: a card for *every* changed hunk, ranked, with highlight ranges + risk score), not the
`findings` table (#13: only reviewed chunks). A card exists for all changed code, so swiping the
whole deck means every changed line was seen — exactly AC#1/AC#4's "whole deck reviewed" goal.
`apps/web` declares the `decks` table locally in `lib/db.ts` (lockstep with `apps/app`'s schema,
matching the existing `findings`/`reactions` precedent) and reads the **latest** deck row for the
PR (newest `created_at`), since the web reader does not know the head SHA up front.

**KTD-2 — Import card schemas from `@diffsense/core`.** Add `@diffsense/core` (`workspace:*`) to
`apps/web` and validate the stored `cards` JSON against `CardSchema`, reusing the exact pure shape
the engine wrote. Core exports raw TS (`exports: ./src/index.ts`), so Next must transpile it: add
`transpilePackages: ["@diffsense/core"]` to `next.config.mjs`. This keeps one source of truth for
the card shape rather than re-declaring it. Validation runs **server-side only**; the client swipe
component receives plain serializable card data (no `zod`/core import reaches the client bundle).

**KTD-3 — Render real code via a bounded, injectable GitHub content read.** The persisted `Card`
deliberately carries highlight *ranges* (`{side, start, end}`) but not source text. To satisfy
AC#2 ("highlighted code"), the deck page fetches each changed file's content **at the deck's head
SHA** through a new injectable method on the existing GitHub client (`getFileAtRef`, contents API,
raw media type), then a **pure** `buildCodeWindow` helper slices the highlighted line ranges (plus
a few context lines) and marks which lines are highlighted. Fetches are **deduped per file** and
**capped** (`MAX_CODE_FETCHES`) so a large PR cannot fan out unbounded GitHub calls. Every failure
mode degrades gracefully (file deleted, binary, 404, rate-limit, deletion-only `L`-side card → no
head-side lines): the card still renders its highlight ranges descriptively + risk + suggestions +
explanation, and never throws. Right-side (`R`) highlights map directly to absolute line numbers in
the head file; left-side (`L`, pure deletions) render as a "N lines removed" note.

**KTD-4 — A swipe records a reaction through the existing precision-signal store.** Swipe-right =
"looks good" = `sentiment: "up"`; swipe-left = "flag / needs attention" = `sentiment: "down"`. The
decision is written to the append-only `reactions` table keyed by `card.fingerprint` + `card.tier`
— the same store the ranked comment and fingerprint cache already feed (ARCHITECTURE.md §6: reactions
write back through the shared store, no divergence). A new server action `recordSwipe` mirrors the
existing `refute` action. Strictly advisory: a swipe is a signal, never a merge/approve/block.

**KTD-5 — Per-session progress, no new per-reviewer state table.** "Whole deck reviewed" progress
(AC#4) is tracked as **client component state** (count of cards swiped this session / total). The
durable artifact is the per-card reaction (KTD-4); persisting resumable per-reviewer review-state
would be a new table and a new concept — out of scope for this slice. The progress bar/counter is
derived from local state.

**KTD-6 — Native gestures + CSS motion, zero new runtime dep.** The swipe interaction is a `"use
client"` component using **Pointer Events** (which unify touch + mouse) for drag, an arrow-key /
button affordance for desktop, and **CSS transforms + transitions** for the card fly-off and stack
motion. No `framer-motion`/`@use-gesture` — keeps the self-host dependency surface minimal, avoids
lockfile/CI churn, and is fully deterministic. Recording fires through `startTransition` so the
network write never blocks the advance animation (AC#6).

**KTD-7 — New sibling route, #13 untouched.** The swipe deck lives at
`/pr/[owner]/[repo]/[number]/deck`; the existing `/pr/[owner]/[repo]/[number]` static findings view
(#13) is left exactly as-is. The two surfaces cross-link. This keeps #27 a clean additive slice and
does not modify another issue's delivered surface.

**KTD-8 — Logic in pure, unit-tested helpers; component is thin wiring.** All decision logic
(`buildCodeWindow`, swipe-direction → sentiment, drag-distance → commit threshold, next-index +
progress math, latest-deck selection/validation) lives in pure functions with Vitest tests in
`apps/web/lib`. The client component is wiring over those helpers. `apps/web` already runs Vitest
(`lib/*.test.ts`); no new test infrastructure is added. End-to-end gesture behavior in a real
browser is verified by the pipeline's browser-test step, not by adding a component test runner.

---

## High-Level Technical Design

```
 Browser (mobile/desktop)
   /pr/{owner}/{repo}/{number}/deck
        │
        ▼
 ┌─────────────────────────────────────────────┐
 │ deck/page.tsx  (server component)            │
 │  requireSession() ─ auth (reuse #25)         │
 │  getLatestDeck(prRef) ─► decks table (Drizzle)│
 │  for each card (deduped/capped):             │
 │     github.getFileAtRef(file, headSha)       │
 │     buildCodeWindow(lines, highlights)       │  ◄ pure
 │  → CardView[] (plain serializable data)      │
 └───────────────┬─────────────────────────────┘
                 │ props (cards + server action)
                 ▼
 ┌─────────────────────────────────────────────┐
 │ SwipeDeck.tsx  ("use client")                │
 │  Pointer Events drag ─ CSS transform         │
 │  Arrow keys / buttons (desktop)              │
 │  swipe ─► startTransition(recordSwipe)       │  ─► reactions table
 │  advance index, update progress bar          │
 │  end-of-deck "all reviewed" summary          │
 └─────────────────────────────────────────────┘

 swipe right = 👍 up      swipe left = 👎 down   (advisory signal only)
```

Data flow is one-directional: server reads/validates the deck and resolves code windows, hands
plain data + a server action to the client; the client owns gesture/animation/progress and fires a
fire-and-forget reaction write per swipe.

---

## Output Structure

```
apps/web/
  app/pr/[owner]/[repo]/[number]/deck/
    page.tsx          # server: load deck + code windows, render SwipeDeck
    actions.ts        # server action: recordSwipe
    SwipeDeck.tsx     # "use client": gestures, animation, progress
  lib/
    deck.ts           # getLatestDeck + recordSwipe DB read/write (read-model)
    deck.test.ts
    codeWindow.ts     # pure: buildCodeWindow, swipe→sentiment, threshold, progress
    codeWindow.test.ts
    db.ts             # + decks table declaration (modified)
    github.ts         # + getFileAtRef method (modified)
    github.test.ts    # + getFileAtRef tests (modified)
  next.config.mjs     # + transpilePackages: ["@diffsense/core"] (modified)
  package.json        # + @diffsense/core workspace dep (modified)
```

---

## Implementation Units

### U1. Web reads the latest Deck (read-model + core schema wiring)

**Goal:** Give `apps/web` a typed, validated read of a PR's most recent Deck from shared Postgres.

**Requirements:** AC#1, AC#2 (data source for both).

**Dependencies:** none.

**Files:**
- `apps/web/package.json` — add `"@diffsense/core": "workspace:*"`.
- `apps/web/next.config.mjs` — add `transpilePackages: ["@diffsense/core"]`.
- `apps/web/lib/db.ts` — declare the `decks` table (lockstep with `apps/app/src/db/schema.ts`:
  `id, owner, repo, pr_number, head_sha, cards jsonb, created_at`, unique on
  `(owner, repo, pr_number, head_sha)`), add it to the `schema` object.
- `apps/web/lib/deck.ts` — `getLatestDeck({owner, repo, prNumber})`: select the newest `decks`
  row for the PR (`orderBy created_at desc, id desc`, `limit 1`); if none, return `null`; else
  validate `{owner, repo, prNumber, headSha, cards}` against core's `DeckSchema` and return the
  parsed `Deck`. Mirror the lazy-`getDb` and shape of `lib/findings.ts`.
- `apps/web/lib/deck.test.ts` — tests for the validation/selection logic.

**Approach:** Follow the `lib/findings.ts` + `lib/db.ts` precedent exactly (web re-declares only
the tables it touches; lazy Drizzle singleton). Import `DeckSchema`/`CardSchema`/`Card`/`Deck`/
`HighlightRange` from `@diffsense/core`. To keep the DB query thin and the logic testable, extract
a pure `selectLatestDeck(rows, ref) → Deck | null` (validate + parse) that the test drives with
fixture rows; the exported `getLatestDeck` is the query + a call to it.

**Patterns to follow:** `apps/web/lib/findings.ts` (`listFindings`), `apps/web/lib/db.ts`
(`findings`/`reactions`/`webSessions` table declarations + `getDb`).

**Test scenarios:**
- A valid stored row → parses to a `Deck` with cards in their stored order. *Covers AC#1.*
- Zero rows for the PR → `null` (drives the empty state).
- Multiple rows (two head SHAs) → the newest `created_at` wins.
- A malformed `cards` payload (e.g., missing `explanation`) → throws/`ZodError` (loud failure,
  matching the deck adapter's parse-on-read contract), not a silent broken deck.

**Verification:** `getLatestDeck` returns a validated `Deck` for a seeded row and `null` for an
unknown PR; `pnpm test`, `biome check`, and `tsc` pass with the new core import resolving in both
the Next build and Vitest.

---

### U2. Pure card-render helpers (code window, swipe semantics, progress)

**Goal:** All deck UI logic as pure, unit-tested functions so the client component is thin wiring.

**Requirements:** AC#2, AC#3, AC#4, AC#5.

**Dependencies:** U1 (uses `Card`/`HighlightRange` types from core).

**Files:**
- `apps/web/lib/codeWindow.ts`:
  - `buildCodeWindow(fileLines: string[], highlights: HighlightRange[], context = 3)` → an ordered
    list of `{ number, text, highlighted }` for the union of `R`-side ranges expanded by `context`
    lines and clamped to file bounds, with overlapping/adjacent ranges merged; returns `null` when
    there are no renderable head-side lines (only `L`-side highlights, or empty highlights).
  - `swipeSentiment(direction: "right" | "left")` → `"up" | "down"` (KTD-4).
  - `commitThreshold(...)` → given drag distance + card width, whether a drag commits a swipe vs.
    snaps back (the desktop/mobile shared gesture rule).
  - `deckProgress(reviewedCount, total)` → `{ done, total, percent }` for the indicator.
  - `deletionSummary(highlights)` → count of `L`-side removed lines for the degraded note.
- `apps/web/lib/codeWindow.test.ts`.

**Approach:** Keep these dependency-free (operate on arrays/primitives + the core `HighlightRange`
type). The code window only ever references the **new** (head) file, so it uses `R`-side ranges;
`L`-side handling is the deletion summary. Merge ranges before slicing to avoid duplicated/over-
lapping context windows.

**Patterns to follow:** `apps/web/lib/ui.ts` `relativeTime` (small pure helper + colocated test),
`apps/web/lib/ui.test.ts`.

**Test scenarios:**
- Single `R` range mid-file → window includes `context` lines above/below, clamped at file start/end;
  only the in-range line numbers are `highlighted: true`. *Covers AC#2.*
- Two overlapping/adjacent `R` ranges → merged into one contiguous window, no duplicate lines.
- Range at line 1 and range at EOF → no negative/out-of-bounds indices.
- Only `L`-side highlights (deletion-only card) → `buildCodeWindow` returns `null`; `deletionSummary`
  returns the removed-line count. *Covers AC#2 degraded path.*
- Empty highlights → `null` (no-op hunk renders explanation/suggestions only).
- `swipeSentiment("right") === "up"`, `swipeSentiment("left") === "down"`. *Covers AC#3.*
- `commitThreshold`: a drag past the threshold commits; below snaps back (both directions). *Covers AC#5.*
- `deckProgress(0, n) → 0%`; `deckProgress(n, n) → 100%`, `done === total`; guards `total === 0`. *Covers AC#4.*

**Verification:** Helper unit tests green; no React/DOM imported in this module (keeps it trivially
testable and client-bundle-safe).

---

### U3. GitHub file-content read (`getFileAtRef`)

**Goal:** Fetch a file's text at a specific commit so the deck can render real highlighted code.

**Requirements:** AC#2.

**Dependencies:** none (extends the #25 client).

**Files:**
- `apps/web/lib/github.ts` — add `getFileAtRef(owner, repo, path, ref): Promise<string | null>` to
  `GitHubClient`: GET `/repos/{owner}/{repo}/contents/{path}?ref={ref}` with
  `Accept: application/vnd.github.raw+json`, returning the raw text; return `null` on 404 (file
  absent at ref) or non-text/binary; reuse the existing `GitHubAuthError`/`GitHubRateLimitError`
  mapping, timeout, and injectable `fetchImpl`.
- `apps/web/lib/github.test.ts` — add tests for the new method (injected fetch).

**Approach:** Mirror the existing private `get` helper but request the raw media type and read
`res.text()` instead of `res.json()`. A `path` is percent-encoded per segment. Treat 404 as "no
content" (return `null`) rather than throwing, so a deleted/renamed file degrades gracefully; keep
401 → `GitHubAuthError` and the rate-limit signal → `GitHubRateLimitError` so the page can react.

**Patterns to follow:** `createGitHubClient` `get` + `isRateLimited` + the existing method tests in
`apps/web/lib/github.test.ts`.

**Test scenarios:**
- 200 with raw body → returns the exact text. *Covers AC#2.*
- 404 → returns `null` (no throw).
- 401 → throws `GitHubAuthError`.
- 403 + rate-limit headers → throws `GitHubRateLimitError`.
- Path with special chars → correctly encoded in the request URL.

**Verification:** Injected-fetch tests cover success, missing-file, auth, and rate-limit paths; no
real network call in tests.

---

### U4. `recordSwipe` server action + write path

**Goal:** Persist a per-card swipe decision as an advisory reaction.

**Requirements:** AC#3.

**Dependencies:** U1 (`lib/deck.ts` / `lib/db.ts`).

**Files:**
- `apps/web/lib/deck.ts` — add `recordSwipe(ref, fingerprint, tier, sentiment)` inserting into the
  `reactions` table (reuse the existing `reactions` declaration in `lib/db.ts`).
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.ts` — `"use server"` `recordSwipe(formData)`:
  parse + validate `owner/repo/prNumber/fingerprint/tier/sentiment`, ignore malformed input (mirror
  `refute`), call the lib writer. No `revalidatePath` (the client owns advance/progress; a refresh
  would fight the animation).

**Approach:** Mirror the existing `refute` action (`app/pr/.../actions.ts` + `recordRefute` in
`lib/findings.ts`) but parameterize sentiment (`up`/`down`). Validate `tier ∈ {High,Medium,Low}`
and `sentiment ∈ {up,down}` and drop anything else. Advisory only — no merge/approve surface.

**Patterns to follow:** `apps/web/app/pr/[owner]/[repo]/[number]/actions.ts` (`refute`),
`apps/web/lib/findings.ts` (`recordRefute`).

**Test scenarios:**
- `recordSwipe(ref, fp, "High", "up")` issues an insert with `sentiment: "up"` and the given keys.
  *Covers AC#3.*
- `"left"`-derived `"down"` path writes `sentiment: "down"`.
- Missing/invalid `fingerprint`, non-integer `prNumber`, or out-of-enum `tier`/`sentiment` → no-op
  (no insert), matching `refute`'s guard.

**Verification:** Unit test the lib writer with a fake/mock db (assert the insert payload); the
action's guard logic is covered by the validation test. `pnpm test`/`biome`/`tsc` green.

---

### U5. `SwipeDeck` client component (gestures, motion, progress)

**Goal:** The interactive swipe surface — drag/keys/buttons, card stack animation, progress, and the
end-of-deck "all reviewed" state.

**Requirements:** AC#1, AC#3, AC#4, AC#5, AC#6.

**Dependencies:** U2 (helpers), U4 (server action passed as prop).

**Files:**
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/SwipeDeck.tsx` — `"use client"`.

**Approach:** Receives `cards: CardView[]` (plain data: fingerprint, file, tier, riskScore,
suggestions, explanation, the resolved code-window lines or a deletion note) and the `recordSwipe`
server action. State: current index + reviewed count. Pointer Events (`onPointerDown/Move/Up`,
`setPointerCapture`) drive a CSS `translateX`/`rotate` transform on the top card; release past
`commitThreshold` commits a swipe (fly-off transition), otherwise snaps back. Desktop: `←`/`→`
keyboard handlers and two on-screen buttons ("Looks good" / "Flag") drive the same commit path.
On commit: `startTransition(() => recordSwipe(formData))` (non-blocking, AC#6), increment the
reviewed count, advance the index. A top progress bar + "n / total" counter reflect `deckProgress`.
At end of deck, show a calm "You've reviewed the whole deck" summary (count looked-good vs flagged
this session). Respect `prefers-reduced-motion` (CSS) so motion never blocks. Mobile-first layout
reusing `lib/ui.ts` tokens; ≥44px touch targets; readable at ~360px and scaling to desktop. Code
lines render in a monospace block with highlighted lines visually emphasized (background/left
border), tier as a colored chip (reuse the `TIER_COLOR` palette from the #13 page), risk score and
suggestions below.

**Patterns to follow:** `apps/web/app/pr/[owner]/[repo]/[number]/page.tsx` (`TIER_COLOR`, card chrome,
inline-style idiom), `apps/web/components/SignOutButton.tsx` (existing `"use client"` component shape),
`apps/web/lib/ui.ts` tokens.

**Execution note:** Keep all branching logic delegated to the U2 helpers — the component should hold
gesture wiring + render only, so correctness is covered by the helper tests and the browser pass.

**Test scenarios:** `Test expectation: none (component wiring)` — interaction logic is unit-tested in
U2; real-gesture behavior is verified by the pipeline browser-test step (U7 below is the page). No
component test runner is added (KTD-8).

**Verification:** Renders a non-empty deck; dragging/keys/buttons advance and update the progress bar;
the final card yields the reviewed summary; `tsc` + `biome` pass.

---

### U6. Deck page (server) + cross-links + empty state

**Goal:** Wire the route: auth, load the deck, resolve bounded code windows, render `SwipeDeck`,
handle the no-deck-yet case, and cross-link with the #13 view.

**Requirements:** AC#1, AC#2, AC#6.

**Dependencies:** U1, U2, U3, U4, U5.

**Files:**
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/page.tsx` — `export const dynamic = "force-dynamic"`.
  `requireSession()` (reuse #25 auth; on `GitHubAuthError` clear session + redirect to `/login`,
  matching the pulls page). `getLatestDeck(prRef)`; if `null`, render a friendly empty state ("This
  PR's deck isn't ready yet" + a link back). Otherwise, for the deck's cards: dedupe by `file`,
  fetch `getFileAtRef(file, deck.headSha)` up to `MAX_CODE_FETCHES`, split into lines, and build each
  card's code window with `buildCodeWindow`; on any fetch error/cap-exceeded, fall back to the
  descriptive ranges/deletion note (never throw from render). Pass the assembled `CardView[]` + the
  `recordSwipe` action to `SwipeDeck`.
- `apps/web/app/pr/[owner]/[repo]/[number]/page.tsx` — add a prominent link to `…/deck` ("Swipe the
  deck"); add a back-link from the deck page to the static view. (Additive only — #13 behavior
  unchanged.)

**Approach:** Server component owns all I/O (auth, DB, GitHub) and validation; passes only plain
serializable data to the client. Cap + dedupe GitHub reads so a large PR can't fan out unbounded
(KTD-3). Wrap each per-file fetch in try/catch so one bad file degrades just that card. Mobile-first
container via `lib/ui.ts` `page`.

**Patterns to follow:** `apps/web/app/repos/[owner]/[repo]/pulls/page.tsx` (`requireSession` +
`GitHubAuthError` → `/login`), `apps/web/app/pr/[owner]/[repo]/[number]/page.tsx` (route + params +
`force-dynamic`).

**Test scenarios:** `Test expectation: none (server wiring/JSX)` — the data logic it composes
(`getLatestDeck`, `buildCodeWindow`, `getFileAtRef`, `recordSwipe`) is unit-tested in U1–U4. Page
behavior is verified by the pipeline browser-test step.

**Verification:** Visiting `/pr/{owner}/{repo}/{number}/deck` for a PR with a deck renders the swipe
UI with real highlighted code for fetchable files and graceful fallback otherwise; a PR with no deck
shows the empty state; an expired session redirects to `/login`. `pnpm build` (Next) succeeds with
`transpilePackages` resolving `@diffsense/core`.

---

## Scope Boundaries

**In scope:** the swipe deck surface in `apps/web` over the existing `decks`/`reactions` tables; a
bounded GitHub content read for highlighted code; per-card decision recording as advisory reactions;
client-side progress; touch + keyboard/click; tasteful CSS motion.

### Deferred to Follow-Up Work
- Resumable, server-persisted per-reviewer review-state ("you reviewed 6/12 last visit") — needs a
  new table/concept (KTD-5).
- Lazy/streamed code fetching or syntax highlighting of code windows (this slice renders plain,
  highlighted monospace lines).
- Triggering deck generation from the web UI (the #26 `POST /decks` trigger) — the page assumes the
  deck already exists and shows an empty state otherwise.
- A shared schema package to replace the `lib/db.ts` lockstep re-declaration (already noted as
  deferred in `lib/db.ts`).

### Out of Scope (other issues / product identity)
- Any merge/approve/block control — the surface stays strictly advisory (STRATEGY.md).
- Changes to `packages/core`, the deterministic pipeline, the review unit, or the LLM port.
- Changes to the #13 static card view's behavior (only an additive cross-link).
- The webhook/worker deck-production path (#26).

---

## Risks & Mitigations

- **GitHub fan-out / rate limits on large PRs** → dedupe per file + `MAX_CODE_FETCHES` cap + graceful
  degradation to descriptive ranges (KTD-3). The deck still fully renders without any code fetch.
- **`@diffsense/core` not resolving in the Next build** (raw-TS workspace package) → `transpilePackages`
  (KTD-2); verified by `pnpm build` in U1/U6. Fallback if transpile proves intractable: re-declare a
  minimal local `Card` type (web already re-declares table shapes), but prefer the core import.
- **`zod`/core leaking into the client bundle** → all validation stays in server components/lib; the
  client receives plain data only (KTD-2, U6).
- **Animation jank blocking reviewing** → CSS transforms/transitions only, `startTransition` for the
  network write, and `prefers-reduced-motion` support (AC#6, KTD-6).
- **Head-SHA line mismatch** → the deck's `headSha` is the persistence key the highlights were
  computed against; fetching that exact ref keeps `R`-side line numbers aligned. Deletion-only/`L`
  cards never index the head file.

---

## Verification Strategy

- `pnpm test` (Vitest) — green, including the new `lib/deck.test.ts`, `lib/codeWindow.test.ts`, and
  `lib/github.test.ts` additions.
- `pnpm lint` (`biome check .`) — clean.
- `pnpm typecheck` / `tsc --noEmit` per package — clean, with `@diffsense/core` resolving in web.
- `pnpm --filter @diffsense/web build` (`next build`) — succeeds with `transpilePackages`.
- Browser pass (pipeline step): deck renders and is swipeable on a narrow (mobile) and wide (desktop)
  viewport; keyboard `←`/`→` and buttons work; progress advances to a "whole deck reviewed" state;
  motion is smooth and never blocks the next card.

All non-negotiable rules hold: `packages/core` untouched (only imported), no LLM calls, no pipeline
changes, no new vendor SDK, self-host-friendly (no new runtime dependency).

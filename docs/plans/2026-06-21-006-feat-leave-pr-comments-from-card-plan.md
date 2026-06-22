---
title: "feat: Leave PR comments from a card"
type: feat
date: 2026-06-21
issue: 30
status: ready
---

# feat: Leave PR comments from a card (issue #30)

## Summary

Let a reviewer compose and post a comment to the GitHub PR straight from a deck
card. The comment posts through a new `GitHubGateway` port (the architecturally
planned seam, listed in `docs/ARCHITECTURE.md` but not yet built), anchored to the
card's file + line range when the card points at added lines, and falls back to a
general PR-conversation comment otherwise. Posting is strictly reviewer-initiated
(a Post button), attributed to the reviewer (their OAuth token), and the posted
comment is persisted and reflected back on the card. Failures (permission denied,
rate limit, stale anchor) surface as clear inline messages.

Research grounding: 12 of 13 autonomous review bots score signal-to-noise below
60% (Chowdhury et al., MSR 2026). Staying human-driven and low-volume is the
differentiator, so nothing auto-posts — the reviewer chooses what to send.

---

## Problem Frame

The reviewer can swipe cards (👍/👎) and that signal stays inside diffsense
(`reactions` / `review_progress`). There is no way to act *outward* — to leave an
actual comment on the PR — without leaving the card view for GitHub. Issue #30
closes that gap with a single, advisory, reviewer-initiated affordance on the card.

Scope is one vertical slice: compose → post → persist → reflect → surface errors.
It is **not** inline review threads at arbitrary diff positions, comment
editing/deletion, replies/threading, or auto-generated comment text. Those are out
of scope.

---

## Key Technical Decisions

### KTD1 — Introduce a `GitHubGateway` port in `packages/core` (pure interface)

`docs/ARCHITECTURE.md` already lists `GitHubGateway (post/edit comment)` as a core
port; it was never built (today the worker calls `upsertReviewComment` directly in
its Octokit adapter). This slice creates the port: a pure TypeScript interface plus
Zod schemas for the comment input/result. No vendor SDK in `core` (non-negotiable).
The port method is `postComment(ref, input): Promise<PostedComment>` where `input`
optionally carries an anchor (file + line + side + commit SHA).

### KTD2 — The web role implements the gateway via its existing fetch client, bound to the reviewer's OAuth token

A reviewer-initiated comment must be attributed to the **reviewer**, not the GitHub
App/bot. Only the web session holds the reviewer's user-to-server OAuth token; the
worker's Octokit client is App-auth and would post as the bot. `apps/web/lib/github.ts`
is already the web role's GitHub adapter (a `GitHubClient` over plain `fetch`,
deliberately Octokit-free to keep the web dependency surface minimal). We extend it
with `postComment`, conforming structurally to the core `GitHubGateway` port. This
honors "posted via the GitHubGateway port" and reviewer attribution; the issue's
parenthetical "(Octokit adapter)" describes the worker's delivery adapter, which
cannot post as the reviewer. Documented in the PR body.

### KTD3 — Anchor is recomputed server-side from the persisted card, not trusted from the client

The server action receives `fingerprint` + `headSha`, loads the deck, finds the
card, and derives the anchor from `card.highlights` via a pure core helper. This
guarantees the anchor matches a real card (not forgeable) and keeps the mapping
unit-testable. Anchor selection: prefer the card's right-side (added) highlight →
GitHub `RIGHT` side review comment at that line range against `commit_id = headSha`.
A card with only left-side (deletion) highlights or none → no anchor → general PR
conversation comment.

### KTD4 — Anchored post falls back to a conversation comment on 422

GitHub rejects a review comment (422) when the target line is not part of the diff
for that commit. "Anchored where possible" (AC) gives latitude: on 422 we retry as
a general issue comment whose body is prefixed with the file/line reference
(``Re: `path` (added lines 12–18):``). This always succeeds when the reviewer has
write access, so the reviewer's words are never lost to a positioning quirk.

### KTD5 — Persist posted comments in a web `lib` module (mirrors the `reviewProgress` precedent), not a new core port

Per-reviewer read-model state already lives in `apps/web/lib/reviewProgress.ts`
(a lib module, not a core port). Posted comments are the same shape of per-reviewer
artifact, so they get `apps/web/lib/prComments.ts` + a `pr_comments` table. The
only new *core* port is `GitHubGateway` (required by the AC); persistence stays
consistent with the existing web pattern. The table is added to both
`apps/app/src/db/schema.ts` (canonical) and `apps/web/lib/db.ts` (mirror), with a
generated migration — matching the lockstep convention.

### KTD6 — The action returns a result; the composer uses `useActionState`

Unlike `recordSwipe` (fire-and-forget, returns `void`), `postCardComment` must
surface success (link to the posted comment) and failure (clear message) to the
user. It returns a `PostCommentState`. The card's composer is a client sub-component
using React `useActionState`, consistent with `SwipeDeck` already being a client
component.

---

## High-Level Technical Design

```
Card (SwipeDeck client)                 Server action            GitHubGateway (web fetch adapter)        GitHub
  │ reviewer types body                     │                              │                               │
  │ clicks "Post" ──────── form/useActionState ─► postCardComment          │                               │
  │                                          │  getSession() (reviewer)     │                               │
  │                                          │  load deck, find card by fp  │                               │
  │                                          │  cardCommentAnchor(card,sha) │                               │
  │                                          │  session.github.postComment ─► POST pulls/{n}/comments ──────►│ (anchored)
  │                                          │                              │   on 422 → POST issues/{n}/comments (fallback)
  │                                          │  persist (pr_comments)       │                               │
  │ ◄──── PostCommentState {ok, htmlUrl|error} ─┘                          │                               │
  │ show "Posted ✓ (link)"  OR  error message                                                              │
```

Deck page load additionally reads the reviewer's prior `pr_comments` for the deck
head and hands each card its already-posted comments, so reflection survives reload.

---

## Implementation Units

### U1. `GitHubGateway` port + comment schemas in `packages/core`

**Goal:** Define the pure port and Zod schemas the rest of the slice depends on.

**Requirements:** AC "posted via the GitHubGateway port".

**Dependencies:** none.

**Files:**
- `packages/core/src/schemas/prComment.ts` (new) — `PrCommentAnchorSchema`
  (`file`, `line`, `startLine?`, `side: "LEFT"|"RIGHT"`, `commitId`),
  `PrCommentInputSchema` (`body` non-empty, bounded length; optional `anchor`),
  `PostedCommentSchema` (`id`, `htmlUrl`, `kind: "review"|"issue"`). Export inferred types.
- `packages/core/src/ports/githubGateway.ts` (new) — `GitHubPrRef`
  (`owner`, `repo`, `prNumber`) and `interface GitHubGateway { postComment(ref, input): Promise<PostedComment> }`.
- `packages/core/src/index.ts` (modify) — export the new schemas, types, and port.
- `packages/core/src/schemas/prComment.test.ts` (new).

**Approach:** Pure types + Zod only — no vendor import (non-negotiable). Mirror the
existing schema style in `packages/core/src/schemas/card.ts`. `body` min length 1,
max a sane bound (e.g. 65_536). Anchor `startLine <= line` refinement when present.

**Patterns to follow:** `packages/core/src/schemas/card.ts`,
`packages/core/src/ports/reactionStore.ts` (port shape).

**Test scenarios (`prComment.test.ts`):**
- Valid input with anchor parses; valid input without anchor parses.
- Empty `body` rejected; over-max `body` rejected.
- Anchor with `startLine > line` rejected; `side` outside `{LEFT,RIGHT}` rejected.
- `PostedCommentSchema` rejects a non-url `htmlUrl` and an out-of-enum `kind`.

### U2. Pure `cardCommentAnchor` helper in `packages/core`

**Goal:** Deterministically derive a `PrCommentAnchor | null` from a card + head SHA.

**Requirements:** AC "anchored to file/line where possible"; supports KTD3.

**Dependencies:** U1.

**Files:**
- `packages/core/src/render/commentAnchor.ts` (new) — `cardCommentAnchor(card: Card, headSha: string): PrCommentAnchor | null`.
- `packages/core/src/render/commentAnchor.test.ts` (new).
- `packages/core/src/index.ts` (modify) — export the helper.

**Approach:** Take the card's right-side (`R`) highlights (added lines); if none,
return `null` (deletion-only / no-op card → conversation comment). Use the first
`R` range: `side: "RIGHT"`, `line = range.end`, `startLine = range.start` when the
range spans >1 line (else omit `startLine`), `file = card.file`, `commitId = headSha`.
Empty `headSha` → `null`. Pure, no I/O.

**Patterns to follow:** `apps/web/lib/codeWindow.ts` highlight handling (`side === "R"`).

**Test scenarios (`commentAnchor.test.ts`):**
- Single-line `R` highlight → anchor with `line` set, no `startLine`, `side RIGHT`.
- Multi-line `R` highlight → `startLine` + `line` span the range.
- Multiple `R` highlights → uses the first (deterministic).
- Only `L` highlights → `null`. No highlights → `null`. Empty `headSha` → `null`.

### U3. `postComment` on the web GitHub client (gateway adapter)

**Goal:** Implement the `GitHubGateway` against GitHub REST via the existing
fetch client bound to the reviewer's OAuth token.

**Requirements:** AC "posted via the GitHubGateway port (adapter)", "reviewer-
initiated", "failures surfaced clearly".

**Dependencies:** U1.

**Files:**
- `apps/web/lib/github.ts` (modify) — add `postComment(ref, input)` to the
  `GitHubClient` interface and its `createGitHubClient` implementation; add a
  `post()` helper mirroring the existing `get()` (Bearer auth, version header,
  timeout, 401→`GitHubAuthError`, rate-limit→`GitHubRateLimitError`). Add a
  `GitHubPermissionError` class for a genuine 403 (write access denied).
- `apps/web/lib/github.test.ts` (modify) — new cases.

**Approach:**
- Anchored input → `POST /repos/{owner}/{repo}/pulls/{prNumber}/comments` with
  `{ body, commit_id, path, line, side, start_line?, start_side? }`. On 422 →
  fall back to the issue-comment path with a file/line-prefixed body (KTD4).
- No anchor → `POST /repos/{owner}/{repo}/issues/{prNumber}/comments` with `{ body }`.
- Map response → `PostedComment` (`id`, `html_url`→`htmlUrl`, `kind`).
- Error mapping: 401→`GitHubAuthError`; rate-limited (reuse `isRateLimited`)→
  `GitHubRateLimitError`; plain 403→`GitHubPermissionError`; other non-ok→`Error`.
- The method conforms structurally to the core `GitHubGateway` port.

**Patterns to follow:** the `get()` helper and `isRateLimited` in the same file.

**Test scenarios (`github.test.ts`, injectable `fetchImpl`):**
- Anchored post hits the `pulls/{n}/comments` URL with `commit_id`/`path`/`line`/
  `side` and returns the mapped `PostedComment` (`kind: "review"`).
- Unanchored post hits `issues/{n}/comments` and returns `kind: "issue"`.
- Anchored post that 422s falls back to `issues/{n}/comments`, body carries the
  `Re: path` prefix, returns `kind: "issue"`.
- 401 → `GitHubAuthError`; 429 → `GitHubRateLimitError`; plain 403 →
  `GitHubPermissionError`.

### U4. `pr_comments` table — schema, migration, mirror

**Goal:** Persist posted comments per reviewer so they reflect back across reloads.

**Requirements:** AC "posted comments are reflected back in the card/session state".

**Dependencies:** none (can land alongside U1).

**Files:**
- `apps/app/src/db/schema.ts` (modify) — `prComments` table: `id` serial PK,
  `githubUserId` int, `owner`, `repo`, `prNumber` int, `headSha`, `fingerprint`,
  `body` text, `githubCommentId` int, `htmlUrl` text, `kind` text, `createdAt` tz.
  Unique on `githubCommentId`; index on `(githubUserId, owner, repo, prNumber, headSha)`.
- `apps/app/src/db/migrations/0010_pr_comments.sql` (new) — generated via
  `pnpm db:generate`, plus the `meta/_journal.json` entry it appends.
- `apps/web/lib/db.ts` (modify) — mirror the `prComments` table shape (lockstep).

**Approach:** Run `pnpm db:generate` after editing `schema.ts` so the SQL + journal
are tool-generated (don't hand-write). Mirror columns exactly in `apps/web/lib/db.ts`.

**Patterns to follow:** `decks`/`reviewProgress` tables in `schema.ts`; the mirror
blocks in `apps/web/lib/db.ts`; migration format of `0009_review_progress.sql`.

**Test scenarios:** Covered via U5 (lib) integration test. `Test expectation: none`
for the raw table definition itself (pure DDL, no behavior).

### U5. `apps/web/lib/prComments.ts` — record + list

**Goal:** Read/write the `pr_comments` read-model.

**Requirements:** AC "reflected back in the card/session state".

**Dependencies:** U4.

**Files:**
- `apps/web/lib/prComments.ts` (new) — `recordPostedComment(ref, entry)` (insert,
  `onConflictDoNothing` on `githubCommentId`); `listPostedComments(ref): Promise<PostedCardComment[]>`
  keyed by `(githubUserId, owner, repo, prNumber, headSha)`, newest first; export
  `PostedCardComment` (`fingerprint`, `body`, `htmlUrl`, `createdAt`).
- `apps/web/lib/prComments.test.ts` (new) — pure shaping/grouping if any.
- `apps/web/lib/prComments.integration.test.ts` (new) — DB-backed record+list
  round-trip (gated like `reviewProgress.integration.test.ts`).

**Approach:** Mirror `apps/web/lib/reviewProgress.ts` (drizzle via `getDb()`,
`ProgressRef`-style ref object, graceful typing). Group posted comments by
fingerprint for the page to hand to each card.

**Patterns to follow:** `apps/web/lib/reviewProgress.ts` (`recordDecision`,
`getDecidedFingerprints`), `reviewProgress.integration.test.ts`.

**Test scenarios:**
- Integration: record a comment, list returns it for the matching reviewer+head;
  a different `githubUserId` or `headSha` returns none.
- Integration: re-recording the same `githubCommentId` is idempotent (no dup row).

### U6. `postCardComment` server action

**Goal:** Orchestrate auth → validate → anchor → post → persist → return result.

**Requirements:** all five ACs.

**Dependencies:** U2, U3, U5; reads deck via existing `lib/deck.ts`.

**Files:**
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.ts` (modify) — add
  `postCardComment(prev: PostCommentState, formData: FormData): Promise<PostCommentState>`
  and export the `PostCommentState` type.
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.test.ts` (modify).

**Approach:**
1. `getSession()` → if none, return `{ ok: false, error: "Sign in to comment." }`
   (not a silent no-op — the user needs feedback).
2. Parse/validate `owner`, `repo`, `prNumber` (>0), `headSha`, `fingerprint`,
   `body` (non-empty after trim, within max) → bad input returns an error state.
3. Load the latest deck (`getLatestDeck`), find the card by `fingerprint`; missing
   deck/card → error state.
4. `cardCommentAnchor(card, headSha)` → anchor or null.
5. `session.github.postComment({owner,repo,prNumber}, { body, anchor })`.
6. `recordPostedComment(...)` (failure logged, does not fail the post — the comment
   is already on GitHub; return success with a soft note).
7. Return `{ ok: true, comment: { htmlUrl, kind } }`.
8. Catch and map: `GitHubAuthError`→"Your GitHub session expired — sign in again.";
   `GitHubPermissionError`→"You don't have permission to comment on this PR.";
   `GitHubRateLimitError`→"GitHub rate limit hit — try again shortly."; else a
   generic "Couldn't post the comment — try again."

**Patterns to follow:** `recordSwipe` (session gate, FormData parse, validation,
try/catch logging) — but returning a result instead of `void`.

**Test scenarios (`actions.test.ts`):**
- No session → `{ ok: false, error }`, gateway not called.
- Empty/whitespace body → error state, gateway not called.
- Unknown fingerprint (no matching card) → error state, gateway not called.
- Happy path (anchored) → calls gateway with the derived anchor, persists, returns
  `{ ok: true, comment.htmlUrl }`.
- Card with only deletions → calls gateway with `anchor: undefined` (conversation).
- `GitHubPermissionError` → `{ ok:false, error }` mentioning permission.
- `GitHubRateLimitError` → `{ ok:false, error }` mentioning rate limit.
- Persistence failure after a successful post → still returns `{ ok: true }`.

### U7. Card comment composer UI + reflect posted comments

**Goal:** Reviewer-facing compose/post affordance on the card, plus showing
already-posted comments.

**Requirements:** AC "compose and post from a card", "reviewer-initiated",
"reflected back", "failures surfaced".

**Dependencies:** U6; CardView extension.

**Files:**
- `apps/web/lib/codeWindow.ts` (modify) — extend `CardView` with
  `postedComments: PostedCardComment[]`; `toCardView` accepts/passes them through.
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/SwipeDeck.tsx` (modify) — add a
  `CommentComposer` sub-component (textarea + Post button, collapsed by default),
  wire a new `postComment` prop (the action) via `useActionState`; render the
  anchor target label and any `card.postedComments` with links; add `postComment`
  to `SwipeDeckProps`.
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/page.tsx` (modify) — read the
  reviewer's posted comments for the deck head (graceful `[]` fallback), pass them
  into `buildCardViews`/`toCardView`, and pass `postCardComment` to `SwipeDeck`.
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/SwipeDeck.test.tsx` (modify).

**Approach:** The composer is collapsed (a "Comment on PR" button) so the card
stays low-noise; expanding reveals the textarea + a target line ("Will post on
`path` · Added lines 12–18" when anchored, else "Will post to the PR conversation").
Post submits the form (`useActionState`); on `ok` show "Posted to GitHub ✓" with the
`htmlUrl` link and clear the field; on error show the message inline. Nothing posts
without the explicit Post click (reviewer-initiated). Keep the inline-style idiom
already used in `SwipeDeck.tsx`.

**Patterns to follow:** `LanguagePicker.tsx` (form + server action), `CardBody` /
`controls` in `SwipeDeck.tsx`, existing inline-style objects.

**Test scenarios (`SwipeDeck.test.tsx`):**
- Composer is collapsed by default; clicking the toggle reveals the textarea.
- Anchored card shows the file/line target; deletion-only card shows the
  conversation target.
- A card with `postedComments` renders the prior comment(s) with a link.
- (Where feasible with the test setup) a success state shows the posted link; an
  error state shows the message. Keep assertions behavioral, not implementation-coupled.

---

## Scope Boundaries

**In scope:** one comment composer per card; anchored review comment with
conversation fallback; reviewer-attributed posting; persistence + reflection;
clear failure messages.

### Deferred to Follow-Up Work
- Editing or deleting a posted comment.
- Replies / threading on an existing review thread.
- Multi-range or reviewer-chosen anchor (we use the first added range).
- Surfacing posted comments to *other* reviewers (current reflection is per-reviewer).

### Out of scope (other issues / product identity)
- Auto-generated or AI-suggested comment text (product stays advisory, human-driven).
- Merge gating / approvals.
- A core `CommentStore` port (web `lib` persistence matches the `reviewProgress` precedent).

---

## Risks & Dependencies

- **Anchor rejected by GitHub (422):** mitigated by the conversation-comment
  fallback (KTD4) so the reviewer's text is never lost.
- **Write permission:** a reviewer with read-only access gets a clear permission
  message; no silent failure.
- **Schema lockstep:** `pr_comments` must be identical in `schema.ts` and
  `apps/web/lib/db.ts`; generate the migration with `pnpm db:generate`.
- **CI/build:** per repo memory, web build needs `transpilePackages` + webpack
  `extensionAlias` to resolve `@diffsense/core` — new core exports must build in
  `apps/web`. Verify `pnpm -r build` / typecheck locally (CI workflow is gitignored;
  local Postgres on 5433 for integration tests).

---

## Verification

- `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`, `pnpm lint` (Biome) all green.
- New core exports resolve in `apps/web` (build passes).
- Manual/behavioral: a card's composer posts a comment attributed to the reviewer,
  anchored when the card has added lines, and the posted comment shows on the card
  after reload.

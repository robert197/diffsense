# Plan — On-demand PR processing into an ordered Deck of cards (#26)

## Goal

When a reviewer opens a PR for review, run the engine on demand (not only via the
GitHub webhook) and produce an ordered **Deck of cards**. Each card carries a risk
score, the exact highlighted line ranges, "what could be wrong" suggestions, and a
plain-language explanation. The deck is ordered by risk and covers all changed code,
persisted keyed to `(PR, head SHA)` so it can be re-fetched and resumed.

Mirrors the existing #13 findings path: deterministic rank (all hunks) + the agentic
review pass (top-risk subset) feed a **pure card-builder** in `core`; a new
**DeckStore** port persists the deck behind a Drizzle adapter.

## Acceptance criteria → where satisfied

1. Opening a PR triggers on-demand pipeline execution and produces a Deck
   → `POST /decks` ingress route enqueues a review job (non-webhook trigger); the
   worker runs the engine and persists a deck. The webhook path also produces one.
2. Each card has risk score, highlighted line ranges, suggestions, plain-language
   explanation → `CardSchema` + `buildDeck`.
3. Cards ordered so the full deck covers all changed code → `buildDeck` emits one
   card per ranked hunk, in `rankHunks` risk order.
4. Deck persisted (keyed to PR + head SHA) and re-fetchable → `decks` table unique on
   `(owner, repo, pr_number, head_sha)`; `DeckStore.save`/`get`; `GET /decks` route.
5. Card schema Zod in core; card-builder pure unit-tested; store behind a port →
   `schemas/card.ts`, `deck/buildDeck.ts`, `ports/deckStore.ts`.
6. `packages/core` imports no vendor SDK → only `zod` + `parse-diff` + existing core.

## Design

### Join model (the one tricky bit)

`rankHunks` keys hunks positionally (`file\nside\nline`) and gives score + tier +
order. The review pass keys findings by the **structural** fingerprint
`fingerprintChunk(file, patch)`. `buildDeck` does a single parse-diff walk to recover,
per hunk, the same `patch` string `buildReviewChunks` builds
(`[chunk.content, ...changes.map(c => c.content)].join("\n")`), computes the structural
fingerprint, and joins:

- order/score/tier ← `rankHunks` (positional key)
- highlights ← the hunk's changed-line ranges
- explanation + suggestions ← the matching `ReviewFinding` (structural fingerprint), if
  that hunk was reviewed; otherwise a factual default explanation + no suggestions.

This reuses the existing `ReviewFinding[]` the worker already produces — no second LLM
pass, no new schema for review content.

### New core files

- `schemas/card.ts` — `HighlightRangeSchema { side: "L"|"R", start, end }`, `CardSchema`
  `{ fingerprint, file, tier, rank, riskScore, highlights[], suggestions[], explanation }`,
  `DeckSchema { owner, repo, prNumber, headSha, cards[] }`. + `card.test.ts`.
- `ports/deckStore.ts` — `DeckRef { owner, repo, prNumber, headSha }`, `DeckStore`
  `{ save(deck), get(ref): Deck | null }`.
- `deck/buildDeck.ts` — `buildDeck(diff, meta: DeckRef, findings): Deck`. Pure. Highlights
  = coalesced contiguous changed lines (added → R side; pure-deletion hunk → L side).
  Default explanation for non-reviewed hunks is factual, plain, no AI tells. + `buildDeck.test.ts`.
- Export all from `index.ts`.

### apps/app

- `db/schema.ts` — `decks` table: `id`, `owner`, `repo`, `pr_number`, `head_sha`,
  `cards` jsonb, `created_at`; unique `(owner, repo, pr_number, head_sha)`.
- `db/migrations/0007_decks.sql` + `_journal.json` entry idx 7.
- `adapters/deckStore.ts` — `createDrizzleDeckStore(db)`: `save` upserts on the unique
  key (replace cards on conflict); `get` re-validates with `DeckSchema`. + stubbed test
  mirroring `findingStore.test.ts`.
- `worker/processPrIntoDeck.ts` — the on-demand seam: given the diff, meta, findings, a
  head SHA and a `DeckStore`, build + persist the deck. Pure over injected ports. + test.
- `worker/index.ts` — in the review runner, after `reviewAndPersistFindings`, call
  `processPrIntoDeck` so every review run (webhook or on-demand enqueue) persists a deck.
  Build the `DeckStore` once alongside the other stores.
- `ingress/server.ts` — `POST /decks` (validate `{owner, repo, prNumber, installationId}`,
  enqueue a `synchronize` job via the existing `enqueue`) + `GET /decks` (validate query,
  read via injected `getDeck`). Both gated by their injected dep (404 when absent), same
  DI pattern as `/reactions`. + route tests.
- `main.ts` — serve role builds a `DeckStore` from the existing `db` and passes
  `getDeck` to `createServer`; `POST /decks` reuses the existing `enqueue`.

## Test plan

- `card.test.ts` — schema accepts a valid card/deck; rejects empty explanation, bad range.
- `buildDeck.test.ts` — one card per hunk; risk order; highlights match changed lines;
  reviewed hunk gets explanation+suggestions from its finding (joined by structural
  fingerprint); non-reviewed hunk gets default explanation + empty suggestions; empty diff
  → empty deck; deck validates against `DeckSchema`.
- `deckStore.test.ts` — `save` upserts; `get` maps + re-validates, throws on bad JSON.
- `processPrIntoDeck.test.ts` — builds from fake inputs, persists via fake store, returns deck.
- `server.test.ts` — `POST /decks` enqueues a well-formed PrRef; bad body → 400; no dep → 404.
  `GET /decks` returns deck / 404 / 400.

## Gate

`pnpm test`, `pnpm lint`, `pnpm typecheck` all green before the PR. `core` stays vendor-free.

## Out of scope (deliberate)

- The swipe/card web UI (STRATEGY: deferred until the ordering thesis is validated).
- A separate verify/scope pass for suggestions — suggestions come from the review claims,
  consistent with the #13 findings path. Verify-derived suggestions are a later refinement.
- Non-English explanations (the issue defers language to a later slice).

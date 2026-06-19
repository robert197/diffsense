---
title: "feat: Ranking robustness + reviewer feedback signal"
type: feat
date: 2026-06-19
issue: 3
branch: feat/ranking-robustness-reactions
status: planned
---

# feat: Ranking robustness + reviewer feedback signal

Implements GitHub issue #3 (robert197/diffsense). Hardens the structural ranking
from #2 (already merged) and adds the reviewer precision signal.

---

## Problem Frame

The #2 ranking scores every hunk and buckets them High/Medium/Low. Two gaps make
the "review first" set untrustworthy, and there is no way to learn whether the
ranking is any good:

1. **Machine-written noise pollutes the top set.** A large `pnpm-lock.yaml` or
   minified bundle change scores high on size and can crowd out the real,
   risky source change. Reviewers stop trusting the order.
2. **Unknown languages.** The symbol/path heuristics are tuned for common
   languages. The engine must never error on an unrecognized language; it must
   fall back to size + risk-path and still produce a valid ordering.
3. **No feedback loop.** There is no cheap signal for whether a flagged chunk was
   a real catch or noise. Without it, precision can't be measured and the moat
   (Review Memory, see STRATEGY.md) can't start compounding.

## Scope

In scope (exactly the issue's acceptance criteria):

- Demote generated / binary / lockfile hunks to Low and exclude them from the
  review-first set even when large.
- Graceful fallback so an unrecognized-language PR still produces a valid ranked
  comment (no error) via size + risk-path.
- A one-click 👍/👎 affordance per flagged chunk, recorded against that chunk's
  tier through a `ReactionStore`.
- Pure-function unit tests for the demotion and fallback paths.

Out of scope: the card-view UI (#13), structural AST fingerprints + the
fingerprint cache (#8), and using the reaction signal to retune weights. We
record reactions now; consuming them comes later.

### Deferred to Follow-Up Work

- Structural/AST fingerprint for chunks (#8) — this slice uses a lightweight
  positional fingerprint (`file:side:line`) good enough to key a reaction.
- Aggregating reactions into a precision metric or weight feedback.

---

## Requirements

- R1: Generated/binary/lockfile hunks are demoted to Low and never appear in the
  High or Medium set, regardless of size.
- R2: A PR whose files are in a language the symbol heuristics do not recognize
  still produces a valid ranked comment via size + risk-path fallback; no throw.
- R3: Each flagged chunk (High and Medium) exposes a 👍/👎 affordance; clicking it
  records `{ chunk fingerprint, tier, sentiment }` through a `ReactionStore`.
- R4: Demotion and fallback paths are covered by pure-function unit tests.

---

## Key Technical Decisions

- **Demotion is a pure path/extension classifier, applied before tiering.** A new
  `classifyDemotion(path)` in `packages/core` returns a `DemotionReason` or null.
  `rankHunks` still scores every hunk (so the reason/score stays inspectable),
  but demoted hunks are forced to `Low` and excluded from the percentile math
  that assigns High/Medium. This keeps demoted noise out of the top set even when
  it is large, and keeps the whole thing deterministic and unit-testable.
- **Fallback is already structural, not exceptional.** The #2 signals already
  contribute zero when they don't match (unknown path → no risk category, unknown
  syntax → no api-boundary, unknown extension → not a source file so no
  missing-test penalty), leaving size + risk-path. This slice makes that contract
  explicit and locks it with tests rather than adding new branching. `rankHunks`
  must never throw on a parseable diff.
- **`ReactionStore` is a port in `core`; Drizzle implements it in `apps/app`.**
  Core stays pure: it owns the `ChunkReaction` Zod schema and the port interface,
  no vendor import. This matches the existing port/adapter split in
  docs/ARCHITECTURE.md.
- **The affordance is a plain markdown link, recorded via a GET endpoint.**
  "One-click" inside a GitHub comment means a link the reviewer clicks. The link
  points at the diffsense ingress (`/reactions?...`), which validates the params
  and records the reaction. A GET that records is the pragmatic choice for a
  click-through link; the data is advisory, non-authoritative signal, so this is
  an acceptable trade for the MVP (noted in code).
- **Chunk fingerprint is positional for now.** `fingerprint = sha256(file:side:line)`
  truncated. Stable enough to key a reaction within a PR; the structural
  fingerprint is #8's job.
- **`PUBLIC_BASE_URL` drives the affordance, and it is optional.** `renderComment`
  takes an optional reaction base URL. When unset, the comment renders exactly as
  today (no affordance) rather than emitting broken links — so the worker never
  hard-depends on it.

---

## Implementation Units

### U1. Demotion classifier (pure)

**Goal:** Classify a file path as generated, binary, or lockfile noise.

**Requirements:** R1, R4

**Files:**
- `packages/core/src/diff/demote.ts` (new)
- `packages/core/src/diff/demote.test.ts` (new)
- `packages/core/src/index.ts` (export the classifier + type)

**Approach:** Export `type DemotionReason = "generated" | "binary" | "lockfile"`
and `classifyDemotion(path: string): DemotionReason | null`. First-match-wins
ordered patterns, mirroring the `RISK_PATTERNS` style already in `rankHunks.ts`:
- lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `npm-shrinkwrap.json`,
  `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`,
  `Pipfile.lock`, `*.lock`.
- generated: `*.min.js`, `*.min.css`, `*.map`, paths under `dist/` `build/`
  `vendor/` `node_modules/` `generated/`, `*.generated.*`, `*.pb.go`, `*_pb2.py`,
  `*.snap`.
- binary by extension: images (`png jpg jpeg gif webp ico`), fonts
  (`woff woff2 ttf eot otf`), archives (`zip gz tar tgz`), media, `pdf`, `wasm`,
  `*.bin`.

**Patterns to follow:** the `ReadonlyArray<readonly [Label, RegExp]>`
first-match-wins table and the case-insensitive regexes in
`packages/core/src/rank/rankHunks.ts`.

**Test scenarios:**
- `pnpm-lock.yaml`, `package-lock.json`, `go.sum`, `Cargo.lock` → `"lockfile"`.
- `dist/app.min.js`, `src/x.generated.ts`, `api/foo.pb.go`, `path/to/build/x.js`
  → `"generated"`.
- `assets/logo.png`, `fonts/Inter.woff2`, `bundle.wasm` → `"binary"`.
- `src/payments/charge.ts`, `README.md`, `packages/core/src/rank/rankHunks.ts`
  → `null` (real source/docs not demoted).
- Case-insensitivity: `Dist/App.Min.JS` still demoted.

### U2. Apply demotion + lock the fallback contract in rankHunks

**Goal:** Force demoted hunks to Low and exclude them from High/Medium; add the
positional fingerprint; prove unknown-language fallback never errors.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- `packages/core/src/rank/rankHunks.ts`
- `packages/core/src/rank/rankHunks.test.ts`

**Approach:**
- Add `demoted: boolean` and `demotionReason: DemotionReason | null` to
  `RankedSignals`; compute them from `classifyDemotion(path)` in
  `buildRankedChunk`. When demoted, fold the reason into the one-line `reason`
  (e.g., `"Generated file, demoted"`).
- Add `fingerprint: string` to `RankedChunk` (sha256 of `${file}:${side}:${line}`,
  truncated to 16 hex), computed alongside the existing `deepLink` hash.
- Change `assignTiers` so demoted chunks are always `Low` and are not counted in
  the percentile base. Concretely: partition the sorted list into
  `candidates` (not demoted) and `demoted`; run the existing High/Medium/Low
  percentile assignment over `candidates` only; demoted stay `Low`. Preserve the
  existing sort order in the returned array (demoted keep their score-sorted
  position but carry Low tier).
- No new throw paths: `rankHunks` already tolerates unknown languages (signals
  contribute zero, size + risk-path remain). Keep that; do not add language
  gating.

**Patterns to follow:** existing `assignTiers`, `buildRankedChunk`, and the
`createHash("sha256")` deep-link in the same file.

**Test scenarios:**
- A 400-line `pnpm-lock.yaml` hunk plus a small `src/auth/login.ts` hunk: lockfile
  is `Low` and demoted; the auth hunk is `High`. Lockfile never in High/Medium. (R1)
- A demoted hunk is excluded from the percentile base: with one real hunk + three
  demoted, the real hunk is still `High`.
- Unknown language: a diff touching `app/main.zig` and `lib/thing.elm` returns a
  valid non-empty ranking, deterministic order, no throw; score reflects size
  (+ risk-path when the path matches). (R2)
- Unknown-language file with a risk path (`src/auth/handler.unknownext`) still gets
  the risk-path contribution.
- Every returned chunk has a non-empty 16-char `fingerprint`; two hunks at
  different lines get different fingerprints; same coords are stable across calls.
- Regression: existing #2 ranking assertions still pass.

### U3. ReactionStore port + ChunkReaction schema (pure core)

**Goal:** Define the port and the validated reaction shape in `core`.

**Requirements:** R3

**Files:**
- `packages/core/src/schemas/reaction.ts` (new) — Zod `ChunkReactionSchema` + type
- `packages/core/src/ports/reactionStore.ts` (new) — `ReactionStore` interface
- `packages/core/src/index.ts` (exports)
- `packages/core/package.json` (add `zod` dependency)
- `packages/core/src/schemas/reaction.test.ts` (new)

**Approach:** `ChunkReactionSchema` validates
`{ owner, repo, prNumber (int > 0), fingerprint (non-empty), tier (High|Medium|Low),
sentiment ("up"|"down") }`. `ReactionStore` is
`interface ReactionStore { record(reaction: ChunkReaction): Promise<void> }`.
Core gains `zod` as a dependency (already used in `apps/app`); no vendor SDK.

**Patterns to follow:** the Zod usage in `apps/app/src/config.ts`; the `Tier`
union already in `rankHunks.ts` (reuse it for the schema's tier).

**Test scenarios:**
- Valid object parses.
- Bad `sentiment` ("love"), bad `tier`, `prNumber` 0 / negative, empty
  `fingerprint` each fail `safeParse`.

### U4. Reaction affordance in renderComment

**Goal:** Render 👍/👎 links on each flagged (High/Medium) chunk.

**Requirements:** R3

**Dependencies:** U2

**Files:**
- `packages/core/src/render/renderComment.ts`
- `packages/core/src/render/renderComment.test.ts`

**Approach:** Add an optional second arg
`renderComment(chunks, opts?: { reactionBaseUrl?: string })`. When
`reactionBaseUrl` is set, append per High/Medium item a trailing
` 👍 / 👎` where each emoji is a markdown link to
`${reactionBaseUrl}/reactions?owner=..&repo=..&pr=..&fp=<fingerprint>&tier=<tier>&s=up|down`
(URL-encoded). When unset, render exactly as today. Low remainder line unchanged.
The owner/repo/pr come from the chunk's `deepLink` is not reused — pass them via a
small helper that reads them from the chunk fields; chunk already carries `file`,
`tier`, `fingerprint`. owner/repo/pr are not on the chunk, so thread them in:
extend `renderComment` opts to `{ reactionBaseUrl?, pr?: { owner, repo, prNumber } }`
(the worker has them). Affordance only renders when both `reactionBaseUrl` and
`pr` are present.

**Patterns to follow:** existing `renderItem` and advisory tone in
`renderComment.ts`. Keep the affordance on the same bullet, no new list nesting.

**Test scenarios:**
- With `reactionBaseUrl` + pr: each High/Medium item contains a `?s=up` and a
  `?s=down` link carrying the chunk's `fp=<fingerprint>` and correct `tier`.
- Links are well-formed URLs and URL-encode the params.
- Without `reactionBaseUrl`: output is byte-identical to current behavior (no
  affordance) — protects the existing #2 render tests.
- Low-tier chunks never get an affordance.

### U5. Reaction endpoint + config + worker threading

**Goal:** Accept the click, validate, record via an injected `ReactionStore`; pass
the public base URL through to `renderComment`.

**Requirements:** R3

**Dependencies:** U3, U4

**Files:**
- `apps/app/src/ingress/server.ts` (add `GET /reactions`, extend `IngressDeps`)
- `apps/app/src/ingress/server.test.ts`
- `apps/app/src/config.ts` (add optional `publicBaseUrl` from `PUBLIC_BASE_URL`)
- `apps/app/src/worker/handlePullRequestEvent.ts` (accept + forward base url)
- `apps/app/src/worker/handlePullRequestEvent.test.ts`
- `apps/app/src/worker/index.ts` (pass `config.publicBaseUrl`)
- `.env.example` (document `PUBLIC_BASE_URL`)

**Approach:**
- `IngressDeps` gains `recordReaction?: (r: ChunkReaction) => Promise<void>`
  (a thin bind over `ReactionStore.record`). The route parses the query with
  `ChunkReactionSchema` (mapping `pr`→prNumber, `fp`→fingerprint, `s`→sentiment).
  Invalid → 400. On success, record and return a small 200 text/redirect
  ("Thanks, recorded."). If `recordReaction` is not wired, return 404 so the route
  is inert in setups that don't enable it.
- `config.publicBaseUrl` is optional (`PUBLIC_BASE_URL`, validated as a URL when
  present). `startWorker` forwards it into `handlePullRequestEvent`, which passes
  `{ reactionBaseUrl, pr }` into `renderComment`.

**Patterns to follow:** the injected `enqueue` dependency and the 4xx/5xx response
style in `server.ts`; the optional-field validation in `config.ts`.

**Test scenarios:**
- `GET /reactions` with valid params calls `recordReaction` once with the parsed
  `{owner, repo, prNumber, fingerprint, tier, sentiment}` and returns 200.
- Missing/invalid `s` or `tier` → 400, store not called.
- When `recordReaction` is not provided → 404.
- `handlePullRequestEvent` with a base url passes a body containing reaction links;
  without it, the body has none (fake octokit, no network).
- `loadConfig` accepts a valid `PUBLIC_BASE_URL` and tolerates it being unset.

### U6. Drizzle reactions table + ReactionStore adapter + wiring

**Goal:** Persist reactions; wire the store into the serve role.

**Requirements:** R3

**Dependencies:** U3, U5

**Files:**
- `apps/app/src/db/schema.ts` (add `reactions` table)
- `apps/app/src/adapters/reactionStore.ts` (new) — `createDrizzleReactionStore(db)`
- `apps/app/src/main.ts` (serve role: build db handle + store, inject
  `recordReaction`)
- `apps/app/src/db/db.test.ts` (extend if the suite runs against a test DB; else a
  pure adapter shape test)

**Approach:** `reactions` table: `id serial pk`, `owner`, `repo`,
`pr_number int`, `fingerprint text`, `tier text`, `sentiment text`,
`created_at timestamptz default now()`. `createDrizzleReactionStore(db)` returns a
`ReactionStore` whose `record` inserts a row. `main.ts` serve role builds the db
handle (reusing `createDb`) and passes `store.record` as `recordReaction` into
`createServer`; adds the handle to the shutdown drain.

**Patterns to follow:** the `processedEvents` table definition in `schema.ts`; the
`createDb` lifecycle in `db/client.ts`; the shutdown drain in `main.ts`.

**Test scenarios:** `Test expectation: light` — schema compiles and the adapter
satisfies the `ReactionStore` port; the existing db test stays skipped unless a
test Postgres is present (mirrors current `db.test.ts`). Behavior is covered at the
endpoint level in U5 with a fake store. Migration generation (`db:generate`) is an
execution-time step, not a unit test.

---

## System-Wide Impact

- New optional env var `PUBLIC_BASE_URL`. Absent → comment renders without the
  affordance (no breakage). Documented in `.env.example`.
- New `reactions` table needs a generated Drizzle migration (`pnpm db:generate`)
  before the serve role can record. Without the table the insert errors, but the
  endpoint is only wired when a store is injected.
- `core` gains a `zod` dependency — still pure (no vendor SDK), consistent with
  docs/STACK.md ("pure types and Zod schemas only").

## Risks & Mitigations

- **GET that mutates state.** Acceptable for a click-through advisory signal;
  bounded by Zod validation. Noted in code. Not auth-sensitive data.
- **Demotion over-reach** (a real file matching a generated pattern). Patterns are
  conservative and ordered; covered by U1 tests asserting real source is not
  demoted.
- **Positional fingerprint drift across pushes.** Accepted for this slice; the
  structural fingerprint (#8) supersedes it.

## Verification

- `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.
- New pure tests cover demotion (U1), demotion-in-ranking + unknown-language
  fallback (U2), schema (U3), affordance render (U4), endpoint recording (U5).
- `core` imports no vendor SDK (only `parse-diff`, `zod`).

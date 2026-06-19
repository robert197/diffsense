# feat: Structural risk ranking + ranked PR comment

**Origin:** GitHub issue [#2](https://github.com/robert197/diffsense/issues/2) — `ready-for-agent`
**Type:** feat · **Depth:** Standard
**Stacks on:** issue #1 scaffold (PR #14, unmerged) — branched off `feat/scaffold-ingress-placeholder`
**Grounded in:** `docs/STACK.md`, `docs/ARCHITECTURE.md`, `STRATEGY.md`, `CLAUDE.md`

---

## Summary

Replace the placeholder worker comment ("diffsense received this PR — N hunks detected") with a real risk-ordered review pointer. Two new pure functions in `packages/core`:

- `rankHunks(diff, meta)` — parses the unified diff and scores every hunk with a transparent linear model over four structural signals (no LLM): log-scaled change size, risk-path membership, API-boundary crossing, and a missing-test-delta proxy. Buckets hunks into High/Medium/Low by within-PR percentile so even a one-hunk PR surfaces a High.
- `renderComment(rankedChunks)` — turns the ranked chunks into advisory markdown: a header, an ordered High/Medium list (deep-link to the hunk in the Files-changed view + one-line reason + tier), and the Low remainder collapsed to a single line. Tone never gates the merge.

The `apps/app` worker wires them: fetch the diff (already does), call `rankHunks`, then `renderComment`, then the existing idempotent `upsertReviewComment`. This is the first slice of the **Risk Intelligence** track and the deterministic-shell stage `rankHunks → renderComment` from `docs/ARCHITECTURE.md §2`.

---

## Problem Frame

`STRATEGY.md`: reviewer attention is the scarce resource. Large AI PRs arrive in file order, reviewers fatigue on the tail where the risk hides. diffsense wins by directing finite attention to the riskiest changes first using cheap structural signals — no LLM, deterministic, trustworthy. Issue #1 shipped the runnable shell (ingress, queue, worker, idempotent delivery) but the worker only posts a hunk count. This slice makes the comment actually allocate attention: a ranked "review first" list.

Per `docs/ARCHITECTURE.md`: ranking is deliberately deterministic — it is cost/attention control, not domain judgment. `rankHunks` and `renderComment` are small pure functions in `core`; the I/O (Octokit diff fetch, comment post) stays in `apps/app`. `core` imports no vendor SDK.

---

## Requirements (traceability to issue #2 acceptance criteria)

- **R1** — `rankHunks` scores every hunk from the four structural signals; exhaustive pure-function unit tests. → U1
- **R2** — Hunks bucket High/Medium/Low by within-PR percentile; even a tiny PR surfaces at least the single most-risk hunk. → U1
- **R3** — The posted comment lists High/Medium chunks with deep-link + one-line reason + tier, and collapses the Low remainder to one line. → U2
- **R4** — Comment tone is advisory and never gates the merge. → U2
- **R5** — No LLM call in the ranking path. → U1, U2, U3 (structural; `core` has no LLM dep)
- **R6** — Worker posts the ranked comment instead of the placeholder. → U3

---

## Key Technical Decisions

- **KTD1 — `rankHunks` takes the raw diff string, parses internally with `parse-diff`.** The issue sketches `rankHunks(parsedDiff, ...)`, but taking the raw `diff: string` matches the existing `countHunks(diff: string)` seam, keeps `core` the single owner of parsing, and lets the worker pass the `data` string it already holds. Tests are written as diff strings (same style as `countHunks.test.ts`). Behavior, not the literal signature, is what the acceptance criteria pin down.

- **KTD2 — Transparent linear score with hand-set, exported weights.** `score = W_SIZE*log2(1+added+deleted) + W_RISK_PATH*riskPath + W_API*apiBoundary + W_MISSING_TEST*missingTestDelta`. Weights are module-level named constants (cold-start, not learned), so the ranking is inspectable and the reason string can name which signals fired. Defaults: `W_SIZE=1`, `W_RISK_PATH=3`, `W_API=2`, `W_MISSING_TEST=1.5`.

- **KTD3 — Bucketing by count-based percentile, guaranteeing a non-empty High.** Sort hunks by score desc with a deterministic tiebreak (file path, then hunk order). `highCount = max(1, round(0.2*n))`, `medCount = round(0.3*n)`, rest Low. A 1-hunk PR → that hunk is High. Cutoffs (`HIGH_PCTL=0.2`, `MED_PCTL=0.3`) are exported constants. This is the "percentile within the PR" rule, made deterministic and tiny-PR-safe.

- **KTD4 — Deep-link to the Files-changed hunk anchor, computed in `core`.** GitHub PR file anchors are `#diff-<sha256(filepath)>{R|L}<line>`. `rankHunks` receives `meta = { owner, repo, prNumber }` and bakes a full URL into each `RankedChunk`, so `renderComment(rankedChunks)` keeps the issue's single-arg signature. SHA-256 via `node:crypto` (a Node builtin, not a vendor SDK — `core` purity rule is about provider independence, not avoiding stdlib). Use `R<newStart>` when the hunk adds lines, else `L<oldStart>` for deletion-only hunks.

- **KTD5 — Risk-path and API-boundary are heuristics over paths and changed-line text.** Risk path: first-match-wins regex over the file path across categories (auth, payment, migration, config, infra, security, deploy) → boolean + label. API boundary: any added/deleted line whose content matches export/public-surface patterns (`export`, `export default`, `module.exports`, leading `public `). Missing-test-delta: a changed source-code file (by extension) that has no corresponding changed test file in the same PR; test files and non-code files are never flagged.

- **KTD6 — Keep `countHunks` exported.** #1's `countHunks` is no longer called by the worker after this slice, but it stays a tested public `core` utility (and `rankHunks` reuses `parse-diff` the same way). Deleting it would undo #1 work for no benefit; leaving an unused private function would be dead code, but a tested public export is a legitimate library surface.

---

## High-Level Technical Design

Deterministic pipeline stage this slice fills (from `docs/ARCHITECTURE.md §2`):

```
handlePullRequestEvent (apps/app, I/O)
  └─ octokit.pulls.get(format:diff)  ── raw unified diff (string)
       └─ rankHunks(diff, {owner,repo,prNumber})   [core, pure]
            ├─ parse-diff → files → hunks
            ├─ per hunk: sizeScore, riskPath, apiBoundary, missingTestDelta
            ├─ linear score (exported weights)
            ├─ sort desc + count-based bucket → High/Medium/Low
            └─ RankedChunk[] (each carries score, tier, reason, deepLink)
       └─ renderComment(rankedChunks)              [core, pure]
            └─ markdown: header + High/Medium list + Low one-liner
       └─ upsertReviewComment(...)                 [apps/app, idempotent, unchanged]
```

`RankedChunk` shape (directional, not a spec):

```ts
type Tier = "High" | "Medium" | "Low";
interface RankedChunk {
  file: string; line: number; side: "R" | "L";
  added: number; deleted: number;
  score: number; tier: Tier; reason: string; deepLink: string;
  signals: { sizeScore: number; riskPath: boolean; riskPathLabel: string | null;
             apiBoundary: boolean; missingTestDelta: boolean };
}
```

---

## Implementation Units

### U1. `rankHunks` — structural risk scoring + bucketing

**Goal:** Pure `rankHunks(diff, meta)` returning `RankedChunk[]` ordered by risk, each tagged with tier, score, reason, and deep-link.
**Requirements:** R1, R2, R5
**Dependencies:** none (uses the existing `parse-diff` dep)
**Files:**
- `packages/core/src/rank/rankHunks.ts` (new)
- `packages/core/src/rank/rankHunks.test.ts` (new)
- `packages/core/src/index.ts` (add export)

**Approach:**
- Parse with `parse-diff`. For each file, resolve the GitHub path (`file.to` unless `/dev/null`, else `file.from`); for each chunk, count `added`/`deleted` changes and read `newStart`/`oldStart`.
- File-level signals: `riskPath` (first-match category regex over the path → boolean + label), `missingTestDelta` (file is source-code by extension AND no changed test file in the PR shares its base name). Build the PR-wide set of test-file base names once.
- Hunk-level signals: `sizeScore = log2(1 + added + deleted)`; `apiBoundary` (any added/deleted change line content matches the export/public-surface patterns).
- Score = weighted sum of the four signals (exported weight constants).
- Build `reason` from the signals that fired (size band + risk-path label + "touches exported API" + "no accompanying tests").
- Build `deepLink` from `meta` + `sha256(path)` + `R<newStart>`/`L<oldStart>`.
- Sort by score desc, tiebreak (path asc, then original hunk index). Assign tiers by count-based cutoffs (KTD3).
- Empty/whitespace diff → `[]`.

**Patterns to follow:** `packages/core/src/diff/countHunks.ts` (parse-diff usage, JSDoc tone, `.js` ESM import suffix), `countHunks.test.ts` (diff-string fixtures, `describe/it` Vitest).

**Test scenarios:**
- Sums size from added+deleted and orders higher-score hunks first (multi-file diff).
- Empty string and whitespace-only string → `[]`.
- Single-hunk PR → exactly one chunk, tier `High` (R2 tiny-PR guarantee).
- Risk-path hit: a change under `src/auth/...` scores above an equal-size change under `src/util/...`; `signals.riskPathLabel === "auth"`. Cover at least payment, migration, config, infra, security, deploy path samples too.
- API-boundary: a hunk adding/removing an `export` line is flagged `apiBoundary`; a hunk with only internal edits is not.
- Missing-test-delta: source file changed without a sibling test file → `missingTestDelta true`; same source file changed alongside its `*.test.ts` → `false`; a changed `*.test.ts` itself → `false`; a changed `.md`/`.json` → `false`.
- Bucketing: a large PR (e.g. 12 hunks) yields a non-empty High set sized ~20% and a Medium set ~30%, remainder Low; ordering within the result is score-desc.
- Deterministic tiebreak: two equal-score hunks keep a stable, path-then-index order across runs.
- Deep-link format: URL contains `/pull/<n>/files#diff-<64 hex chars>R<line>` for an additive hunk and `...L<line>` for a deletion-only hunk.
- `reason` is a non-empty single line naming the dominant signals.

### U2. `renderComment` — advisory ranked markdown

**Goal:** Pure `renderComment(rankedChunks)` producing the PR comment body.
**Requirements:** R3, R4, R5
**Dependencies:** U1 (consumes `RankedChunk[]`)
**Files:**
- `packages/core/src/render/renderComment.ts` (new)
- `packages/core/src/render/renderComment.test.ts` (new)
- `packages/core/src/index.ts` (add export)

**Approach:**
- Header: a short advisory title + one line framing it as attention-ordering, explicitly advisory (e.g. "Advisory only — this does not block, approve, or change the merge decision.").
- High then Medium sections: each item `- **[<Tier>]** [<file>:<line>](<deepLink>) — <reason>`.
- Low remainder: a single collapsed line, e.g. `Plus <k> lower-risk hunk(s) not listed.` Omit when zero Low.
- Empty input (`[]`): a friendly "no rankable changes in this PR" advisory line, still no merge language.
- Returns the body only — the worker/`upsertReviewComment` prepends the hidden marker. Do not emit block/approve/LGTM/merge wording anywhere.

**Patterns to follow:** `countHunks.ts` JSDoc tone; `apps/app/src/adapters/github.ts` `COMMENT_MARKER` is added by the adapter, not here.

**Test scenarios:**
- High+Medium+Low input: output contains a `[High]` and `[Medium]` line each with a markdown link and reason; contains exactly one Low summary line naming the Low count.
- Each listed item renders the deep-link as a markdown link and includes the tier label and the reason text.
- Low-only / zero-High edge: still renders the header and the one-line Low summary (High guarantee comes from U1, but `renderComment` must not crash on any tier mix).
- Empty `[]` → header + "no rankable changes" line, no thrown error.
- Tone assertion: output never contains "block", "approve", "LGTM", "request changes", or "merge" (case-insensitive) — encodes R4.
- Stable ordering: items appear High-before-Medium, preserving input order within a tier.

### U3. Wire ranking into the worker

**Goal:** Worker posts the ranked comment instead of the placeholder.
**Requirements:** R6, R5
**Dependencies:** U1, U2
**Files:**
- `apps/app/src/worker/handlePullRequestEvent.ts` (modify)
- `apps/app/src/worker/handlePullRequestEvent.test.ts` (modify)

**Approach:**
- Replace the `countHunks` + placeholder-body block with `const ranked = rankHunks(data, { owner, repo, prNumber })` then `const body = renderComment(ranked)`.
- Keep the `typeof data !== "string"` guard and the existing error/`upsertReviewComment` flow untouched (idempotency, fail-loud-on-non-string).
- Update the existing tests: drop the "N hunks detected" assertions, assert the new comment shape instead (still one comment on opened, still edits in place on synchronize, still posts something on a 0-hunk diff, still throws + posts nothing when the diff fetch fails).

**Patterns to follow:** existing `handlePullRequestEvent.ts` structure and its fake-Octokit test harness.

**Test scenarios:**
- Opened: creates exactly one marker comment whose body contains the ranking header (replaces "1 hunks detected").
- Synchronize: edits the same comment in place (no duplicate) — unchanged behavior.
- 0-hunk / empty diff: still posts a comment (the "no rankable changes" body).
- Diff fetch fails: throws, posts nothing — unchanged behavior.

---

## Scope Boundaries

In scope: the two pure functions, their exhaustive tests, and the worker wiring.

Not in scope (deferred to later issues, per `docs/ARCHITECTURE.md §9`):
- Semantic / LLM signals, the agentic review unit (#8).
- Fingerprint cache, reactions, convention store (#3, #8).
- Cost recording, the card-view UI (#12, #13).
- Persisting findings to a store — this slice posts the comment only.

### Deferred to Follow-Up Work
- Tuning the weight constants from real reaction data is a Review-Memory concern, not this cold-start slice.

---

## Risks & Mitigation

- **`parse-diff` field shapes** (`chunk.newStart`, `change.type`) — mitigate by deriving counts from `change.type` and covering new-file/deletion/rename fixtures in U1 tests.
- **Deep-link anchor format drift** — GitHub's `diff-<sha256>` anchor is stable and widely used; assert the structural shape in tests rather than a hardcoded hash.
- **Stacked on unmerged #1** — the PR targets `master` and notes the dependency; reviewer merges #14 first. No code risk, only merge ordering.

---

## Verification

- `pnpm test` green, including the new `rankHunks`/`renderComment` suites and the updated worker test.
- `pnpm lint` and `pnpm typecheck` clean.
- `core` still imports no vendor SDK (grep for `@ai-sdk`/`@anthropic` in `packages/core` returns nothing).

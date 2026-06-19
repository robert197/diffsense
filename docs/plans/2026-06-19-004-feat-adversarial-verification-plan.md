---
title: "feat: Adversarial verification pass"
date: 2026-06-19
type: feat
issue: robert197/diffsense#9
status: ready
---

# feat: Adversarial verification pass

## Summary

Add the precision lever to the pipeline: every High/Medium finding the review pass
produces is challenged by an independent LLM pass that is prompted to *refute* it,
using the same context. Refuted findings are dropped so they never surface as High
findings; surviving findings carry a verification verdict. The unit is
`verifyFinding(finding, context) -> { verdict, survives }`; an orchestrator applies
it across all High/Medium findings. This lands as a pure `core/verify` unit plus a
`LLMProvider.verifyFinding` method on the existing AI SDK adapter.

Closes #9. Depends on #8 (review unit + `ChunkReview`), which has landed.

---

## Problem Frame

Reviewers disengage from tools that cry wolf, so false positives must be killed
before they reach the comment (STRATEGY.md — risk-flag precision is a key metric).
The review unit (#8) produces a `ChunkReview` per chunk with a `rating` and
evidence-bearing `claims`, but nothing yet challenges those findings. A confident
but wrong finding (a null-deref that is actually guarded upstream) would surface as
High. We need an adversarial second pass that tries to break each finding and only
lets it through if it withstands the challenge.

This matches `docs/ARCHITECTURE.md` §3: verify is a **single structured call, not a
loop** — its inputs (the finding + its context) are already in hand. It is one of
the deterministic stages in the pipeline shell (§2), with the judgment living inside
the LLM call behind the `LLMProvider` port.

---

## Requirements

Traced from issue #9 acceptance criteria:

- **R1** — Each High/Medium finding is challenged by an independent refutation pass
  over the same context.
- **R2** — Refuted findings are dropped or downgraded and do not appear as High
  findings.
- **R3** — Surviving findings carry a verification verdict shown in the output.
- **R4** — A guarded-upstream false positive (a null-deref that is actually guarded)
  is verified away in a test fixture.

Non-negotiable rules that constrain the work (`CLAUDE.md`):

- `packages/core` imports no vendor SDK — verify is pure domain + Zod + the
  `LLMProvider` port.
- Provider-agnostic: the refutation call goes through `LLMProvider`, never an
  Anthropic SDK directly.
- The orchestration (which findings get challenged, drop-vs-keep) stays
  deterministic; only the per-finding refutation is the LLM call.

---

## Key Technical Decisions

- **KTD1 — A finding = a High/Medium `ChunkReview` paired with its chunk.** The
  review pass already emits per-chunk reviews with a `rating` (`high`/`medium`/`low`)
  and evidence-bearing `claims`. The natural verification granularity is the
  chunk-level review, not individual claims. The verify input is therefore
  `{ chunk: ReviewChunk, review: ChunkReview }` — the chunk is the context, the
  review is the risk. This avoids introducing a separate `Finding` schema before #11
  needs one (YAGNI).
- **KTD2 — Verdict schema is binary + rationale.** `VerificationVerdict =
  { refuted: boolean, rationale: string }`. `refuted: true` means the refutation
  succeeded (the finding does not hold up); `false` means the risk is real and
  survives. `rationale` carries the refutation argument or why the challenge failed.
  Minimal, provider-portable, and enough to satisfy R2/R3.
- **KTD3 — "Dropped" via `survives: false`, not rating mutation.** The orchestrator
  sets `survives = !verdict.refuted`. Consumers surface only survivors, so a refuted
  finding never appears as a High finding (R2). We keep the original `review` intact
  for transparency / the data moat (a refuted finding is still signal). We do not
  also mutate `rating` — that would conflate two mechanisms; `survives` is the single
  source of truth.
- **KTD4 — Verify is a single structured call, no tool loop** (`docs/ARCHITECTURE.md`
  §3). The adapter does one `generateText` + `Output.object` against the
  `VerificationVerdict` schema, no `tools`, no `stepCountIs`. The finding's
  evidence-bearing claims + the diff hunk are the context.
- **KTD5 — Verify routes to the review model.** The verdict needs a separate,
  refutation-framed call to be "independent" — independence is the prompt and the
  call, not the model. Using the review-tier model keeps cost bounded; no new
  `VERIFY_MODEL` env is introduced.
- **KTD6 — Only High/Medium findings are challenged.** Low-rated reviews are not
  risks to surface, so the orchestrator filters to `rating ∈ {high, medium}` and
  returns one `VerifiedFinding` per challenged finding, in input order.

---

## Implementation Units

### U1. `VerificationVerdict` schema

**Goal:** The Zod schema + type for the structured output of the refutation call.

**Requirements:** R3.

**Dependencies:** none.

**Files:**
- `packages/core/src/schemas/verification.ts` (create)
- `packages/core/src/schemas/verification.test.ts` (create)

**Approach:** Mirror `schemas/chunkReview.ts` — export `VerificationVerdictSchema`
(zod) and `VerificationVerdict` (inferred type). Fields: `refuted: z.boolean()`,
`rationale: z.string().min(1)`. Doc-comment that `refuted: true` = the finding does
not hold up, and that this is the provider-portable shape `core` and the adapter
both see.

**Patterns to follow:** `packages/core/src/schemas/chunkReview.ts` (schema + type
naming, doc-comment style).

**Test scenarios:**
- Happy path: a valid `{ refuted: true, rationale: "guarded by `if (user)`" }`
  parses.
- Edge: `rationale: ""` fails (min length 1).
- Edge: missing `refuted` fails.

---

### U2. `verifyFinding` on the `LLMProvider` port

**Goal:** Extend the port so `core` can request a refutation verdict, and add the
`VerifyRequest` type.

**Requirements:** R1.

**Dependencies:** U1.

**Files:**
- `packages/core/src/ports/llmProvider.ts` (modify)

**Approach:** Add `VerifyRequest = { review: ChunkReview; chunk: ReviewChunk }` and
`verifyFinding(request: VerifyRequest): Promise<VerificationVerdict>` to the
`LLMProvider` interface. Import `ChunkReview` (already used indirectly) and
`VerificationVerdict`. Keep the existing `reviewChunk` signature untouched. Note in
the doc-comment that verify is a single structured call (no tools), per
`docs/ARCHITECTURE.md` §3.

**Patterns to follow:** the existing `ReviewRequest` / `reviewChunk` shape in the
same file.

**Test scenarios:** Test expectation: none — pure interface + type addition,
exercised by U3/U4 tests via fakes.

---

### U3. `verifyFindings` orchestrator (`core/verify`)

**Goal:** The pure orchestration: challenge each High/Medium finding, drop refuted
ones, attach the verdict to survivors.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U1, U2.

**Files:**
- `packages/core/src/verify/verifyFinding.ts` (create)
- `packages/core/src/verify/verifyFinding.test.ts` (create)

**Approach:**
- `VerifiedFinding = { chunk, review, verdict, survives }`.
- `verifyFinding(finding, ports)` — the unit: calls `ports.llm.verifyFinding`,
  returns `{ ...finding, verdict, survives: !verdict.refuted }`.
- `verifyFindings(findings, ports)` — the orchestrator: filters inputs to
  `rating ∈ {high, medium}`, awaits `verifyFinding` for each (sequential, mirroring
  `reviewChunks`), returns `VerifiedFinding[]` in input order.
- Input type is structural (`{ chunk: ReviewChunk; review: ChunkReview }`) so a
  `ReviewResult` from the review pass is assignable without coupling to it.
- `VerifyPorts = { llm: LLMProvider }`.

**Patterns to follow:** `packages/core/src/review/reviewPass.ts` (deterministic
shell, injected ports, sequential loop, structural input types, doc-comment tone).

**Test scenarios:**
- Happy path: a high finding the fake LLM upholds (`refuted: false`) → `survives:
  true`, carries the verdict (R3).
- R1/R2: a high finding the fake LLM refutes (`refuted: true`) → `survives: false`;
  `verifyFindings(...).filter(v => v.survives)` excludes it, so it does not appear as
  a High finding.
- R6/KTD6: a low-rated review is not challenged — `verifyFindings` excludes it from
  output and the fake LLM is never called for it.
- A medium finding is challenged (proves it is not High-only).
- R4 fixture: a guarded null-deref. The finding claims a null-deref on `user.id`; the
  chunk patch contains the upstream guard (`if (user) { ... }`). A fake LLM that
  inspects the patch for a guard returns `refuted: true` for this finding → it is
  verified away (`survives: false`, absent from survivors). A second high finding
  with no guard in its patch is upheld and survives. Assert both.
- Provider-agnostic: swapping the fake adapter needs no change in the orchestrator
  (mirror the existing reviewPass test).

---

### U4. `verifyFinding` in the AI SDK adapter (`packages/llm`)

**Goal:** Implement the port method with a refutation prompt + single structured
call.

**Requirements:** R1, R3.

**Dependencies:** U1, U2.

**Files:**
- `packages/llm/src/index.ts` (modify)
- `packages/llm/src/index.test.ts` (modify)

**Approach:**
- Add `VERIFY_SYSTEM_PROMPT` — instructs the model it is an independent verifier
  whose job is to refute the finding (value guarded upstream, path unreachable, claim
  misreads the code, safe in context); a finding only survives if it withstands a
  genuine attempt to break it; be skeptical but honest.
- Add `buildVerifyPrompt({ review, chunk })` — renders file, tier, finding rating,
  explanation, numbered claims with evidence, reasons, and the diff hunk.
- In `createReviewProvider`'s returned object, add `verifyFinding(request)`: one
  `generateText({ model: model(config.reviewModel), system: VERIFY_SYSTEM_PROMPT,
  prompt: buildVerifyPrompt(request), output: Output.object({ schema:
  VerificationVerdictSchema }) })`, return `output`. No `tools`, no `stopWhen`.
- Import `VerificationVerdictSchema` and the `VerifyRequest` type from
  `@diffsense/core`.

**Patterns to follow:** the existing `reviewChunk` implementation, `REVIEW_SYSTEM_PROMPT`,
and `buildReviewPrompt` in the same file.

**Test scenarios:**
- `buildVerifyPrompt` includes the file, the finding rating, a claim with its
  evidence, and the diff hunk.
- `createReviewProvider({...}).verifyFinding` is a function for each supported vendor
  (extend the existing provider-shape test, or add a focused one).

---

### U5. Barrel exports

**Goal:** Export the new public surface from `@diffsense/core`.

**Requirements:** R1, R3.

**Dependencies:** U1, U3.

**Files:**
- `packages/core/src/index.ts` (modify)

**Approach:** Export `VerificationVerdict` + `VerificationVerdictSchema`; the
`VerifyRequest` type from the port; and `verifyFinding`, `verifyFindings`,
`VerifiedFinding`, `VerifyPorts` from `verify/verifyFinding.ts`. Keep the existing
alphabetical-ish grouping.

**Test scenarios:** Test expectation: none — re-exports, covered transitively by the
adapter test importing from `@diffsense/core`.

---

## Scope Boundaries

In scope: the `core/verify` unit, the verdict schema, the port method, the adapter
implementation, exports, and tests (including the R4 fixture).

### Deferred to Follow-Up Work

- Wiring verify into a pipeline shell (`runReview`) — there is no pipeline yet;
  `reviewChunks` is not called from the worker. Pipeline assembly is a later issue
  (#11/#12 territory).
- Rendering the verdict into the PR comment — `renderComment` (#12) consumes verified
  findings later; #9 only produces them.
- A dedicated `VERIFY_MODEL` env knob — not needed (KTD5).
- A separate `Finding` schema / `FindingStore` — introduced when #11/#13 need it.

---

## Test & Verification Strategy

- `pnpm test` (Vitest) — all new unit tests green, existing suite unbroken.
- `pnpm typecheck` — `tsc --noEmit` across packages.
- `pnpm lint` — Biome clean (organize-imports, formatting).
- The R4 fixture in `verifyFinding.test.ts` is the acceptance proof: a guarded
  null-deref is refuted and absent from survivors, while a real unguarded finding
  survives with its verdict.

---

## Risks & Dependencies

- **Depends on #8** — `ChunkReview`, `ReviewChunk`, `LLMProvider`, and the AI SDK
  adapter all exist and are exported. Verified in the current tree.
- **Low risk** — additive: one new schema, one new port method, one new pure unit,
  one adapter method. No existing signatures change, so the review pass and its tests
  are untouched.

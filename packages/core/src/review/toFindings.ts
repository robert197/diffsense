import type { ReviewFinding } from "../schemas/finding.js";
import type { ReviewResult } from "./reviewPass.js";

/**
 * Map review-pass output to persisted findings (issue #13). Pure: the blast
 * radius is resolved upstream (by the worker, via `CodeSearch`) and passed in as
 * a per-fingerprint lookup, so `core` stays free of I/O and the AST adapter.
 *
 * `rank` follows the order of `results` — the review pass already runs over the
 * risk-selected chunks highest-first, so index 0 is the highest-risk finding and
 * the card view renders in that order without re-sorting.
 */
export interface ToFindingsContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** Call sites per chunk fingerprint. Missing entries become an empty list. */
  blastRadius?: ReadonlyMap<string, readonly string[]>;
}

export function toFindings(
  results: readonly ReviewResult[],
  ctx: ToFindingsContext,
): ReviewFinding[] {
  return results.map((result, index) => ({
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    fingerprint: result.fingerprint,
    file: result.chunk.file,
    tier: result.chunk.tier,
    rank: index,
    explanation: result.review.explanation,
    claims: result.review.claims,
    reasons: result.review.reasons,
    blastRadius: [...(ctx.blastRadius?.get(result.fingerprint) ?? [])],
  }));
}

import type { LLMProvider } from "../ports/llmProvider.js";
import type { ReviewChunk } from "../review/reviewPass.js";
import type { ChunkReview, RiskRating } from "../schemas/chunkReview.js";
import type { VerificationVerdict } from "../schemas/verification.js";

/**
 * The adversarial verification pass (issue #9, docs/ARCHITECTURE.md §2–§3). Pure
 * orchestration: it decides *which* findings get challenged and *whether* each
 * survives — the judgment (the refutation argument) stays inside
 * `LLMProvider.verifyFinding`. Reviewers disengage from tools that cry wolf, so
 * false positives are killed here before they reach the comment.
 *
 * Deterministic and fully unit-testable with a fake `LLMProvider` (no network).
 */

/** A finding to verify: a review and the same chunk context it was produced from. */
export interface Finding {
  chunk: ReviewChunk;
  review: ChunkReview;
}

export interface VerifyPorts {
  llm: LLMProvider;
}

export interface VerifiedFinding {
  chunk: ReviewChunk;
  review: ChunkReview;
  /** The verification verdict — shown in the output so survivors carry their proof. */
  verdict: VerificationVerdict;
  /** False when the refutation succeeded — drop it from the surfaced findings. */
  survives: boolean;
}

/**
 * Ratings the verification pass challenges. Low-rated reviews are not risks to
 * surface, so they are never put before the refutation pass (KTD6).
 */
const CHALLENGED_RATINGS: ReadonlySet<RiskRating> = new Set<RiskRating>(["high", "medium"]);

/**
 * Challenge one finding: an independent pass tries to refute it. The finding
 * survives unless the refutation succeeds.
 */
export async function verifyFinding(
  finding: Finding,
  ports: VerifyPorts,
): Promise<VerifiedFinding> {
  const verdict = await ports.llm.verifyFinding({
    review: finding.review,
    chunk: finding.chunk,
  });
  return { chunk: finding.chunk, review: finding.review, verdict, survives: !verdict.refuted };
}

/**
 * Apply the verification pass to every High/Medium finding. Refuted findings come
 * back with `survives: false` — consumers surface only survivors, so a refuted
 * finding never appears as a High finding. Returns one `VerifiedFinding` per
 * challenged finding, in input order.
 */
export async function verifyFindings(
  findings: readonly Finding[],
  ports: VerifyPorts,
): Promise<VerifiedFinding[]> {
  const results: VerifiedFinding[] = [];
  for (const finding of findings) {
    if (CHALLENGED_RATINGS.has(finding.review.rating)) {
      results.push(await verifyFinding(finding, ports));
    }
  }
  return results;
}

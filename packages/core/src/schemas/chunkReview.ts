import { z } from "zod";

/**
 * The structured output of the agentic review unit for one chunk (issue #8,
 * docs/ARCHITECTURE.md §3). Schema-enforced so the shape is identical across any
 * LLM provider — the AI SDK validates against it, so `packages/core` and the
 * fingerprint cache only ever see a `ChunkReview`, never raw model text.
 *
 * Pure schema, no I/O. `packages/llm` produces it; `verify`/`synthesis` (#9,
 * #11) consume it; `FingerprintCache` persists it.
 */

/** Risk rating the review assigns to the chunk. */
export const RiskRating = z.enum(["high", "medium", "low"]);
export type RiskRating = z.infer<typeof RiskRating>;

/**
 * A single falsifiable claim about the change, each tied to concrete evidence so
 * a reviewer (or the #9 verify pass) can check or refute it. A claim with no
 * evidence is not actionable, so both fields are required.
 */
export const ReviewClaim = z.object({
  /** A falsifiable statement about what the change does or risks. */
  claim: z.string().min(1),
  /** Where it is grounded — a `path:line`, a symbol, or a quoted snippet. */
  evidence: z.string().min(1),
});
export type ReviewClaim = z.infer<typeof ReviewClaim>;

export const ChunkReviewSchema = z.object({
  /** Plain-language summary of what the change does. */
  explanation: z.string().min(1),
  /** Falsifiable claims, each tied to evidence. May be empty for a trivial change. */
  claims: z.array(ReviewClaim),
  /** The chunk's risk rating. */
  rating: RiskRating,
  /** Named reasons for the rating — at least one, so the score is never bare. */
  reasons: z.array(z.string().min(1)).min(1),
});
export type ChunkReview = z.infer<typeof ChunkReviewSchema>;

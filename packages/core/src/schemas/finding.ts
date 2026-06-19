import { z } from "zod";
import { ReviewClaim } from "./chunkReview.js";

/**
 * A persisted, card-ready review finding (issue #13, docs/ARCHITECTURE.md §6).
 *
 * This is the read-model the hosted card view renders: one finding per reviewed
 * chunk. It is distinct from `ChunkReview` (the agentic review unit's structured
 * output) — it carries the chunk's identity and its within-PR risk order, the
 * review content (explanation, claims, reasons), and the chunk's `blastRadius`
 * (call sites), which `ChunkReview` does not hold. Keeping blast radius here, not
 * on `ChunkReview`, leaves the #8 review schema and fingerprint cache untouched.
 *
 * Pure schema, no I/O. The worker produces it from a review pass; the
 * `FindingStore` persists it; `apps/web` reads it back and re-validates.
 */
export const ReviewFindingSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  /** Structural fingerprint of the chunk — the key reviewer refutes write against. */
  fingerprint: z.string().min(1),
  /** File the reviewed chunk belongs to. */
  file: z.string().min(1),
  /** Risk tier from the structural ranking. */
  tier: z.enum(["High", "Medium", "Low"]),
  /** Within-PR risk order, 0 = highest risk. Cards render in this order. */
  rank: z.number().int().nonnegative(),
  /** Plain-language summary of what the change does. */
  explanation: z.string().min(1),
  /** Falsifiable claims, each tied to evidence. May be empty for a trivial change. */
  claims: z.array(ReviewClaim),
  /** Named reasons for the rating — at least one, so the score is never bare. */
  reasons: z.array(z.string().min(1)).min(1),
  /** Call sites that depend on the change (the blast radius). May be empty. */
  blastRadius: z.array(z.string().min(1)),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

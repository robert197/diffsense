import { z } from "zod";
import { RiskRating } from "./chunkReview.js";

/**
 * The structured output of PR-level synthesis (issue #11, docs/ARCHITECTURE.md
 * §2–§3). Synthesis is a single structured call on the synthesis-class model
 * (`claude-fable-5`) that rolls the verified per-chunk findings and the
 * scope-creep assessment up into one glanceable-but-auditable result.
 *
 * Deliberately there is NO single opaque numeric score: the named, chunk-linked
 * risk positions plus the intent-coverage summary and overview ARE the
 * replacement (STRATEGY.md — own the reviewer's attention, stay auditable).
 *
 * Pure schema, no I/O. `packages/llm` produces it via `generateObject`; the
 * `apps/web` card view (issue #13) reads it back.
 */

/**
 * One named risk position — a senior-reviewer grouping of related findings, e.g.
 * "2 unverified API-boundary changes" or "1 undeclared data-model edit". Each
 * position must link back to the chunks that created it, so the reviewer can
 * jump straight from the glance to the evidence.
 */
export const RiskPositionSchema = z.object({
  /** Glanceable name for the position, counting what it covers. */
  title: z.string().min(1),
  /** Senior-reviewer explanation: why these group together and what to check. */
  detail: z.string().min(1),
  /**
   * Categorical severity (high/medium/low). Auditable and per-position — never a
   * single opaque number rolled up for the whole PR.
   */
  severity: RiskRating,
  /**
   * The chunks this position is drawn from, referenced by file path. At least
   * one — a position with no chunk link is not auditable, so it is not allowed.
   */
  chunks: z.array(z.string().min(1)).min(1),
});
export type RiskPosition = z.infer<typeof RiskPositionSchema>;

export const PortfolioSchema = z.object({
  /**
   * The named, chunk-linked risk positions. Empty when nothing survived
   * verification and the diff stayed within its stated intent.
   */
  positions: z.array(RiskPositionSchema),
  /** How well the change matches its stated intent (on-scope / over / under). */
  intentCoverage: z.string().min(1),
  /** Senior-reviewer-style overview of the PR's risk surface. */
  overview: z.string().min(1),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

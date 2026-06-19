import { z } from "zod";

/**
 * The structured output of the adversarial verification pass (issue #9,
 * docs/ARCHITECTURE.md §3). An independent LLM call, prompted to *refute* a
 * finding from the review pass, returns this verdict — the precision lever that
 * kills false positives before they reach the comment (STRATEGY.md — risk-flag
 * precision).
 *
 * Pure schema, no I/O. `packages/llm` produces it via a single structured call;
 * `core/verify` consumes it to decide whether a finding survives. Provider-portable:
 * the AI SDK validates against it, so `core` and the adapter only ever see this
 * shape, never raw model text.
 */
export const VerificationVerdictSchema = z.object({
  /**
   * True when the refutation succeeded — the finding does not hold up (drop it).
   * False when the risk is real and withstands the challenge (it survives).
   */
  refuted: z.boolean(),
  /** The refutation argument when refuted, or why the challenge fails when it stands. */
  rationale: z.string().min(1),
});
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

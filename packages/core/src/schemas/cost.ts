import { z } from "zod";

/**
 * Token usage for inference-cost logging (issue #12, docs/ARCHITECTURE.md §2 —
 * `recordCost`). Pure schema, no I/O. The worker collects one `ModelUsage` per
 * model call across the review and verification passes; `recordCost` turns the
 * list into a USD figure via a rate table and persists it through `CostStore`.
 *
 * This is product observability — a logged cost per PR and a threshold flag, not
 * an experiment harness (issue #12).
 */
export const ModelUsageSchema = z.object({
  /** Model id the call ran on — the key into the rate table. */
  model: z.string().min(1),
  /** Prompt/input tokens the call consumed. */
  inputTokens: z.number().int().nonnegative(),
  /** Completion/output tokens the call produced. */
  outputTokens: z.number().int().nonnegative(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/** Per-PR usage: every model call across the review + verification passes. */
export const PrUsageSchema = z.array(ModelUsageSchema);
export type PrUsage = z.infer<typeof PrUsageSchema>;

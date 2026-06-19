import { z } from "zod";

/**
 * The structured output of the intent / scope-creep pass (issue #10,
 * docs/ARCHITECTURE.md §2–§3). The diff is mapped against the PR's declared
 * intent; regions that match no declared intent are the highest-risk content in
 * an AI-generated PR (undeclared, drive-by edits) and surface as a distinct
 * finding class — no competitor isolates them (STRATEGY.md).
 *
 * Pure schema, no I/O. `packages/llm` produces it via a single structured call
 * (the inputs — diff + intent — are already in hand, §3); `core/scope` consumes
 * it. Provider-portable: the AI SDK validates against it, so `core` and the
 * adapter only ever see this shape, never raw model text.
 */

/** A changed region that matches none of the PR's declared intents. */
export const ScopeFindingSchema = z.object({
  /** The file the undeclared change lives in — a path as it appears in the diff. */
  file: z.string().min(1),
  /** What the out-of-scope edit does, in plain language. */
  summary: z.string().min(1),
  /** Why it matches none of the PR's declared intents. */
  rationale: z.string().min(1),
});
export type ScopeFinding = z.infer<typeof ScopeFindingSchema>;

export const ScopeCreepReportSchema = z.object({
  /** The distinct intents read out of the PR title + description — the map's keys. */
  declaredIntents: z.array(z.string().min(1)),
  /** Changed regions matching no declared intent — the scope-creep findings. */
  findings: z.array(ScopeFindingSchema),
});
export type ScopeCreepReport = z.infer<typeof ScopeCreepReportSchema>;

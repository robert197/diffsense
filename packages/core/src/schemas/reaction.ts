import { z } from "zod";

/**
 * The reviewer precision signal — a 👍/👎 on a flagged chunk (issue #3).
 *
 * Pure schema, no I/O. `tier` records which bucket the chunk was in when the
 * reviewer reacted, so precision can be measured per tier (STRATEGY.md — the
 * risk-flag precision metric) without any separate instrumentation. The
 * `ReactionStore` port persists it; the db adapter lives in `apps/app`.
 */
export const ChunkReactionSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  /** Stable chunk id from `RankedChunk.fingerprint`. */
  fingerprint: z.string().min(1),
  tier: z.enum(["High", "Medium", "Low"]),
  sentiment: z.enum(["up", "down"]),
});

export type ChunkReaction = z.infer<typeof ChunkReactionSchema>;

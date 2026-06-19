export { countHunks } from "./diff/countHunks.js";
export { type DemotionReason, classifyDemotion } from "./diff/demote.js";
export type { ReactionStore } from "./ports/reactionStore.js";
export {
  rankHunks,
  type PrMeta,
  type RankedChunk,
  type RankedSignals,
  type RiskCategory,
  type Tier,
} from "./rank/rankHunks.js";
export { type ReactionOptions, renderComment } from "./render/renderComment.js";
export { type ChunkReaction, ChunkReactionSchema } from "./schemas/reaction.js";

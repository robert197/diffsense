export { countHunks } from "./diff/countHunks.js";
export { type DemotionReason, classifyDemotion } from "./diff/demote.js";
export type { CodeReference, CodeSearch } from "./ports/codeSearch.js";
export type { ConventionStore, RepoRef } from "./ports/conventionStore.js";
export type { LineRange, PrIntent, RepoReader } from "./ports/repoReader.js";
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
export {
  type ReviewTool,
  type ReviewToolPorts,
  createReviewTools,
  FindCallSitesInput,
  NoInput,
  ReadFileInput,
} from "./review/tools.js";
export { type ChunkReaction, ChunkReactionSchema } from "./schemas/reaction.js";

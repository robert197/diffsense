export { countHunks } from "./diff/countHunks.js";
export { type DemotionReason, classifyDemotion } from "./diff/demote.js";
export type { CodeReference, CodeSearch } from "./ports/codeSearch.js";
export type { ConventionStore, RepoRef } from "./ports/conventionStore.js";
export type { FingerprintCache } from "./ports/fingerprintCache.js";
export type {
  LLMProvider,
  ReviewModelClass,
  ReviewRequest,
  ScopeRequest,
  SynthesisFinding,
  SynthesisRequest,
  VerifyRequest,
} from "./ports/llmProvider.js";
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
export { type ScopeCreepPorts, detectScopeCreep } from "./scope/detectScopeCreep.js";
export { fingerprintChunk } from "./review/fingerprint.js";
export {
  type ReviewChunk,
  type ReviewPassPorts,
  type ReviewResult,
  modelClassForTier,
  reviewChunks,
  selectReviewChunks,
} from "./review/reviewPass.js";
export {
  type AnyReviewTool,
  type ReviewTool,
  type ReviewToolPorts,
  createReviewTools,
  FindCallSitesInput,
  NoInput,
  ReadFileInput,
} from "./review/tools.js";
export {
  type ChunkReview,
  ChunkReviewSchema,
  ReviewClaim,
  RiskRating,
} from "./schemas/chunkReview.js";
export {
  type Portfolio,
  PortfolioSchema,
  type RiskPosition,
  RiskPositionSchema,
} from "./schemas/portfolio.js";
export { type ChunkReaction, ChunkReactionSchema } from "./schemas/reaction.js";
export {
  type ScopeCreepReport,
  ScopeCreepReportSchema,
  type ScopeFinding,
  ScopeFindingSchema,
} from "./schemas/scopeCreep.js";
export {
  type VerificationVerdict,
  VerificationVerdictSchema,
} from "./schemas/verification.js";
export {
  type ScopeAssessment,
  type SynthesisPorts,
  synthesizePortfolio,
} from "./synthesis/synthesizePortfolio.js";
export {
  type Finding,
  type VerifiedFinding,
  type VerifyPorts,
  verifyFinding,
  verifyFindings,
} from "./verify/verifyFinding.js";

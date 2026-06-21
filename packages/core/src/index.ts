export { countHunks } from "./diff/countHunks.js";
export { type DemotionReason, classifyDemotion } from "./diff/demote.js";
export type { CodeReference, CodeSearch } from "./ports/codeSearch.js";
export type { ConventionStore, RepoRef } from "./ports/conventionStore.js";
export type { CostStore, PrCostRecord } from "./ports/costStore.js";
export type { DeckRef, DeckStore } from "./ports/deckStore.js";
export type { FingerprintCache } from "./ports/fingerprintCache.js";
export type { FindingPrRef, FindingStore } from "./ports/findingStore.js";
export type {
  LLMProvider,
  LocalizeRequest,
  ReviewModelClass,
  ReviewRequest,
  ScopeRequest,
  SynthesisFinding,
  SynthesisRequest,
  VerifyRequest,
} from "./ports/llmProvider.js";
export type { LocalizationKey, LocalizationStore } from "./ports/localizationStore.js";
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
export {
  type CostComputation,
  type CostPrRef,
  type ModelRate,
  type RateTable,
  type RecordCostPorts,
  computeCost,
  recordCost,
} from "./cost/recordCost.js";
export { type CardViewPr, cardViewLink } from "./render/cardViewLink.js";
export {
  type ReactionOptions,
  type ReactionTier,
  reactionAffordance,
} from "./render/reactionLink.js";
export {
  type CommentFinding,
  type RenderCommentOptions,
  renderComment,
} from "./render/renderComment.js";
export { MAX_LISTED, renderRankedComment } from "./render/renderRankedComment.js";
export { type ScopeCreepPorts, detectScopeCreep } from "./scope/detectScopeCreep.js";
export { buildDeck } from "./deck/buildDeck.js";
export {
  type LocalizePorts,
  type LocalizeRef,
  localizeCards,
} from "./localize/localizeCards.js";
export { fingerprintChunk } from "./review/fingerprint.js";
export {
  type ReviewChunk,
  type ReviewPassPorts,
  type ReviewResult,
  modelClassForTier,
  reviewChunks,
  selectReviewChunks,
} from "./review/reviewPass.js";
export { type ToFindingsContext, toFindings } from "./review/toFindings.js";
export {
  type ReviewFindingsContext,
  type ReviewFindingsPorts,
  buildReviewChunks,
  extractSymbols,
  reviewAndPersistFindings,
} from "./review/reviewFindings.js";
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
  type Card,
  CardSchema,
  type Deck,
  DeckSchema,
  type HighlightRange,
  HighlightRangeSchema,
} from "./schemas/card.js";
export {
  type ChunkReview,
  ChunkReviewSchema,
  ReviewClaim,
  RiskRating,
} from "./schemas/chunkReview.js";
export {
  DEFAULT_LANGUAGE,
  LANGUAGE_CODES,
  type LanguageCode,
  LanguageCodeSchema,
  type LocalizedCard,
  LocalizedCardSchema,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  isSupportedLanguage,
  languageName,
  resolveLanguage,
} from "./schemas/localization.js";
export { type ReviewFinding, ReviewFindingSchema } from "./schemas/finding.js";
export {
  type Portfolio,
  PortfolioSchema,
  type RiskPosition,
  RiskPositionSchema,
} from "./schemas/portfolio.js";
export {
  type ModelUsage,
  ModelUsageSchema,
  type PrUsage,
  PrUsageSchema,
} from "./schemas/cost.js";
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

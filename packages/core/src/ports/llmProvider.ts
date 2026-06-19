import type { ReviewChunk } from "../review/reviewPass.js";
import type { AnyReviewTool } from "../review/tools.js";
import type { ChunkReview, RiskRating } from "../schemas/chunkReview.js";
import type { Portfolio } from "../schemas/portfolio.js";
import type { ScopeCreepReport } from "../schemas/scopeCreep.js";
import type { VerificationVerdict } from "../schemas/verification.js";
import type { ScopeAssessment } from "../synthesis/synthesizePortfolio.js";
import type { PrIntent } from "./repoReader.js";

/**
 * Port: the provider-agnostic LLM seam (docs/STACK.md "LLM provider
 * independence"). `core` depends only on this interface and Zod — never on
 * `@ai-sdk/*` or `@anthropic-ai/*`. `packages/llm` implements it with the Vercel
 * AI SDK, choosing provider + model from env, so swapping Anthropic→OpenAI→Gemini
 * is a config change that never touches `core`.
 */

/**
 * Which model tier a request routes to. The deterministic shell decides this
 * (top-risk chunks earn the stronger synthesis-class model); the adapter maps
 * each class to a concrete model id from env (`REVIEW_MODEL` / `SYNTHESIS_MODEL`).
 */
export type ReviewModelClass = "review" | "synthesis";

/** Everything the review unit needs to review one chunk. */
export interface ReviewRequest {
  /** The chunk under review — its file, tier, and patch text. */
  chunk: ReviewChunk;
  /** Which model tier to use (set by `core`, applied by the adapter). */
  modelClass: ReviewModelClass;
  /** Context tools the agentic unit may call on demand (from #7). */
  tools: readonly AnyReviewTool[];
}

/**
 * Everything the adversarial verification pass needs to challenge one finding
 * (issue #9). Verify is a *single structured call, not a tool loop*
 * (docs/ARCHITECTURE.md §3): the context is already in hand — the finding's
 * evidence-bearing claims plus the diff hunk it is about.
 */
export interface VerifyRequest {
  /** The finding under challenge — the review's risk content (claims, rating, reasons). */
  review: ChunkReview;
  /** The same chunk context the review saw: file, tier, patch. */
  chunk: ReviewChunk;
}

/**
 * Everything the intent / scope-creep pass needs to map a diff against the PR's
 * declared intent (issue #10). Like verify, it is a *single structured call, not a
 * tool loop* (docs/ARCHITECTURE.md §3): the inputs — the whole diff and the
 * declared intent — are already in hand.
 */
export interface ScopeRequest {
  /** The full unified diff of the PR. */
  diff: string;
  /** The PR's declared intent — title + description — to map the diff against. */
  intent: PrIntent;
}

/**
 * One verified, surviving finding as synthesis sees it (issue #11). `chunkRef` is
 * the stable link target a portfolio position cites back to — the file the chunk
 * belongs to.
 */
export interface SynthesisFinding {
  /** Reference a portfolio position links back to (the chunk's file path). */
  chunkRef: string;
  /** File the chunk belongs to. */
  file: string;
  /** The finding's risk rating. */
  rating: RiskRating;
  /** The full review content — explanation, claims, reasons. */
  review: ChunkReview;
}

/**
 * Everything PR-level synthesis needs (issue #11). Like verify, a *single
 * structured call, not a tool loop* (docs/ARCHITECTURE.md §3): the verified
 * findings, the scope-creep assessment, and the stated intent are all in hand.
 */
export interface SynthesisRequest {
  /** The verified survivors — refuted findings are already gone (#9). */
  findings: readonly SynthesisFinding[];
  /** Scope-creep assessment of the whole diff vs the stated intent (#10). */
  scope: ScopeAssessment;
  /** The PR's stated intent. */
  intent: PrIntent;
}

export interface LLMProvider {
  /** Review one chunk, returning a Zod-validated `ChunkReview`. */
  reviewChunk(request: ReviewRequest): Promise<ChunkReview>;
  /**
   * Independently challenge a finding, prompted to refute it, returning a
   * Zod-validated `VerificationVerdict`. The precision lever (issue #9).
   */
  verifyFinding(request: VerifyRequest): Promise<VerificationVerdict>;
  /**
   * Map the diff against the PR's declared intent, returning a Zod-validated
   * `ScopeCreepReport` whose findings are the regions matching no declared intent
   * (issue #10).
   */
  detectScopeCreep(request: ScopeRequest): Promise<ScopeCreepReport>;
  /**
   * Synthesize the verified findings + scope assessment into a PR-level
   * `Portfolio`: named, chunk-linked risk positions, an intent-coverage summary,
   * and an overview — no single opaque score. Runs on the synthesis-class model
   * (issue #11).
   */
  synthesize(request: SynthesisRequest): Promise<Portfolio>;
}

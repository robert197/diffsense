import type { ReviewChunk } from "../review/reviewPass.js";
import type { AnyReviewTool } from "../review/tools.js";
import type { ChunkReview } from "../schemas/chunkReview.js";
import type { ScopeCreepReport } from "../schemas/scopeCreep.js";
import type { VerificationVerdict } from "../schemas/verification.js";
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
}

import type { RepoRef } from "../ports/conventionStore.js";
import type { FingerprintCache } from "../ports/fingerprintCache.js";
import type { LLMProvider, ReviewModelClass } from "../ports/llmProvider.js";
import type { Tier } from "../rank/rankHunks.js";
import type { ChunkReview } from "../schemas/chunkReview.js";
import { fingerprintChunk } from "./fingerprint.js";
import type { AnyReviewTool } from "./tools.js";

/**
 * The deterministic shell around the agentic review unit (docs/ARCHITECTURE.md
 * §2–§3). Pure orchestration: it decides *which* chunks get an LLM pass, *which*
 * model tier each routes to, and *when* a cached result is reused — judgment
 * stays inside `LLMProvider.reviewChunk`. Injected ports keep it fully
 * unit-testable with fakes (no network, no DB).
 */

/** A chunk handed to the review pass: ranking output plus the patch to review. */
export interface ReviewChunk {
  /** Path of the file the chunk belongs to. */
  file: string;
  /** Risk tier from `rankHunks` — drives both selection and model routing. */
  tier: Tier;
  /** The unified-diff text of this hunk: the change under review + cache key input. */
  patch: string;
  /** True when the reviewer explicitly opened/expanded this chunk in GitHub. */
  openedByReviewer?: boolean;
}

export interface ReviewPassPorts {
  llm: LLMProvider;
  cache: FingerprintCache;
  /** Context tools the review unit may call (built by `createReviewTools`). */
  tools: readonly AnyReviewTool[];
  /** The repo the cache is scoped to. */
  repo: RepoRef;
}

export interface ReviewResult {
  chunk: ReviewChunk;
  /** Structural fingerprint used as the cache key. */
  fingerprint: string;
  review: ChunkReview;
  /** True when served from the fingerprint cache — i.e. no LLM call was issued. */
  cached: boolean;
}

/**
 * Route the top risk tier to the synthesis-class model, everything else to the
 * review model. Deterministic — it is cost/attention control, not judgment.
 */
export function modelClassForTier(tier: Tier): ReviewModelClass {
  return tier === "High" ? "synthesis" : "review";
}

/**
 * The margin guard: the LLM pass runs on top-risk (High tier) and
 * reviewer-opened chunks only, never on every hunk — inference follows
 * attention, not PR size (issue #8, docs/ARCHITECTURE.md §2).
 */
export function selectReviewChunks(chunks: readonly ReviewChunk[]): ReviewChunk[] {
  return chunks.filter((chunk) => chunk.tier === "High" || chunk.openedByReviewer === true);
}

/**
 * Run the LLM review pass over the selected chunks. For each: compute its
 * structural fingerprint, reuse the cached review on a hit (no LLM call), else
 * call the routed model and cache the result.
 */
export async function reviewChunks(
  chunks: readonly ReviewChunk[],
  ports: ReviewPassPorts,
): Promise<ReviewResult[]> {
  const { llm, cache, tools, repo } = ports;
  const results: ReviewResult[] = [];

  for (const chunk of selectReviewChunks(chunks)) {
    const fingerprint = fingerprintChunk(chunk.file, chunk.patch);

    const cached = await cache.get(repo, fingerprint);
    if (cached) {
      results.push({ chunk, fingerprint, review: cached, cached: true });
      continue;
    }

    const review = await llm.reviewChunk({
      chunk,
      modelClass: modelClassForTier(chunk.tier),
      tools,
    });
    await cache.set(repo, fingerprint, review);
    results.push({ chunk, fingerprint, review, cached: false });
  }

  return results;
}

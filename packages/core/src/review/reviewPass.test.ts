import { describe, expect, it, vi } from "vitest";
import type { FingerprintCache } from "../ports/fingerprintCache.js";
import type { LLMProvider, ReviewRequest } from "../ports/llmProvider.js";
import type { ChunkReview } from "../schemas/chunkReview.js";
import { fingerprintChunk } from "./fingerprint.js";
import {
  type ReviewChunk,
  modelClassForTier,
  reviewChunks,
  selectReviewChunks,
} from "./reviewPass.js";

const REPO = { owner: "octo-org", repo: "demo" };

function review(explanation: string): ChunkReview {
  return {
    explanation,
    claims: [{ claim: "does a thing", evidence: "src/x.ts:1" }],
    rating: "low",
    reasons: ["small change"],
  };
}

function chunk(over: Partial<ReviewChunk> & Pick<ReviewChunk, "file" | "tier">): ReviewChunk {
  return { patch: `+// change to ${over.file}`, ...over };
}

/** A fake provider that records every request and returns a tagged review. */
function fakeProvider(tag = "fake") {
  const requests: ReviewRequest[] = [];
  const provider: LLMProvider = {
    reviewChunk: vi.fn(async (request: ReviewRequest) => {
      requests.push(request);
      return review(`${tag}:${request.chunk.file}:${request.modelClass}`);
    }),
    // The review pass never verifies or synthesizes — fail loudly if a refactor wires either in here.
    verifyFinding: vi.fn().mockRejectedValue(new Error("verifyFinding not expected in reviewPass")),
    synthesize: vi.fn().mockRejectedValue(new Error("synthesize not expected in reviewPass")),
  };
  return { provider, requests };
}

/** An in-memory fingerprint cache, optionally pre-seeded. */
function fakeCache(seed: Record<string, ChunkReview> = {}) {
  const store = new Map<string, ChunkReview>(Object.entries(seed));
  const cache: FingerprintCache = {
    get: vi.fn(async (_repo, fp: string) => store.get(fp) ?? null),
    set: vi.fn(async (_repo, fp: string, value: ChunkReview) => {
      store.set(fp, value);
    }),
  };
  return { cache, store };
}

describe("selectReviewChunks", () => {
  it("keeps High-tier chunks and reviewer-opened chunks, drops the rest", () => {
    const chunks: ReviewChunk[] = [
      chunk({ file: "high.ts", tier: "High" }),
      chunk({ file: "med.ts", tier: "Medium" }),
      chunk({ file: "low.ts", tier: "Low" }),
      chunk({ file: "opened.ts", tier: "Low", openedByReviewer: true }),
    ];
    expect(selectReviewChunks(chunks).map((c) => c.file)).toEqual(["high.ts", "opened.ts"]);
  });
});

describe("modelClassForTier", () => {
  it("routes the top tier to synthesis, everything else to review", () => {
    expect(modelClassForTier("High")).toBe("synthesis");
    expect(modelClassForTier("Medium")).toBe("review");
    expect(modelClassForTier("Low")).toBe("review");
  });
});

describe("reviewChunks", () => {
  it("reviews only top-risk + opened chunks, not every hunk", async () => {
    const { provider, requests } = fakeProvider();
    const { cache } = fakeCache();
    const chunks: ReviewChunk[] = [
      chunk({ file: "high.ts", tier: "High" }),
      chunk({ file: "med.ts", tier: "Medium" }),
      chunk({ file: "low.ts", tier: "Low" }),
      chunk({ file: "opened.ts", tier: "Low", openedByReviewer: true }),
    ];

    const results = await reviewChunks(chunks, { llm: provider, cache, tools: [], repo: REPO });

    expect(results.map((r) => r.chunk.file)).toEqual(["high.ts", "opened.ts"]);
    expect(requests.map((r) => r.chunk.file)).toEqual(["high.ts", "opened.ts"]);
  });

  it("routes top-tier chunks to the synthesis model and others to the review model", async () => {
    const { provider, requests } = fakeProvider();
    const { cache } = fakeCache();
    const chunks: ReviewChunk[] = [
      chunk({ file: "high.ts", tier: "High" }),
      chunk({ file: "opened-med.ts", tier: "Medium", openedByReviewer: true }),
    ];

    await reviewChunks(chunks, { llm: provider, cache, tools: [], repo: REPO });

    const byFile = Object.fromEntries(requests.map((r) => [r.chunk.file, r.modelClass]));
    expect(byFile["high.ts"]).toBe("synthesis");
    expect(byFile["opened-med.ts"]).toBe("review");
  });

  it("reuses a cached review on a fingerprint hit and issues no LLM call", async () => {
    const target = chunk({ file: "high.ts", tier: "High" });
    const fp = fingerprintChunk(target.file, target.patch);
    const cachedReview = review("from-cache");
    const { provider, requests } = fakeProvider();
    const { cache } = fakeCache({ [fp]: cachedReview });

    const results = await reviewChunks([target], { llm: provider, cache, tools: [], repo: REPO });

    expect(results).toHaveLength(1);
    expect(results[0]?.cached).toBe(true);
    expect(results[0]?.review).toEqual(cachedReview);
    expect(provider.reviewChunk).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("calls the LLM on a cache miss and stores the result under its fingerprint", async () => {
    const target = chunk({ file: "high.ts", tier: "High" });
    const fp = fingerprintChunk(target.file, target.patch);
    const { provider } = fakeProvider();
    const { cache, store } = fakeCache();

    const results = await reviewChunks([target], { llm: provider, cache, tools: [], repo: REPO });

    expect(results[0]?.cached).toBe(false);
    expect(results[0]?.fingerprint).toBe(fp);
    expect(provider.reviewChunk).toHaveBeenCalledOnce();
    expect(cache.set).toHaveBeenCalledWith(REPO, fp, results[0]?.review);
    expect(store.get(fp)).toEqual(results[0]?.review);
  });

  it("is provider-agnostic: swapping the adapter needs no change in core", async () => {
    const chunks: ReviewChunk[] = [chunk({ file: "high.ts", tier: "High" })];

    // Two different fake adapters stand in for two providers (e.g. anthropic vs
    // openai). `reviewChunks` — the only `core` entry point — is identical for both.
    const anthropic = fakeProvider("anthropic");
    const openai = fakeProvider("openai");

    const a = await reviewChunks(chunks, {
      llm: anthropic.provider,
      cache: fakeCache().cache,
      tools: [],
      repo: REPO,
    });
    const b = await reviewChunks(chunks, {
      llm: openai.provider,
      cache: fakeCache().cache,
      tools: [],
      repo: REPO,
    });

    expect(a[0]?.review.explanation).toContain("anthropic:");
    expect(b[0]?.review.explanation).toContain("openai:");
  });
});

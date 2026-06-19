import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, VerifyRequest } from "../ports/llmProvider.js";
import type { ReviewChunk } from "../review/reviewPass.js";
import type { ChunkReview, RiskRating } from "../schemas/chunkReview.js";
import type { VerificationVerdict } from "../schemas/verification.js";
import { type Finding, verifyFinding, verifyFindings } from "./verifyFinding.js";

function chunk(file: string, patch: string): ReviewChunk {
  return { file, tier: "High", patch };
}

function review(rating: RiskRating, claim: string, evidence: string): ChunkReview {
  return {
    explanation: `review of ${claim}`,
    claims: [{ claim, evidence }],
    rating,
    reasons: [`rated ${rating}`],
  };
}

function finding(file: string, patch: string, rating: RiskRating, claim: string): Finding {
  return { chunk: chunk(file, patch), review: review(rating, claim, `${file}:1`) };
}

/** A fake verifier that records requests and refutes via a caller-supplied rule. */
function fakeVerifier(refute: (req: VerifyRequest) => boolean) {
  const requests: VerifyRequest[] = [];
  const provider: LLMProvider = {
    reviewChunk: vi.fn(),
    verifyFinding: vi.fn(async (request: VerifyRequest): Promise<VerificationVerdict> => {
      requests.push(request);
      const refuted = refute(request);
      return { refuted, rationale: refuted ? "challenge succeeded" : "risk holds" };
    }),
    synthesize: vi.fn(),
  };
  return { provider, requests };
}

describe("verifyFinding", () => {
  it("threads the chunk and review through and maps survives to !refuted", async () => {
    const { provider } = fakeVerifier(() => true);
    const input = finding("a.ts", "+x", "high", "claim");
    const result = await verifyFinding(input, { llm: provider });

    expect(result.chunk).toBe(input.chunk);
    expect(result.review).toBe(input.review);
    expect(result.survives).toBe(false);
    expect(result.verdict.refuted).toBe(true);
  });
});

describe("verifyFindings", () => {
  it("returns an empty array and calls no LLM for empty input", async () => {
    const { provider } = fakeVerifier(() => false);
    const results = await verifyFindings([], { llm: provider });

    expect(results).toEqual([]);
    expect(provider.verifyFinding).not.toHaveBeenCalled();
  });

  it("propagates an LLM rejection to the caller", async () => {
    const provider: LLMProvider = {
      reviewChunk: vi.fn(),
      verifyFinding: vi.fn().mockRejectedValue(new Error("provider down")),
      synthesize: vi.fn(),
    };

    await expect(
      verifyFindings([finding("a.ts", "+x", "high", "claim")], { llm: provider }),
    ).rejects.toThrow("provider down");
  });

  it("keeps a finding the refutation pass cannot break, carrying its verdict", async () => {
    const { provider } = fakeVerifier(() => false);
    const results = await verifyFindings([finding("a.ts", "+danger", "high", "real bug")], {
      llm: provider,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.survives).toBe(true);
    expect(results[0]?.verdict).toEqual({ refuted: false, rationale: "risk holds" });
  });

  it("drops a refuted finding so it does not appear as a High finding", async () => {
    const { provider } = fakeVerifier(() => true);
    const results = await verifyFindings([finding("a.ts", "+x", "high", "false alarm")], {
      llm: provider,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.survives).toBe(false);
    // The criterion: a refuted finding is not among the survivors that get surfaced.
    expect(results.filter((r) => r.survives)).toHaveLength(0);
  });

  it("challenges Medium findings too, not only High", async () => {
    const { provider, requests } = fakeVerifier(() => false);
    await verifyFindings([finding("a.ts", "+x", "medium", "medium risk")], { llm: provider });

    expect(requests).toHaveLength(1);
  });

  it("does not challenge Low-rated reviews — they are not findings to surface", async () => {
    const { provider, requests } = fakeVerifier(() => false);
    const results = await verifyFindings([finding("a.ts", "+x", "low", "trivial")], {
      llm: provider,
    });

    expect(results).toHaveLength(0);
    expect(provider.verifyFinding).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("verifies away a guarded-upstream false positive but keeps a real bug (fixture)", async () => {
    // A guarded null-deref: the patch adds a guard, so the null-deref claim is a
    // false positive. A real reviewer (and the fake verifier) refutes it by
    // spotting the guard. An unguarded deref has no such defence and survives.
    const guarded = finding(
      "src/user.ts",
      [
        "@@",
        "+function greet(user: User | null) {",
        "+  if (user) {",
        "+    return `hi ${user.id}`;",
        "+  }",
        "+  return 'hi';",
        "+}",
      ].join("\n"),
      "high",
      "null-deref: user.id may be accessed when user is null",
    );
    const unguarded = finding(
      "src/order.ts",
      ["@@", "+function total(order: Order | null) {", "+  return order.amount;", "+}"].join("\n"),
      "high",
      "null-deref: order.amount accessed when order may be null",
    );

    // Refute when the patch contains an `if (<var>)` guard for the dereferenced value.
    const { provider } = fakeVerifier((req) => /\n\+\s*if \(\w+\)/.test(req.chunk.patch));
    const results = await verifyFindings([guarded, unguarded], { llm: provider });

    const survivors = results.filter((r) => r.survives);
    expect(survivors.map((r) => r.chunk.file)).toEqual(["src/order.ts"]);

    const guardedResult = results.find((r) => r.chunk.file === "src/user.ts");
    expect(guardedResult?.survives).toBe(false);
    expect(guardedResult?.verdict.refuted).toBe(true);
  });

  it("is provider-agnostic: swapping the adapter needs no change in core", async () => {
    const findings = [finding("a.ts", "+x", "high", "risk")];
    const anthropic = fakeVerifier(() => false);
    const openai = fakeVerifier(() => true);

    const a = await verifyFindings(findings, { llm: anthropic.provider });
    const b = await verifyFindings(findings, { llm: openai.provider });

    expect(a[0]?.survives).toBe(true);
    expect(b[0]?.survives).toBe(false);
  });
});

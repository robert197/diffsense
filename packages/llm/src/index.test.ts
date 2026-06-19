import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_MODEL,
  DEFAULT_SYNTHESIS_MODEL,
  buildReviewPrompt,
  buildVerifyPrompt,
  createReviewProvider,
  resolveModelConfig,
} from "./index.js";

describe("resolveModelConfig", () => {
  it("defaults to Anthropic with the opus/fable models", () => {
    expect(resolveModelConfig({})).toEqual({
      provider: "anthropic",
      reviewModel: DEFAULT_REVIEW_MODEL,
      synthesisModel: DEFAULT_SYNTHESIS_MODEL,
    });
  });

  it("reads provider + model ids from env", () => {
    const config = resolveModelConfig({
      LLM_PROVIDER: "openai",
      REVIEW_MODEL: "gpt-5",
      SYNTHESIS_MODEL: "gpt-5-mini",
    });
    expect(config).toEqual({
      provider: "openai",
      reviewModel: "gpt-5",
      synthesisModel: "gpt-5-mini",
    });
  });

  it("accepts google and is case-insensitive on the provider", () => {
    expect(resolveModelConfig({ LLM_PROVIDER: "Google" }).provider).toBe("google");
  });

  it("throws on an unsupported provider", () => {
    expect(() => resolveModelConfig({ LLM_PROVIDER: "mistral" })).toThrow(
      /Unsupported LLM_PROVIDER/,
    );
  });
});

describe("createReviewProvider", () => {
  it("builds an LLMProvider for each supported vendor without a core change", () => {
    // Swapping LLM_PROVIDER only changes this adapter's construction — the
    // returned shape is the same `LLMProvider` port `core` depends on.
    for (const LLM_PROVIDER of ["anthropic", "openai", "google"]) {
      const provider = createReviewProvider({ LLM_PROVIDER });
      expect(typeof provider.reviewChunk).toBe("function");
      expect(typeof provider.verifyFinding).toBe("function");
    }
  });

  it("fails fast when the provider is unsupported", () => {
    expect(() => createReviewProvider({ LLM_PROVIDER: "llama" })).toThrow(
      /Unsupported LLM_PROVIDER/,
    );
  });
});

describe("buildReviewPrompt", () => {
  it("includes the file, tier, and diff hunk", () => {
    const prompt = buildReviewPrompt({ file: "src/auth.ts", tier: "High", patch: "+const t = 1;" });
    expect(prompt).toContain("File: src/auth.ts");
    expect(prompt).toContain("tier: High");
    expect(prompt).toContain("+const t = 1;");
  });
});

describe("buildVerifyPrompt", () => {
  it("includes the file, rating, a claim with its evidence, and the diff hunk", () => {
    const prompt = buildVerifyPrompt({
      review: {
        explanation: "may deref null",
        claims: [{ claim: "user.id read when null", evidence: "src/user.ts:3" }],
        rating: "high",
        reasons: ["no guard"],
      },
      chunk: { file: "src/user.ts", tier: "High", patch: "+return user.id;" },
    });
    expect(prompt).toContain("File: src/user.ts");
    expect(prompt).toContain("Finding rating: high");
    expect(prompt).toContain("Finding: may deref null");
    expect(prompt).toContain("user.id read when null");
    expect(prompt).toContain("evidence: src/user.ts:3");
    expect(prompt).toContain("- no guard");
    expect(prompt).toContain("+return user.id;");
  });

  it("renders '(none)' when the finding has no claims", () => {
    const prompt = buildVerifyPrompt({
      review: {
        explanation: "trivial rename",
        claims: [],
        rating: "medium",
        reasons: ["cosmetic"],
      },
      chunk: { file: "src/x.ts", tier: "Medium", patch: "+const y = 1;" },
    });
    expect(prompt).toContain("Claims to refute:");
    expect(prompt).toContain("(none)");
  });
});

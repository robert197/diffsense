import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_MODEL,
  DEFAULT_SYNTHESIS_MODEL,
  buildReviewPrompt,
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

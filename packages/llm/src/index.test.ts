import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_MODEL,
  DEFAULT_SYNTHESIS_MODEL,
  LOCALIZE_SYSTEM_PROMPT,
  buildLocalizePrompt,
  buildReviewPrompt,
  buildScopePrompt,
  buildStructuredReviewPrompt,
  buildSynthesisPrompt,
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
      expect(typeof provider.localizeCard).toBe("function");
      expect(typeof provider.verifyFinding).toBe("function");
      expect(typeof provider.detectScopeCreep).toBe("function");
      expect(typeof provider.synthesize).toBe("function");
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

describe("buildStructuredReviewPrompt", () => {
  const chunk = { file: "src/auth.ts", tier: "High" as const, patch: "+const t = 1;" };

  it("carries the diff and the tool-loop notes into the structuring call", () => {
    const prompt = buildStructuredReviewPrompt(chunk, "Looks risky: unbounded input.");
    expect(prompt).toContain("File: src/auth.ts");
    expect(prompt).toContain("+const t = 1;");
    expect(prompt).toContain("Looks risky: unbounded input.");
    expect(prompt).toContain("structured review");
  });

  it("degrades to a diff-only instruction when the notes are empty", () => {
    const prompt = buildStructuredReviewPrompt(chunk, "   ");
    expect(prompt).toContain("no additional notes");
    expect(prompt).toContain("+const t = 1;");
  });
});

describe("buildLocalizePrompt", () => {
  it("includes the target language name, the explanation, and every suggestion", () => {
    const prompt = buildLocalizePrompt({
      explanation: "Adds a null-unsafe read of user.id.",
      suggestions: ["Null is dereferenced when signed out.", "No test covers the guard."],
      language: "es",
    });
    expect(prompt).toContain("Target language: Spanish");
    expect(prompt).toContain("Adds a null-unsafe read of user.id.");
    expect(prompt).toContain("1. Null is dereferenced when signed out.");
    expect(prompt).toContain("2. No test covers the guard.");
  });

  it("marks an empty suggestions list rather than emitting a stray number", () => {
    const prompt = buildLocalizePrompt({ explanation: "x", suggestions: [], language: "de" });
    expect(prompt).toContain("Target language: German");
    expect(prompt).toContain("(none)");
  });
});

describe("LOCALIZE_SYSTEM_PROMPT", () => {
  it("instructs the model to preserve code and identifiers verbatim", () => {
    expect(LOCALIZE_SYSTEM_PROMPT).toMatch(/preserve verbatim/i);
    expect(LOCALIZE_SYSTEM_PROMPT).toMatch(/identifiers/i);
    expect(LOCALIZE_SYSTEM_PROMPT).toMatch(/same number of items|same order|order/i);
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

describe("buildScopePrompt", () => {
  it("includes the PR title, description, and the full diff", () => {
    const prompt = buildScopePrompt({
      diff: "diff --git a/src/auth.ts b/src/auth.ts\n+session.ttl = 0;",
      intent: { title: "add rate limiting", body: "Add a token-bucket rate limiter." },
    });
    expect(prompt).toContain("PR title:");
    expect(prompt).toContain("add rate limiting");
    expect(prompt).toContain("Add a token-bucket rate limiter.");
    expect(prompt).toContain("session.ttl = 0;");
  });

  it("renders '(none)' when the PR has an empty description", () => {
    const prompt = buildScopePrompt({
      diff: "+const x = 1;",
      intent: { title: "tidy up", body: "   " },
    });
    expect(prompt).toContain("PR description:");
    expect(prompt).toContain("(none)");
  });
});

describe("buildSynthesisPrompt", () => {
  const review = {
    explanation: "signature change with no call-site update",
    claims: [{ claim: "callers break", evidence: "src/api.ts:10" }],
    rating: "high" as const,
    reasons: ["API boundary"],
  };

  it("includes the intent, each finding with its chunk ref, and the scope assessment", () => {
    const prompt = buildSynthesisPrompt({
      findings: [{ chunkRef: "src/api.ts", file: "src/api.ts", rating: "high", review }],
      scope: {
        withinIntent: false,
        findings: [{ description: "adds a DB column", files: ["src/schema.ts"] }],
      },
      intent: { title: "Refactor auth", body: "rename only" },
    });
    expect(prompt).toContain("title: Refactor auth");
    expect(prompt).toContain("body: rename only");
    expect(prompt).toContain("chunk ref: src/api.ts");
    expect(prompt).toContain("signature change with no call-site update");
    expect(prompt).toContain("callers break (evidence: src/api.ts:10)");
    expect(prompt).toContain("adds a DB column — files: src/schema.ts");
  });

  it("notes when nothing survived and the diff stays on scope", () => {
    const prompt = buildSynthesisPrompt({
      findings: [],
      scope: { withinIntent: true, findings: [] },
      intent: { title: "Tidy up", body: "" },
    });
    expect(prompt).toContain("(none survived verification)");
    expect(prompt).toContain("the diff stays within its stated intent: true");
    expect(prompt).toContain("body: (empty)");
  });
});

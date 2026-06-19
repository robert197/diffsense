import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, SynthesisRequest } from "../ports/llmProvider.js";
import type { PrIntent } from "../ports/repoReader.js";
import type { RiskRating } from "../schemas/chunkReview.js";
import type { Portfolio } from "../schemas/portfolio.js";
import type { VerifiedFinding } from "../verify/verifyFinding.js";
import { type ScopeAssessment, synthesizePortfolio } from "./synthesizePortfolio.js";

const INTENT: PrIntent = {
  title: "Refactor the auth client",
  body: "Pure rename, no behaviour change.",
};
const ON_SCOPE: ScopeAssessment = { withinIntent: true, findings: [] };

function verified(file: string, rating: RiskRating, survives: boolean): VerifiedFinding {
  return {
    chunk: { file, tier: "High", patch: `+// change in ${file}` },
    review: {
      explanation: `finding in ${file}`,
      claims: [{ claim: `risk in ${file}`, evidence: `${file}:1` }],
      rating,
      reasons: [`rated ${rating}`],
    },
    verdict: { refuted: !survives, rationale: survives ? "risk holds" : "refuted" },
    survives,
  };
}

/** A fake synthesizer that records its request and returns a caller-supplied portfolio. */
function fakeSynthesizer(portfolio: Portfolio) {
  const requests: SynthesisRequest[] = [];
  const provider: LLMProvider = {
    reviewChunk: vi.fn(),
    verifyFinding: vi.fn(),
    detectScopeCreep: vi.fn(),
    synthesize: vi.fn(async (request: SynthesisRequest): Promise<Portfolio> => {
      requests.push(request);
      return portfolio;
    }),
  };
  return { provider, requests };
}

const PORTFOLIO = (positions: Portfolio["positions"]): Portfolio => ({
  positions,
  intentCoverage: "On scope.",
  overview: "Overview.",
});

describe("synthesizePortfolio", () => {
  it("returns named, chunk-linked positions plus intent coverage and overview", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([
        {
          title: "1 unverified API change",
          detail: "Signature change with no call-site update.",
          severity: "high",
          chunks: ["src/api.ts"],
        },
      ]),
    );

    const portfolio = await synthesizePortfolio(
      [verified("src/api.ts", "high", true)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );

    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]?.title).toBe("1 unverified API change");
    expect(portfolio.positions[0]?.chunks).toEqual(["src/api.ts"]);
    expect(portfolio.intentCoverage).toBe("On scope.");
    expect(portfolio.overview).toBe("Overview.");
  });

  it("produces no single opaque numeric score", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([{ title: "p", detail: "d", severity: "medium", chunks: ["src/api.ts"] }]),
    );
    const portfolio = await synthesizePortfolio(
      [verified("src/api.ts", "medium", true)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );
    expect(portfolio).not.toHaveProperty("score");
    expect(Object.values(portfolio).some((v) => typeof v === "number")).toBe(false);
  });

  it("consumes only verified survivors — refuted findings never reach the model", async () => {
    const { provider, requests } = fakeSynthesizer(
      PORTFOLIO([{ title: "p", detail: "d", severity: "high", chunks: ["src/keep.ts"] }]),
    );

    await synthesizePortfolio(
      [verified("src/keep.ts", "high", true), verified("src/drop.ts", "high", false)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );

    const refs = requests[0]?.findings.map((f) => f.chunkRef);
    expect(refs).toEqual(["src/keep.ts"]);
  });

  it("threads scope and intent through to the model untouched", async () => {
    const { provider, requests } = fakeSynthesizer(
      PORTFOLIO([{ title: "p", detail: "d", severity: "low", chunks: ["src/a.ts"] }]),
    );
    const scope: ScopeAssessment = {
      withinIntent: false,
      findings: [{ description: "adds a DB column", files: ["src/schema.ts"] }],
    };

    await synthesizePortfolio([verified("src/a.ts", "low", true)], scope, INTENT, {
      llm: provider,
    });

    expect(requests[0]?.scope).toEqual(scope);
    expect(requests[0]?.intent).toEqual(INTENT);
  });

  it("links a scope-only position back to the file the undeclared change touched", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([
        {
          title: "1 undeclared data-model edit",
          detail: "Adds a column not mentioned in the PR.",
          severity: "medium",
          chunks: ["src/schema.ts"],
        },
      ]),
    );
    const scope: ScopeAssessment = {
      withinIntent: false,
      findings: [{ description: "adds a DB column", files: ["src/schema.ts"] }],
    };

    const portfolio = await synthesizePortfolio([], scope, INTENT, { llm: provider });
    expect(portfolio.positions[0]?.chunks).toEqual(["src/schema.ts"]);
  });

  it("drops chunk references the model invented, keeping only real ones", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([
        {
          title: "mixed",
          detail: "d",
          severity: "high",
          chunks: ["src/api.ts", "src/hallucinated.ts"],
        },
      ]),
    );

    const portfolio = await synthesizePortfolio(
      [verified("src/api.ts", "high", true)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );

    expect(portfolio.positions[0]?.chunks).toEqual(["src/api.ts"]);
  });

  it("removes a position left with no real chunk link", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([
        { title: "ghost", detail: "d", severity: "high", chunks: ["src/nope.ts"] },
        { title: "real", detail: "d", severity: "high", chunks: ["src/api.ts"] },
      ]),
    );

    const portfolio = await synthesizePortfolio(
      [verified("src/api.ts", "high", true)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );

    expect(portfolio.positions.map((p) => p.title)).toEqual(["real"]);
  });

  it("short-circuits to an empty portfolio with no LLM call when nothing survived and on scope", async () => {
    const { provider } = fakeSynthesizer(PORTFOLIO([]));

    const portfolio = await synthesizePortfolio(
      [verified("src/drop.ts", "high", false)],
      ON_SCOPE,
      INTENT,
      { llm: provider },
    );

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.intentCoverage).toMatch(/within its stated intent/);
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it("still synthesizes when no finding survived but the diff drifted off scope", async () => {
    const { provider } = fakeSynthesizer(
      PORTFOLIO([{ title: "scope creep", detail: "d", severity: "medium", chunks: ["src/x.ts"] }]),
    );
    const scope: ScopeAssessment = {
      withinIntent: false,
      findings: [{ description: "unrelated feature", files: ["src/x.ts"] }],
    };

    const portfolio = await synthesizePortfolio([], scope, INTENT, { llm: provider });

    expect(provider.synthesize).toHaveBeenCalledOnce();
    expect(portfolio.positions).toHaveLength(1);
  });

  it("is provider-agnostic: swapping the adapter needs no change in core", async () => {
    const findings = [verified("src/a.ts", "high", true)];
    const anthropic = fakeSynthesizer(
      PORTFOLIO([{ title: "A", detail: "d", severity: "high", chunks: ["src/a.ts"] }]),
    );
    const openai = fakeSynthesizer(
      PORTFOLIO([{ title: "B", detail: "d", severity: "low", chunks: ["src/a.ts"] }]),
    );

    const a = await synthesizePortfolio(findings, ON_SCOPE, INTENT, { llm: anthropic.provider });
    const b = await synthesizePortfolio(findings, ON_SCOPE, INTENT, { llm: openai.provider });

    expect(a.positions[0]?.title).toBe("A");
    expect(b.positions[0]?.title).toBe("B");
  });
});

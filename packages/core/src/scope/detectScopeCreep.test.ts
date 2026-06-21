import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, ScopeRequest } from "../ports/llmProvider.js";
import type { PrIntent } from "../ports/repoReader.js";
import type { ScopeCreepReport } from "../schemas/scopeCreep.js";
import { detectScopeCreep } from "./detectScopeCreep.js";

/**
 * A PR that declares "add rate limiting" but also edits auth: the rate-limit file
 * is in scope, the auth edit is the undeclared drive-by.
 */
const INTENT: PrIntent = {
  title: "add rate limiting",
  body: "Add a token-bucket rate limiter to the API.",
};

const DIFF = [
  "diff --git a/src/rateLimit.ts b/src/rateLimit.ts",
  "index 1111111..2222222 100644",
  "--- a/src/rateLimit.ts",
  "+++ b/src/rateLimit.ts",
  "@@ -1,2 +1,4 @@",
  " export function limit() {",
  "+  // token bucket",
  "+  return true;",
  " }",
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 3333333..4444444 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,2 +10,3 @@ export function authenticate() {",
  "   const ok = check();",
  "+  session.ttl = 0;",
  "   return ok;",
].join("\n");

/** A fake scope pass that records requests and returns a caller-supplied report. */
function fakeScoper(report: (req: ScopeRequest) => ScopeCreepReport) {
  const requests: ScopeRequest[] = [];
  const provider: LLMProvider = {
    reviewChunk: vi.fn(),
    localizeCard: vi.fn(),
    verifyFinding: vi.fn(),
    detectScopeCreep: vi.fn(async (request: ScopeRequest): Promise<ScopeCreepReport> => {
      requests.push(request);
      return report(request);
    }),
    synthesize: vi.fn(),
  };
  return { provider, requests };
}

const authFinding = {
  file: "src/auth.ts",
  summary: "sets session.ttl = 0",
  rationale: "an auth-session change; the PR only declares rate limiting",
};

describe("detectScopeCreep", () => {
  it("surfaces the auth edit as scope creep when the PR only declares rate limiting", async () => {
    const { provider } = fakeScoper(() => ({
      declaredIntents: ["add rate limiting"],
      findings: [authFinding],
    }));

    const findings = await detectScopeCreep(DIFF, INTENT, { llm: provider });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("src/auth.ts");
    expect(findings[0]?.summary).toContain("session.ttl");
  });

  it("does not mis-flag legitimate in-intent changes (precision)", async () => {
    // Every region maps to the declared intent — the pass returns no findings.
    const { provider } = fakeScoper(() => ({
      declaredIntents: ["add rate limiting"],
      findings: [],
    }));

    const findings = await detectScopeCreep(DIFF, INTENT, { llm: provider });

    expect(findings).toEqual([]);
  });

  it("passes the full diff and the declared intent through to the LLM", async () => {
    const { provider, requests } = fakeScoper(() => ({ declaredIntents: [], findings: [] }));

    await detectScopeCreep(DIFF, INTENT, { llm: provider });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.diff).toBe(DIFF);
    expect(requests[0]?.intent).toEqual(INTENT);
  });

  it("returns an empty array and never calls the LLM for an empty diff", async () => {
    const { provider } = fakeScoper(() => ({ declaredIntents: [], findings: [] }));

    const findings = await detectScopeCreep("", INTENT, { llm: provider });

    expect(findings).toEqual([]);
    expect(provider.detectScopeCreep).not.toHaveBeenCalled();
  });

  it("drops a finding whose file the diff does not touch (no invented regions)", async () => {
    const { provider } = fakeScoper(() => ({
      declaredIntents: ["add rate limiting"],
      findings: [
        authFinding,
        { file: "src/ghost.ts", summary: "invented edit", rationale: "not in the diff" },
      ],
    }));

    const findings = await detectScopeCreep(DIFF, INTENT, { llm: provider });

    expect(findings.map((f) => f.file)).toEqual(["src/auth.ts"]);
  });

  it("matches a finding whose path still carries the a/ or b/ diff prefix", async () => {
    // parse-diff strips a/ and b/; the model reads the raw diff and may echo the
    // prefixed form. The shell must normalize it, not drop the finding.
    const { provider } = fakeScoper(() => ({
      declaredIntents: ["add rate limiting"],
      findings: [{ ...authFinding, file: "b/src/auth.ts" }],
    }));

    const findings = await detectScopeCreep(DIFF, INTENT, { llm: provider });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("src/auth.ts");
  });

  it("propagates an LLM rejection to the caller", async () => {
    const provider: LLMProvider = {
      reviewChunk: vi.fn(),
      localizeCard: vi.fn(),
      verifyFinding: vi.fn(),
      detectScopeCreep: vi.fn().mockRejectedValue(new Error("provider down")),
      synthesize: vi.fn(),
    };

    await expect(detectScopeCreep(DIFF, INTENT, { llm: provider })).rejects.toThrow(
      "provider down",
    );
  });

  it("is provider-agnostic: swapping the adapter needs no change in core", async () => {
    const flags = fakeScoper(() => ({
      declaredIntents: ["add rate limiting"],
      findings: [authFinding],
    }));
    const clean = fakeScoper(() => ({ declaredIntents: ["add rate limiting"], findings: [] }));

    const a = await detectScopeCreep(DIFF, INTENT, { llm: flags.provider });
    const b = await detectScopeCreep(DIFF, INTENT, { llm: clean.provider });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

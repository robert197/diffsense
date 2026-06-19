import { describe, expect, it } from "vitest";
import type { Portfolio } from "../schemas/portfolio.js";
import type { ReactionOptions } from "./reactionLink.js";
import { type CommentFinding, renderComment } from "./renderComment.js";

const REACTIONS: ReactionOptions = {
  reactionBaseUrl: "https://diffsense.example",
  pr: { owner: "octo-org", repo: "demo", prNumber: 42 },
};

const REVIEW_URL = "https://diffsense.example/r/octo-org/demo/42";

const NO_MERGE_WORDS = /\b(block|approve|approved|lgtm|request changes|merge)\b/i;

const PORTFOLIO: Portfolio = {
  positions: [
    {
      title: "1 unverified auth-boundary change",
      detail: "Session lookup no longer guards a null user.",
      severity: "high",
      chunks: ["src/auth/session.ts"],
    },
    {
      title: "1 undeclared data-model edit",
      detail: "Adds a nullable column not mentioned in the PR description.",
      severity: "medium",
      chunks: ["src/db/schema.ts"],
    },
  ],
  intentCoverage: "Over scope: the diff adds a DB column the description does not mention.",
  overview: "Two risk positions to look at: an auth-boundary change and an undeclared schema edit.",
};

function finding(over: Partial<CommentFinding> = {}): CommentFinding {
  return {
    file: "src/auth/session.ts",
    line: 21,
    deepLink: "https://github.com/octo-org/demo/pull/42/files#diff-abcR21",
    rating: "high",
    explanation: "The session lookup dereferences the user without a null guard.",
    verdict: {
      refuted: false,
      rationale: "The upstream caller can pass an unauthenticated request.",
    },
    fingerprint: "fp-session",
    ...over,
  };
}

describe("renderComment (issue #12)", () => {
  it("leads with the portfolio overview, intent coverage, and named risk positions", () => {
    const out = renderComment(PORTFOLIO, [finding()]);
    const overviewIdx = out.indexOf("Two risk positions to look at");
    const positionsIdx = out.indexOf("**Risk positions**");
    const findingsIdx = out.indexOf("**Review these first**");

    expect(overviewIdx).toBeGreaterThanOrEqual(0);
    expect(out).toContain("**Intent coverage:** Over scope");
    expect(out).toContain("1 unverified auth-boundary change");
    expect(out).toContain("Session lookup no longer guards a null user.");
    // Portfolio leads; the ranked findings follow it.
    expect(overviewIdx).toBeLessThan(positionsIdx);
    expect(positionsIdx).toBeLessThan(findingsIdx);
  });

  it("renders each finding with a deep link, explanation excerpt, and its verdict", () => {
    const out = renderComment(PORTFOLIO, [finding()]);
    expect(out).toContain(
      "[src/auth/session.ts:21](https://github.com/octo-org/demo/pull/42/files#diff-abcR21)",
    );
    expect(out).toContain("dereferences the user without a null guard");
    expect(out).toContain("held up under an independent verification challenge");
    expect(out).toContain("The upstream caller can pass an unauthenticated request.");
  });

  it("shows a refuted verdict distinctly", () => {
    const out = renderComment(PORTFOLIO, [
      finding({
        verdict: { refuted: true, rationale: "The value is guarded two frames up." },
      }),
    ]);
    expect(out).toContain("refuted in the verification pass");
    expect(out).toContain("The value is guarded two frames up.");
  });

  it("links to the hosted review view when a URL is given", () => {
    const out = renderComment(PORTFOLIO, [finding()], { reviewUrl: REVIEW_URL });
    expect(out).toContain(`[Open the full review in diffsense →](${REVIEW_URL})`);
  });

  it("omits the review-view link when no URL is given", () => {
    const out = renderComment(PORTFOLIO, [finding()]);
    expect(out).not.toContain("Open the full review");
  });

  it("exposes a 👍/👎 per finding pointing at the reaction endpoint", () => {
    const out = renderComment(PORTFOLIO, [finding()], { reactions: REACTIONS });
    expect(out).toContain("👍");
    expect(out).toContain("👎");
    expect(out).toContain("https://diffsense.example/reactions?");
    expect(out).toContain("fp=fp-session");
    // Lowercase rating is recorded with the capitalized tier the schema expects.
    expect(out).toContain("tier=High");
    expect(out).toContain("s=up");
    expect(out).toContain("s=down");
  });

  it("renders no affordance when reactions are not configured", () => {
    const out = renderComment(PORTFOLIO, [finding()]);
    expect(out).not.toContain("👍");
    expect(out).not.toContain("/reactions?");
  });

  it("orders findings highest-risk first regardless of input order", () => {
    const out = renderComment(PORTFOLIO, [
      finding({ file: "low.ts", rating: "low", fingerprint: "fp-low" }),
      finding({ file: "high.ts", rating: "high", fingerprint: "fp-high" }),
      finding({ file: "med.ts", rating: "medium", fingerprint: "fp-med" }),
    ]);
    expect(out.indexOf("high.ts")).toBeLessThan(out.indexOf("med.ts"));
    expect(out.indexOf("med.ts")).toBeLessThan(out.indexOf("low.ts"));
  });

  it("truncates a long explanation to a word-boundary excerpt with an ellipsis", () => {
    const long = `${"word ".repeat(80)}END`.trim();
    const out = renderComment(PORTFOLIO, [finding({ explanation: long })]);
    expect(out).toContain("…");
    expect(out).not.toContain("END");
  });

  it("handles an empty portfolio with no findings without throwing", () => {
    const empty: Portfolio = {
      positions: [],
      intentCoverage: "The change stays within its stated intent.",
      overview: "No risks survived verification. Nothing flagged for review.",
    };
    const out = renderComment(empty, []);
    expect(out).toContain("No risks survived verification");
    expect(out).toContain("Nothing survived verification. No findings to review first.");
    expect(out).not.toContain("**Risk positions**");
  });

  it("caps the listed findings and names the remainder", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      finding({ file: `f${i}.ts`, fingerprint: `fp-${i}` }),
    );
    const out = renderComment(PORTFOLIO, many);
    const listed = out.split("\n").filter((l) => /^\d+\. \*\*\[/.test(l)).length;
    expect(listed).toBe(10);
    expect(out).toContain("Plus 4 more findings, not listed.");
  });

  it("never uses merge-gating language (advisory only)", () => {
    const out = renderComment(PORTFOLIO, [finding()], {
      reactions: REACTIONS,
      reviewUrl: REVIEW_URL,
    });
    expect(out).not.toMatch(NO_MERGE_WORDS);
    expect(out).toContain("Advisory only");
  });
});

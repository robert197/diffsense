import type { Deck, ReviewFinding } from "@diffsense/core";
import { describe, expect, it } from "vitest";
import type { UpsertResult } from "../adapters/github.js";
import { CliConfigError, UsageError } from "./errors.js";
import { buildReviewOutput, exitCodeForError } from "./output.js";

const pr = { owner: "octo-org", repo: "demo", prNumber: 42 };
const upsert: UpsertResult = { action: "created", commentId: 999 };

function makeDeck(): Deck {
  return {
    owner: "octo-org",
    repo: "demo",
    prNumber: 42,
    headSha: "abc123",
    cards: [
      {
        fingerprint: "fp-0",
        file: "src/auth.ts",
        tier: "High",
        rank: 0,
        riskScore: 9.5,
        highlights: [{ side: "R", start: 2, end: 2 }],
        suggestions: ["check token expiry"],
        explanation: "Adds a token check.",
      },
      {
        fingerprint: "fp-1",
        file: "src/util.ts",
        tier: "Low",
        rank: 1,
        riskScore: 1.0,
        highlights: [{ side: "R", start: 11, end: 11 }],
        suggestions: [],
        explanation: "Adds a log line.",
      },
    ],
  };
}

const finding: ReviewFinding = {
  owner: "octo-org",
  repo: "demo",
  prNumber: 42,
  fingerprint: "fp-0",
  file: "src/auth.ts",
  tier: "High",
  rank: 0,
  explanation: "Adds a token check.",
  claims: [{ claim: "token may be null", evidence: "src/auth.ts:2" }],
  reasons: ["auth-sensitive"],
  blastRadius: [],
};

describe("buildReviewOutput (#32 U4)", () => {
  it("embeds the deck + findings and exposes llm:true, preserving card order", () => {
    const deck = makeDeck();
    const out = buildReviewOutput({
      pr,
      headSha: "abc123",
      upsert,
      deck,
      findings: [finding],
      llm: true,
    });
    expect(out).toEqual({
      pr,
      headSha: "abc123",
      comment: { action: "created", commentId: 999 },
      deck,
      findings: [finding],
      llm: true,
    });
    expect(out.deck?.cards.map((c) => c.rank)).toEqual([0, 1]);
  });

  it("normalizes an unresolved head + no LLM to headSha:null, deck:null, llm:false", () => {
    const out = buildReviewOutput({
      pr,
      headSha: undefined,
      upsert: { action: "updated", commentId: 7 },
      deck: null,
      findings: [],
      llm: false,
    });
    expect(out.headSha).toBeNull();
    expect(out.deck).toBeNull();
    expect(out.findings).toEqual([]);
    expect(out.llm).toBe(false);
    expect(out.comment).toEqual({ action: "updated", commentId: 7 });
  });

  it("produces output that round-trips through JSON unchanged", () => {
    const out = buildReviewOutput({
      pr,
      headSha: "abc123",
      upsert,
      deck: makeDeck(),
      findings: [finding],
      llm: true,
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("exitCodeForError (#32 U4)", () => {
  it("maps UsageError to 2", () => {
    expect(exitCodeForError(new UsageError("bad ref"))).toBe(2);
  });
  it("maps CliConfigError to 3", () => {
    expect(exitCodeForError(new CliConfigError("missing creds"))).toBe(3);
  });
  it("maps a GitHub 404 to 4", () => {
    expect(exitCodeForError({ status: 404 })).toBe(4);
  });
  it("maps a GitHub 403 to 4", () => {
    expect(exitCodeForError({ status: 403 })).toBe(4);
  });
  it("maps a nested response.status 404 to 4", () => {
    expect(exitCodeForError({ response: { status: 404 } })).toBe(4);
  });
  it("maps a generic error to 1", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(1);
  });
  it("maps a non-404/403 status (500) to 1", () => {
    expect(exitCodeForError({ status: 500 })).toBe(1);
  });
});

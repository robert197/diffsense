import { describe, expect, it } from "vitest";
import type { Card } from "../schemas/card.js";
import { CardDecisionSchema, resumeState } from "./reviewProgress.js";

/**
 * Unit coverage for the pure resume kernel (issue #29). The deck page derives its
 * resume index from `resumeState`; the dashboard derives `n / total` from it. Both
 * acceptance criteria — "resuming returns the user to the next unreviewed card" and
 * "progress (n/total)" — are exercised here without any DB or DOM.
 */

function card(fingerprint: string): Card {
  return {
    fingerprint,
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 1,
    highlights: [],
    suggestions: [],
    explanation: "does a thing",
  };
}

const deck = [card("a"), card("b"), card("c")];

describe("resumeState", () => {
  it("starts at card 0 with nothing decided", () => {
    expect(resumeState(deck, [])).toEqual({
      total: 3,
      reviewed: 0,
      nextIndex: 0,
      complete: false,
    });
  });

  it("resumes at the first undecided card, not after the last decided one", () => {
    // Cards a and c decided, b not — the next card to review is b (index 1).
    expect(resumeState(deck, ["a", "c"])).toMatchObject({ reviewed: 2, nextIndex: 1 });
  });

  it("advances past a decided leading card", () => {
    expect(resumeState(deck, ["a"])).toMatchObject({ reviewed: 1, nextIndex: 1 });
  });

  it("reports complete when every card is decided", () => {
    expect(resumeState(deck, ["a", "b", "c"])).toEqual({
      total: 3,
      reviewed: 3,
      nextIndex: 3,
      complete: true,
    });
  });

  it("ignores a decided fingerprint that is not in the deck", () => {
    // "z" was decided on a different head SHA's deck — it must not raise `reviewed`.
    expect(resumeState(deck, ["a", "z"])).toMatchObject({ reviewed: 1, nextIndex: 1 });
  });

  it("never reports an empty deck as complete", () => {
    expect(resumeState([], ["a"])).toEqual({
      total: 0,
      reviewed: 0,
      nextIndex: 0,
      complete: false,
    });
  });

  it("marks both cards reviewed when they share a fingerprint", () => {
    const dupes = [card("x"), card("x")];
    expect(resumeState(dupes, ["x"])).toEqual({
      total: 2,
      reviewed: 2,
      nextIndex: 2,
      complete: true,
    });
  });

  it("accepts a Set as well as an array", () => {
    expect(resumeState(deck, new Set(["b"]))).toMatchObject({ reviewed: 1, nextIndex: 0 });
  });
});

describe("CardDecisionSchema", () => {
  it("accepts up and down decisions", () => {
    expect(CardDecisionSchema.parse({ fingerprint: "fp", decision: "up" })).toEqual({
      fingerprint: "fp",
      decision: "up",
    });
    expect(CardDecisionSchema.safeParse({ fingerprint: "fp", decision: "down" }).success).toBe(
      true,
    );
  });

  it("rejects an empty fingerprint", () => {
    expect(CardDecisionSchema.safeParse({ fingerprint: "", decision: "up" }).success).toBe(false);
  });

  it("rejects a decision outside the set", () => {
    expect(CardDecisionSchema.safeParse({ fingerprint: "fp", decision: "maybe" }).success).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import { CardSchema, DeckSchema, HighlightRangeSchema } from "./card.js";

const card = {
  fingerprint: "fp-1",
  file: "src/auth.ts",
  tier: "High" as const,
  rank: 0,
  riskScore: 4.2,
  highlights: [{ side: "R" as const, start: 10, end: 14 }],
  suggestions: ["Token expiry uses < not <="],
  explanation: "Adds a session expiry check.",
};

describe("CardSchema (#26)", () => {
  it("accepts a well-formed card", () => {
    expect(CardSchema.parse(card)).toEqual(card);
  });

  it("rejects an empty explanation", () => {
    expect(() => CardSchema.parse({ ...card, explanation: "" })).toThrow();
  });

  it("rejects an empty suggestion string", () => {
    expect(() => CardSchema.parse({ ...card, suggestions: [""] })).toThrow();
  });

  it("rejects a negative rank", () => {
    expect(() => CardSchema.parse({ ...card, rank: -1 })).toThrow();
  });
});

describe("HighlightRangeSchema (#26)", () => {
  it("accepts a single-line range", () => {
    expect(HighlightRangeSchema.parse({ side: "L", start: 5, end: 5 })).toBeTruthy();
  });

  it("rejects end before start", () => {
    expect(() => HighlightRangeSchema.parse({ side: "R", start: 5, end: 4 })).toThrow();
  });

  it("rejects a non-positive line number", () => {
    expect(() => HighlightRangeSchema.parse({ side: "R", start: 0, end: 1 })).toThrow();
  });
});

describe("DeckSchema (#26)", () => {
  it("accepts a deck with cards", () => {
    const deck = {
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      headSha: "abc123",
      cards: [card],
    };
    expect(DeckSchema.parse(deck).cards).toHaveLength(1);
  });

  it("accepts an empty deck", () => {
    const deck = { owner: "octo", repo: "demo", prNumber: 7, headSha: "abc123", cards: [] };
    expect(DeckSchema.parse(deck).cards).toEqual([]);
  });

  it("rejects a missing head SHA", () => {
    expect(() =>
      DeckSchema.parse({ owner: "octo", repo: "demo", prNumber: 7, headSha: "", cards: [] }),
    ).toThrow();
  });
});

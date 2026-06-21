import { describe, expect, it } from "vitest";
import type { Card } from "../schemas/card.js";
import type { HighlightRange } from "../schemas/card.js";
import { cardCommentAnchor } from "./commentAnchor.js";

function card(highlights: HighlightRange[], over: Partial<Card> = {}): Card {
  return {
    fingerprint: "fp",
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 1,
    highlights,
    suggestions: [],
    explanation: "does a thing",
    ...over,
  };
}

describe("cardCommentAnchor", () => {
  it("anchors a single added line with no startLine", () => {
    const anchor = cardCommentAnchor(card([{ side: "R", start: 12, end: 12 }]), "sha1");
    expect(anchor).toEqual({ file: "src/a.ts", line: 12, side: "RIGHT", commitId: "sha1" });
  });

  it("spans startLine..line for a multi-line added range", () => {
    const anchor = cardCommentAnchor(card([{ side: "R", start: 12, end: 18 }]), "sha1");
    expect(anchor).toEqual({
      file: "src/a.ts",
      line: 18,
      startLine: 12,
      side: "RIGHT",
      commitId: "sha1",
    });
  });

  it("uses the first right-side range deterministically", () => {
    const anchor = cardCommentAnchor(
      card([
        { side: "R", start: 5, end: 6 },
        { side: "R", start: 30, end: 31 },
      ]),
      "sha1",
    );
    expect(anchor?.line).toBe(6);
    expect(anchor?.startLine).toBe(5);
  });

  it("returns null for a deletion-only card (only left-side highlights)", () => {
    expect(cardCommentAnchor(card([{ side: "L", start: 4, end: 6 }]), "sha1")).toBeNull();
  });

  it("returns null when there are no highlights", () => {
    expect(cardCommentAnchor(card([]), "sha1")).toBeNull();
  });

  it("returns null when the head SHA is empty", () => {
    expect(cardCommentAnchor(card([{ side: "R", start: 1, end: 1 }]), "")).toBeNull();
  });
});

import type { Card, HighlightRange } from "@diffsense/core";
import { describe, expect, it } from "vitest";
import {
  buildCodeWindow,
  deckProgress,
  deletionSummary,
  highlightLabel,
  resolveSwipe,
  swipeSentiment,
  swipeThresholdPx,
  toCardView,
} from "./codeWindow";

const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const R = (start: number, end: number): HighlightRange => ({ side: "R", start, end });
const L = (start: number, end: number): HighlightRange => ({ side: "L", start, end });

describe("buildCodeWindow", () => {
  it("includes context lines and marks only in-range lines highlighted", () => {
    const window = buildCodeWindow(lines, [R(10, 12)], 2);
    expect(window).not.toBeNull();
    const nums = window?.map((l) => l.number);
    expect(nums).toEqual([8, 9, 10, 11, 12, 13, 14]);
    const highlighted = window?.filter((l) => l.highlighted).map((l) => l.number);
    expect(highlighted).toEqual([10, 11, 12]);
    expect(window?.[2]?.text).toBe("line 10");
  });

  it("merges overlapping/adjacent ranges into one window with no duplicate lines", () => {
    const window = buildCodeWindow(lines, [R(5, 6), R(8, 9)], 2);
    const nums = window?.map((l) => l.number);
    // 5±2 = [3..8], 8±2 = [6..11] → merged [3..11], each line once.
    expect(nums).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(nums).size).toBe(nums?.length);
  });

  it("clamps to file bounds at the first and last line", () => {
    const window = buildCodeWindow(lines, [R(1, 1), R(20, 20)], 3);
    const nums = window?.map((l) => l.number) ?? [];
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(20);
    expect(nums.every((n) => n >= 1 && n <= 20)).toBe(true);
  });

  it("returns null for a deletion-only card (only L-side ranges)", () => {
    expect(buildCodeWindow(lines, [L(4, 5)])).toBeNull();
  });

  it("returns null when there are no highlights or no file lines", () => {
    expect(buildCodeWindow(lines, [])).toBeNull();
    expect(buildCodeWindow([], [R(1, 2)])).toBeNull();
  });

  it("strips a trailing carriage return from CRLF files", () => {
    const window = buildCodeWindow("a\r\nb\r\nc".split("\n"), [R(2, 2)], 0);
    expect(window).toEqual([{ number: 2, text: "b", highlighted: true }]);
  });
});

describe("deletionSummary", () => {
  it("counts removed lines across L-side ranges only", () => {
    expect(deletionSummary([L(4, 5), R(10, 12), L(20, 20)])).toBe(3);
    expect(deletionSummary([R(1, 4)])).toBe(0);
  });
});

describe("swipeSentiment", () => {
  it("maps right to up and left to down", () => {
    expect(swipeSentiment("right")).toBe("up");
    expect(swipeSentiment("left")).toBe("down");
  });
});

describe("resolveSwipe / swipeThresholdPx", () => {
  it("commits past the threshold with the correct direction", () => {
    expect(swipeThresholdPx(400, 0.25)).toBe(100);
    expect(resolveSwipe(120, 400)).toEqual({ committed: true, direction: "right" });
    expect(resolveSwipe(-120, 400)).toEqual({ committed: true, direction: "left" });
  });

  it("snaps back below the threshold", () => {
    expect(resolveSwipe(40, 400).committed).toBe(false);
    expect(resolveSwipe(-40, 400).committed).toBe(false);
  });

  it("uses the floor for very narrow cards", () => {
    expect(swipeThresholdPx(100, 0.25)).toBe(48);
  });
});

describe("deckProgress", () => {
  it("is 0% at the start and 100% when complete", () => {
    expect(deckProgress(0, 4)).toEqual({ done: 0, total: 4, percent: 0 });
    expect(deckProgress(4, 4)).toEqual({ done: 4, total: 4, percent: 100 });
  });

  it("clamps overshoot and guards an empty deck", () => {
    expect(deckProgress(9, 4)).toEqual({ done: 4, total: 4, percent: 100 });
    expect(deckProgress(0, 0)).toEqual({ done: 0, total: 0, percent: 0 });
  });
});

describe("highlightLabel", () => {
  it("labels added and removed ranges", () => {
    expect(highlightLabel([R(12, 18)])).toBe("Added lines 12–18");
    expect(highlightLabel([R(7, 7)])).toBe("Added line 7");
    expect(highlightLabel([R(3, 4), L(9, 9)])).toBe("Added lines 3–4 · Removed line 9");
    expect(highlightLabel([])).toBe("No changed lines");
  });
});

describe("toCardView", () => {
  const card: Card = {
    fingerprint: "fp1",
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 2.5,
    highlights: [R(2, 3)],
    suggestions: ["off-by-one?"],
    explanation: "adds a guard",
  };

  it("resolves a code window from file text", () => {
    const view = toCardView(card, "a\nb\nc\nd\ne");
    expect(view.fingerprint).toBe("fp1");
    expect(view.code?.map((l) => l.number)).toContain(2);
    expect(view.highlightLabel).toBe("Added lines 2–3");
    expect(view.removedLines).toBe(0);
  });

  it("degrades to a null code window when file text is unavailable", () => {
    const view = toCardView(card, null);
    expect(view.code).toBeNull();
    expect(view.highlightLabel).toBe("Added lines 2–3");
  });

  it("reports removed lines for a deletion-only card", () => {
    const delCard: Card = { ...card, highlights: [L(4, 6)] };
    const view = toCardView(delCard, "a\nb\nc");
    expect(view.code).toBeNull();
    expect(view.removedLines).toBe(3);
    expect(view.highlightLabel).toBe("Removed lines 4–6");
  });
});

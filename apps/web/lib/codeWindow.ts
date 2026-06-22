import type { Card, HighlightRange } from "@diffsense/core";
import type { PostedCardComment } from "./prComments";

/**
 * Pure render helpers for the swipe deck (issue #27). All branching logic the
 * `SwipeDeck` client component needs lives here so it can be unit-tested without a
 * DOM: building the highlighted code window from a file's lines + the card's
 * highlight ranges, mapping a swipe direction to an advisory sentiment, deciding
 * whether a drag commits, and computing deck progress. No React/DOM imports —
 * keeps the module trivially testable and out of the client gesture path's way.
 */

/** One rendered source line in a card's code window. */
export interface CodeLine {
  /** 1-based line number on the new (head) side of the file. */
  number: number;
  text: string;
  /** True when this line falls inside one of the card's highlight ranges. */
  highlighted: boolean;
}

/**
 * The plain, serializable card the server hands the `SwipeDeck` client component —
 * the persisted card plus its resolved code window (or a deletion note). No Zod /
 * Drizzle types cross into the client bundle; this is the whole contract.
 */
export interface CardView {
  fingerprint: string;
  file: string;
  tier: "High" | "Medium" | "Low";
  riskScore: number;
  suggestions: string[];
  explanation: string;
  /** Resolved highlighted source lines, or `null` when none could be shown. */
  code: CodeLine[] | null;
  /** Removed-line count for a deletion-only card's fallback note. */
  removedLines: number;
  /** Human label of the lines to scrutinize, e.g. "Added lines 12–18". */
  highlightLabel: string;
  /**
   * Whether a comment left from this card anchors to the diff (issue #30). True when
   * the card points at added (right-side) lines — the comment lands as a diff-anchored
   * review comment; false (deletion-only / no-op) → a general PR-conversation comment.
   * Mirrors `cardCommentAnchor`'s rule so the composer can show the right target.
   */
  commentAnchored: boolean;
  /** Comments the reviewer already posted from this card, reflected back (issue #30). */
  postedComments: PostedCardComment[];
}

const DEFAULT_CONTEXT = 3;

/**
 * Build the code window a card renders: the union of its right-side (new) highlight
 * ranges, each expanded by `context` lines and clamped to the file, with overlapping
 * or adjacent ranges merged so no line repeats. Lines inside an original (un-expanded)
 * highlight range are marked `highlighted`. Returns `null` when there is nothing to
 * render from the head file — a deletion-only card (only `L`-side ranges) or a no-op
 * hunk (no ranges) — so the caller falls back to a descriptive note.
 */
export function buildCodeWindow(
  fileLines: string[],
  highlights: HighlightRange[],
  context: number = DEFAULT_CONTEXT,
): CodeLine[] | null {
  const right = highlights.filter((h) => h.side === "R");
  if (right.length === 0 || fileLines.length === 0) {
    return null;
  }

  const maxLine = fileLines.length;
  // Expanded, clamped windows to render; original ranges to mark as highlighted.
  const windows = right
    .map((h) => ({
      start: Math.max(1, h.start - context),
      end: Math.min(maxLine, h.end + context),
    }))
    .filter((w) => w.start <= w.end)
    .sort((a, b) => a.start - b.start);

  if (windows.length === 0) {
    return null;
  }

  // Merge overlapping/adjacent windows so a line is emitted at most once.
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 1) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  // Pre-compute the highlighted line numbers once (O(total highlighted lines))
  // so the per-rendered-line check below is O(1) instead of scanning every range.
  const highlightedLines = new Set<number>();
  for (const h of right) {
    for (let n = h.start; n <= h.end; n++) {
      highlightedLines.add(n);
    }
  }

  const lines: CodeLine[] = [];
  for (const window of merged) {
    for (let n = window.start; n <= window.end; n++) {
      // Strip a trailing CR so CRLF files don't render a stray carriage return.
      const text = (fileLines[n - 1] ?? "").replace(/\r$/, "");
      lines.push({ number: n, text, highlighted: highlightedLines.has(n) });
    }
  }
  return lines.length > 0 ? lines : null;
}

/** Count of removed (left-side) lines, for a deletion-only card's note. */
export function deletionSummary(highlights: HighlightRange[]): number {
  return highlights
    .filter((h) => h.side === "L")
    .reduce((sum, h) => sum + (h.end - h.start + 1), 0);
}

function rangeText(r: HighlightRange): string {
  return r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
}

function lineCount(ranges: HighlightRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

/** Human label of the lines a card points at, e.g. "Added lines 12–18 · Removed line 4". */
export function highlightLabel(highlights: HighlightRange[]): string {
  const right = highlights.filter((h) => h.side === "R");
  const left = highlights.filter((h) => h.side === "L");
  const parts: string[] = [];
  if (right.length > 0) {
    parts.push(`Added line${lineCount(right) === 1 ? "" : "s"} ${right.map(rangeText).join(", ")}`);
  }
  if (left.length > 0) {
    parts.push(`Removed line${lineCount(left) === 1 ? "" : "s"} ${left.map(rangeText).join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No changed lines";
}

/**
 * Project a persisted `Card` plus the (optional) head-side file text into the plain
 * `CardView` the swipe UI renders. Pure: when `fileText` is `null` (fetch failed,
 * file deleted, binary) the code window is `null` and the card degrades to its
 * descriptive label + deletion note. Keeps the server page thin and this mapping
 * unit-testable.
 */
export function toCardView(
  card: Card,
  fileText: string | null,
  postedComments: PostedCardComment[] = [],
): CardView {
  const code = fileText !== null ? buildCodeWindow(fileText.split("\n"), card.highlights) : null;
  return {
    fingerprint: card.fingerprint,
    file: card.file,
    tier: card.tier,
    riskScore: card.riskScore,
    suggestions: card.suggestions,
    explanation: card.explanation,
    code,
    removedLines: deletionSummary(card.highlights),
    highlightLabel: highlightLabel(card.highlights),
    // A comment anchors iff the card points at added (right-side) lines — the same
    // rule `cardCommentAnchor` uses to decide review-comment vs conversation-comment.
    commentAnchored: card.highlights.some((h) => h.side === "R"),
    postedComments,
  };
}

/** Swipe right = "looks good" (👍), swipe left = "flag / needs attention" (👎). */
export function swipeSentiment(direction: "right" | "left"): "up" | "down" {
  return direction === "right" ? "up" : "down";
}

/** Minimum horizontal drag (px) that commits a swipe, scaled to the card width. */
export function swipeThresholdPx(cardWidthPx: number, ratio = 0.25, floorPx = 48): number {
  return Math.max(cardWidthPx * ratio, floorPx);
}

/**
 * Resolve a drag gesture: whether it commits (past the threshold) and in which
 * direction. A drag short of the threshold snaps back (`committed: false`). Shared
 * by touch (Pointer Events) and any pointer drag on desktop.
 */
export function resolveSwipe(
  dragPx: number,
  cardWidthPx: number,
  ratio = 0.25,
): { committed: boolean; direction: "right" | "left" } {
  const committed = Math.abs(dragPx) >= swipeThresholdPx(cardWidthPx, ratio);
  return { committed, direction: dragPx >= 0 ? "right" : "left" };
}

/** Deck progress for the indicator: cards seen so far, total, and a clamped %. */
export function deckProgress(
  reviewedCount: number,
  total: number,
): { done: number; total: number; percent: number } {
  const done = Math.max(0, Math.min(reviewedCount, total));
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}

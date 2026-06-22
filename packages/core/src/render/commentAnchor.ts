import type { Card } from "../schemas/card.js";
import type { PrCommentAnchor } from "../schemas/prComment.js";

/**
 * Derive the diff anchor for a comment left from a deck card (issue #30), or
 * `null` when the card cannot be anchored to changed lines on the head side.
 *
 * Pure, no I/O — so the "where does the comment land" contract is unit-testable.
 * A GitHub review comment must sit on a line that is part of the diff, so we anchor
 * to the card's right-side (added/new) highlights at the deck's head commit. A card
 * with only left-side (deletion) highlights, no highlights, or a missing head SHA
 * returns `null`; the caller then posts a general PR-conversation comment instead.
 * The first right-side range is used (deterministic — cards render in a fixed order
 * and a card usually points at one contiguous added range).
 */
export function cardCommentAnchor(card: Card, headSha: string): PrCommentAnchor | null {
  if (!headSha) {
    return null;
  }
  const right = card.highlights.filter((h) => h.side === "R");
  const range = right[0];
  if (!range) {
    return null;
  }
  return {
    file: card.file,
    line: range.end,
    // Only a multi-line range carries a startLine; a single line omits it so the
    // comment anchors to exactly that line.
    ...(range.end > range.start ? { startLine: range.start } : {}),
    side: "RIGHT",
    commitId: headSha,
  };
}

import { z } from "zod";
import type { Card } from "../schemas/card.js";

/**
 * Pause & resume review sessions (issue #29). The deterministic, vendor-free heart:
 * the per-card decision schema and the pure function that turns a built deck plus
 * the reviewer's decided cards into resume state.
 *
 * Position is *derived*, never stored as a separate cursor — the next unreviewed
 * card is simply the first card with no decision, so "resume to the next unreviewed
 * card" and "n / total reviewed" are one source of truth (the decisions) with no
 * cursor that could drift out of sync. No I/O, no LLM: the swipe UI writes a
 * decision per swipe; this kernel reads them back into a place in the deck.
 */

/**
 * One reviewer decision against a single card, keyed by the card's structural
 * fingerprint (the same id the deck, review cache, reactions, and localizations all
 * share). `decision` reuses the swipe sentiment: right = 👍 `up`, left = 👎 `down`.
 */
export const CardDecisionSchema = z.object({
  fingerprint: z.string().min(1),
  decision: z.enum(["up", "down"]),
});
export type CardDecision = z.infer<typeof CardDecisionSchema>;

/**
 * Resume state for one deck given the set of fingerprints the reviewer has already
 * decided. `reviewed` counts distinct *cards in this deck* that carry a decision (a
 * decided fingerprint absent from the deck — e.g. left over from a different head —
 * does not inflate the count). `nextIndex` is the first undecided card's position,
 * or `total` when every card is decided (the deck-done state). `complete` is true
 * only for a non-empty deck whose every card is decided, so an empty deck never
 * reports as falsely finished.
 */
export function resumeState(
  cards: Card[],
  decided: Iterable<string>,
): { total: number; reviewed: number; nextIndex: number; complete: boolean } {
  const decidedSet = decided instanceof Set ? decided : new Set(decided);
  const total = cards.length;

  let reviewed = 0;
  let nextIndex = total;
  for (let i = 0; i < total; i++) {
    const fingerprint = cards[i]?.fingerprint;
    if (fingerprint !== undefined && decidedSet.has(fingerprint)) {
      reviewed++;
    } else if (nextIndex === total) {
      // First undecided card — the place to resume. Keep scanning to finish the
      // `reviewed` tally (later cards may already be decided).
      nextIndex = i;
    }
  }

  return { total, reviewed, nextIndex, complete: total > 0 && reviewed === total };
}

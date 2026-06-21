import { z } from "zod";

/**
 * The Deck of cards a reviewer swipes through (issue #26). One card per changed
 * hunk, ordered by structural risk so swiping the whole deck means every changed
 * line has been seen, with attention pulled to the risky parts first
 * (STRATEGY.md: own the reviewer's attention allocation).
 *
 * Pure schema, no I/O. `buildDeck` (in `core`) produces it from the deterministic
 * ranking plus the agentic review findings; the `DeckStore` persists it keyed to
 * the PR + head SHA; the swipe UI reads it back and re-validates. Distinct from
 * `ReviewFinding` (#13): a card exists for *every* hunk (not just reviewed ones),
 * carries the highlighted line ranges and the structural risk score, and folds a
 * finding's claims into plain "what could be wrong" suggestions.
 */

/**
 * A contiguous range of changed lines worth scrutinizing. `side` follows the diff
 * convention: "R" = right/new side (added lines), "L" = left/old side (deletions).
 * `start`/`end` are inclusive 1-based line numbers on that side; `end >= start`.
 */
export const HighlightRangeSchema = z
  .object({
    side: z.enum(["L", "R"]),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .refine((r) => r.end >= r.start, { message: "highlight end must be >= start" });
export type HighlightRange = z.infer<typeof HighlightRangeSchema>;

export const CardSchema = z.object({
  /** Structural fingerprint of the hunk — the key shared with the review cache. */
  fingerprint: z.string().min(1),
  /** File the hunk belongs to. */
  file: z.string().min(1),
  /** Risk tier from the structural ranking. */
  tier: z.enum(["High", "Medium", "Low"]),
  /** Deck position, 0 = highest risk / reviewed first. Cards render in this order. */
  rank: z.number().int().nonnegative(),
  /** Structural risk score from `rankHunks` — the cheap ordering signal. */
  riskScore: z.number().nonnegative(),
  /** Exact line ranges to scrutinize. May be empty for a no-op hunk. */
  highlights: z.array(HighlightRangeSchema),
  /** Plain "what could be wrong" prompts, folded from the review's claims. */
  suggestions: z.array(z.string().min(1)),
  /** Plain-language summary of what the change does. */
  explanation: z.string().min(1),
});
export type Card = z.infer<typeof CardSchema>;

/**
 * An ordered deck for one PR at one head SHA. Persisted keyed to
 * `(owner, repo, prNumber, headSha)` so re-opening the PR reuses the deck and a
 * new push (new head SHA) yields a fresh one.
 */
export const DeckSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  /** PR head commit the deck was built against — part of the persistence key. */
  headSha: z.string().min(1),
  cards: z.array(CardSchema),
});
export type Deck = z.infer<typeof DeckSchema>;

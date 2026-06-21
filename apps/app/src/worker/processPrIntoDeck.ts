import { type Deck, type DeckStore, type ReviewFinding, buildDeck } from "@diffsense/core";

/**
 * The deck production step (issue #26): fold the deterministic ranking and the
 * agentic review findings into an ordered `Deck` and persist it keyed to the PR +
 * head SHA. Runs after the review pass, on every review run — so opening a PR (the
 * `opened` webhook) or an on-demand `POST /decks` enqueue both leave a fresh,
 * re-fetchable deck behind. `buildDeck` is pure (`core`); this thin seam wires it
 * to the store and is injected so it is unit-testable with a fake DeckStore.
 */
export interface ProcessDeckContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** PR head commit the deck is keyed to — a new push gets its own deck. */
  headSha: string;
  /** The PR's unified diff, already fetched by the seam that ran the review. */
  diff: string;
}

export async function processPrIntoDeck(
  ctx: ProcessDeckContext,
  findings: readonly ReviewFinding[],
  deckStore: DeckStore,
): Promise<Deck> {
  const deck = buildDeck(ctx.diff, ctx, findings);
  await deckStore.save(deck);
  return deck;
}

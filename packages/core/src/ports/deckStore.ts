import type { Deck } from "../schemas/card.js";

/**
 * Repo coordinates plus the head SHA identifying one persisted deck (issue #26).
 * The head SHA is part of the key: a new push reviews new code, so it gets its
 * own deck rather than overwriting the one the reviewer may still be swiping.
 */
export interface DeckRef {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Port: persist a built deck and read it back for one PR + head SHA.
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` writes the row; the on-demand pipeline saves after building, and the
 * swipe UI reads it back (issue #26, docs/ARCHITECTURE.md §1). `save` is an upsert
 * on `(owner, repo, prNumber, headSha)`: re-running the engine on the same head
 * replaces the deck in place, so a re-fetch always sees exactly one current deck.
 */
export interface DeckStore {
  save(deck: Deck): Promise<void>;
  get(ref: DeckRef): Promise<Deck | null>;
}

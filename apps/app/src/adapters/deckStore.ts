import { type Deck, type DeckRef, DeckSchema, type DeckStore } from "@diffsense/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { decks } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `DeckStore` port (issue #26,
 * docs/ARCHITECTURE.md §1). `core` owns the port and the `Deck`/`Card` shapes;
 * this is the only place that knows it is Postgres. `save` upserts on
 * `(owner, repo, prNumber, headSha)`, so re-running the engine on the same head
 * replaces the deck in place rather than stacking duplicates; `get` re-validates
 * the stored `cards` JSON against `DeckSchema`, so a malformed row fails loudly
 * rather than feeding the swipe UI a broken deck.
 */
export function createDrizzleDeckStore(db: Database): DeckStore {
  return {
    async save(deck: Deck): Promise<void> {
      await db
        .insert(decks)
        .values({
          owner: deck.owner,
          repo: deck.repo,
          prNumber: deck.prNumber,
          headSha: deck.headSha,
          cards: deck.cards,
        })
        .onConflictDoUpdate({
          target: [decks.owner, decks.repo, decks.prNumber, decks.headSha],
          set: { cards: deck.cards, createdAt: new Date() },
        });
    },

    async get({ owner, repo, prNumber, headSha }: DeckRef): Promise<Deck | null> {
      const rows = await db
        .select({ cards: decks.cards })
        .from(decks)
        .where(
          and(
            eq(decks.owner, owner),
            eq(decks.repo, repo),
            eq(decks.prNumber, prNumber),
            eq(decks.headSha, headSha),
          ),
        )
        .limit(1);

      const stored = rows[0]?.cards;
      if (stored === undefined) {
        return null;
      }
      return DeckSchema.parse({ owner, repo, prNumber, headSha, cards: stored });
    },
  };
}

import { type Deck, DeckSchema } from "@diffsense/core";
import { and, desc, eq } from "drizzle-orm";
import { decks, getDb, reactions } from "./db";

/**
 * The swipe deck read-model (issue #27). `apps/web` reads the `decks` table that
 * the on-demand pipeline (#26) writes, re-validates the stored cards against the
 * pure `DeckSchema` from `@diffsense/core`, and hands plain data to the swipe UI.
 * The reader does not know the PR's current head SHA, so it picks the newest deck
 * row for the PR. Strictly a read-model — it never triggers a review or gates a
 * merge.
 */

export interface PrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/** The two swipe outcomes, mapped to the precision-signal sentiment. */
export type SwipeSentiment = "up" | "down";

/**
 * Record a per-card swipe decision (issue #27) — a 👍/👎 against the chunk
 * fingerprint + tier, appended to the same `reactions` precision-signal table the
 * ranked comment and fingerprint cache already feed (docs/ARCHITECTURE.md §6).
 * Advisory only: a swipe is a signal, never a merge/approve/block action.
 */
export async function recordSwipe(
  ref: PrRef,
  fingerprint: string,
  tier: string,
  sentiment: SwipeSentiment,
): Promise<void> {
  await getDb().insert(reactions).values({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    fingerprint,
    tier,
    sentiment,
  });
}

/** The shape of a stored deck row this module cares about (mirrors `decks`). */
export interface DeckRow {
  headSha: string;
  cards: unknown;
  createdAt: Date;
  id: number;
}

/**
 * Pick the newest deck row and validate it into a `Deck`, or `null` when the PR
 * has no deck yet. Pure so the selection + validation contract is unit-testable
 * without a database: newest is by `createdAt` (ties broken by `id`), and the
 * `cards` JSON is parsed against `DeckSchema` so a malformed row throws loudly
 * rather than feeding the swipe UI a broken deck.
 */
export function latestDeckFromRows(rows: DeckRow[], ref: PrRef): Deck | null {
  if (rows.length === 0) {
    return null;
  }
  const newest = rows.reduce((best, row) => {
    const newerTime = row.createdAt.getTime() > best.createdAt.getTime();
    const sameTimeHigherId =
      row.createdAt.getTime() === best.createdAt.getTime() && row.id > best.id;
    return newerTime || sameTimeHigherId ? row : best;
  });
  return DeckSchema.parse({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    headSha: newest.headSha,
    cards: newest.cards,
  });
}

/**
 * The latest persisted deck for one PR, or `null` if none has been built yet.
 * Mirrors `lib/findings.ts` — a lazy Drizzle read over the shared Postgres. The
 * query already orders newest-first and limits to one row; `latestDeckFromRows`
 * carries the validation contract.
 */
export async function getLatestDeck(ref: PrRef): Promise<Deck | null> {
  const rows = await getDb()
    .select({
      headSha: decks.headSha,
      cards: decks.cards,
      createdAt: decks.createdAt,
      id: decks.id,
    })
    .from(decks)
    .where(
      and(eq(decks.owner, ref.owner), eq(decks.repo, ref.repo), eq(decks.prNumber, ref.prNumber)),
    )
    .orderBy(desc(decks.createdAt), desc(decks.id))
    .limit(1);

  return latestDeckFromRows(rows, ref);
}

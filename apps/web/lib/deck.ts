import { type Deck, DeckSchema } from "@diffsense/core";
import { and, desc, eq } from "drizzle-orm";
import { decks, getDb, reactions } from "./db";
import { GitHubAuthError, type GitHubClient } from "./github";

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
 * `cards` JSON is checked against `DeckSchema`. A malformed row (schema drift, a
 * corrupt jsonb write) is logged and treated as "no deck" (returns `null`) rather
 * than throwing — the swipe page then renders its "deck isn't ready" state instead
 * of 500-ing the whole route over one bad row.
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
  const parsed = DeckSchema.safeParse({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    headSha: newest.headSha,
    cards: newest.cards,
  });
  if (!parsed.success) {
    console.error(
      `[deck] discarding malformed deck row id=${newest.id} for ${ref.owner}/${ref.repo}#${ref.prNumber}: ${parsed.error.message}`,
    );
    return null;
  }
  return parsed.data;
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

/**
 * Resolve the head-side file text for a deck's cards so the swipe UI can render
 * the highlighted lines (issue #27, AC#2). Reads each *unique* file once at the
 * deck's head SHA, capped at `cap` files so a large PR cannot fan out unbounded
 * GitHub calls; files beyond the cap are absent from the map and degrade to a
 * descriptive label. Fetches run concurrently (bounded by `cap`) so a slow GitHub
 * cannot serialize into a multi-minute server render. Per-file failures
 * (rate-limit, 404, binary, transient) degrade that one file to `null`; a 401
 * (`GitHubAuthError`) is the one fatal case and propagates so the caller can clear
 * the session and redirect to login.
 */
export async function resolveCardFileTexts(
  github: Pick<GitHubClient, "getFileAtRef">,
  owner: string,
  repo: string,
  headSha: string,
  files: string[],
  cap: number,
): Promise<Map<string, string | null>> {
  const uniqueFiles = [...new Set(files)].slice(0, cap);
  const entries = await Promise.all(
    uniqueFiles.map(async (file): Promise<readonly [string, string | null]> => {
      try {
        return [file, await github.getFileAtRef(owner, repo, file, headSha)];
      } catch (err) {
        // A revoked/expired token is fatal for the whole render — surface it so the
        // caller clears the session. Every other failure degrades just this file.
        if (err instanceof GitHubAuthError) {
          throw err;
        }
        return [file, null];
      }
    }),
  );
  return new Map(entries);
}

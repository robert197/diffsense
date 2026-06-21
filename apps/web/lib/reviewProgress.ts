import { type Card, type CardDecision, DeckSchema, resumeState } from "@diffsense/core";
import { and, eq, or } from "drizzle-orm";
import { decks, getDb, reviewProgress } from "./db";
import { newestRow } from "./deck";

/**
 * Pause & resume review sessions (issue #29) — the `apps/web` DB helper over the
 * `review_progress` table. The swipe action records a per-card decision on every
 * swipe; the deck page reads a reviewer's decided cards back to resume at the next
 * unreviewed one; the "Continue reviewing" dashboard lists in-progress reviews with
 * `n / total` progress. The pure resume math (`resumeState`) lives in
 * `@diffsense/core`; this module owns only the Postgres reads/writes and the pure
 * `summarizeInProgress` projection — mirroring how `lib/deck.ts` reads the shared
 * Postgres directly rather than through a core port. Strictly per-reviewer state:
 * it carries no merge/approve authority.
 */

/** The persistence key — a reviewer's progress on one PR at one head SHA. */
export interface ProgressRef {
  githubUserId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Record (upsert) a reviewer's decision on one card. Keyed by
 * `(githubUserId, owner, repo, prNumber, headSha, fingerprint)`: one decision per
 * card per reviewer per head, the latest swipe winning. Called on every swipe, so a
 * reload/logout/device-switch resumes exactly where the reviewer left off.
 */
export async function recordDecision(
  ref: ProgressRef,
  fingerprint: string,
  decision: "up" | "down",
): Promise<void> {
  await getDb()
    .insert(reviewProgress)
    .values({
      githubUserId: ref.githubUserId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      headSha: ref.headSha,
      fingerprint,
      decision,
    })
    .onConflictDoUpdate({
      target: [
        reviewProgress.githubUserId,
        reviewProgress.owner,
        reviewProgress.repo,
        reviewProgress.prNumber,
        reviewProgress.headSha,
        reviewProgress.fingerprint,
      ],
      set: { decision, updatedAt: new Date() },
    });
}

/**
 * The reviewer's decided cards for one deck (PR + head SHA). The deck page derives
 * the resume index and the up/down tally from these via `resumeState`.
 */
export async function getDecidedFingerprints(ref: ProgressRef): Promise<CardDecision[]> {
  const rows = await getDb()
    .select({ fingerprint: reviewProgress.fingerprint, decision: reviewProgress.decision })
    .from(reviewProgress)
    .where(
      and(
        eq(reviewProgress.githubUserId, ref.githubUserId),
        eq(reviewProgress.owner, ref.owner),
        eq(reviewProgress.repo, ref.repo),
        eq(reviewProgress.prNumber, ref.prNumber),
        eq(reviewProgress.headSha, ref.headSha),
      ),
    );
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    decision: r.decision === "down" ? "down" : "up",
  }));
}

/** The deck page's resume point: where to drop the reviewer + their prior tally. */
export interface ResumeView {
  /** Index of the first undecided card — where `SwipeDeck` starts. */
  index: number;
  /** Prior 👍/👎 tally, counted per card in this deck so the resumed progress is right. */
  counts: { up: number; down: number };
}

/**
 * Resume point + prior tally from the reviewer's persisted decisions (issue #29).
 * The next card is the first undecided one (`resumeState`); the up/down tally is
 * counted by walking the deck's cards (not the decisions), so a decision whose card
 * is not in this deck — e.g. left over from a different head SHA — is ignored and the
 * tally stays consistent with `resumeState`'s `reviewed` count even if a deck ever
 * carried a duplicate fingerprint.
 */
export function computeResume(cards: Card[], decisions: CardDecision[]): ResumeView {
  const decisionByFingerprint = new Map(decisions.map((d) => [d.fingerprint, d.decision]));
  const counts = { up: 0, down: 0 };
  const decided = new Set<string>();
  for (const card of cards) {
    const decision = decisionByFingerprint.get(card.fingerprint);
    if (decision) {
      counts[decision] += 1;
      decided.add(card.fingerprint);
    }
  }
  const { nextIndex } = resumeState(cards, decided);
  return { index: nextIndex, counts };
}

/** One row of progress as stored (a single card decision). */
export interface ProgressRow {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  fingerprint: string;
  decision: string;
  updatedAt: Date;
}

/** A deck row needed to compute progress totals + staleness (mirrors `decks`). */
export interface ProgressDeckRow {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  cards: unknown;
  createdAt: Date;
  id: number;
}

/** One in-progress review for the dashboard. */
export interface InProgressReview {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewed: number;
  total: number;
  /** True when a newer deck exists for this PR than the head the reviewer worked. */
  stale: boolean;
  updatedAt: Date;
}

// GitHub owner / repo names and commit SHAs cannot contain "/", so it is a
// collision-free separator for the composite map keys below.
function prKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}/${prNumber}`;
}

/**
 * Project a reviewer's raw progress + deck rows into the dashboard's in-progress
 * list. Pure, so the selection contract is unit-testable without a database:
 * - groups decisions by `(owner, repo, prNumber, headSha)`;
 * - validates the matching deck's cards against `DeckSchema`, computing
 *   `reviewed / total` via the same `resumeState` kernel the deck page uses;
 * - drops groups that are untouched (`reviewed === 0`), finished (`reviewed === total`),
 *   or whose deck row is missing/malformed (logged, never thrown);
 * - flags a group `stale` when a newer deck exists for the PR than the head it
 *   targets (the cheap, DB-only staleness signal the dashboard shows);
 * - returns the surviving reviews newest-activity first.
 */
export function summarizeInProgress(
  progressRows: ProgressRow[],
  deckRows: ProgressDeckRow[],
): InProgressReview[] {
  // Group deck rows per PR, and index them by exact head for the total card count.
  const decksByPr = new Map<string, ProgressDeckRow[]>();
  const deckByHead = new Map<string, ProgressDeckRow>();
  for (const deck of deckRows) {
    const pr = prKey(deck.owner, deck.repo, deck.prNumber);
    deckByHead.set(`${pr}/${deck.headSha}`, deck);
    const list = decksByPr.get(pr);
    if (list) {
      list.push(deck);
    } else {
      decksByPr.set(pr, [deck]);
    }
  }

  // Newest deck head per PR — the "current" deck, for the staleness comparison.
  // Reuses the same newest-row tie-break the deck read uses, so the two never drift.
  const latestHead = new Map<string, ProgressDeckRow>();
  for (const [pr, list] of decksByPr) {
    const newest = newestRow(list);
    if (newest) {
      latestHead.set(pr, newest);
    }
  }

  // Group the decisions by the deck they belong to.
  type Group = {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    decided: Set<string>;
    updatedAt: Date;
  };
  const groups = new Map<string, Group>();
  for (const row of progressRows) {
    const key = `${prKey(row.owner, row.repo, row.prNumber)}/${row.headSha}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        headSha: row.headSha,
        decided: new Set(),
        updatedAt: row.updatedAt,
      };
      groups.set(key, group);
    }
    group.decided.add(row.fingerprint);
    if (row.updatedAt.getTime() > group.updatedAt.getTime()) {
      group.updatedAt = row.updatedAt;
    }
  }

  const reviews: InProgressReview[] = [];
  for (const group of groups.values()) {
    const pr = prKey(group.owner, group.repo, group.prNumber);
    const deck = deckByHead.get(`${pr}/${group.headSha}`);
    if (!deck) {
      // The deck for the head this reviewer worked is no longer persisted — cannot
      // show n/total. Skip rather than guess.
      continue;
    }
    const parsed = DeckSchema.safeParse({
      owner: group.owner,
      repo: group.repo,
      prNumber: group.prNumber,
      headSha: group.headSha,
      cards: deck.cards,
    });
    if (!parsed.success) {
      console.error(
        `[reviewProgress] skipping malformed deck ${pr}@${group.headSha}: ${parsed.error.message}`,
      );
      continue;
    }
    const { total, reviewed } = resumeState(parsed.data.cards, group.decided);
    if (total === 0 || reviewed === 0 || reviewed === total) {
      // Nothing started, an empty deck, or already finished — not "in progress".
      continue;
    }
    const current = latestHead.get(pr);
    reviews.push({
      owner: group.owner,
      repo: group.repo,
      prNumber: group.prNumber,
      headSha: group.headSha,
      reviewed,
      total,
      stale: !!current && current.headSha !== group.headSha,
      updatedAt: group.updatedAt,
    });
  }

  return reviews.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * List one reviewer's in-progress reviews for the "Continue reviewing" dashboard.
 * Loads the reviewer's decisions, then the decks for the PRs they have touched, and
 * hands both to `summarizeInProgress`. Deck breadth is bounded by the reviewer's own
 * in-progress set; a fuller paginated dashboard is deferred.
 */
export async function listInProgress(githubUserId: number): Promise<InProgressReview[]> {
  const db = getDb();
  const progressRows: ProgressRow[] = await db
    .select({
      owner: reviewProgress.owner,
      repo: reviewProgress.repo,
      prNumber: reviewProgress.prNumber,
      headSha: reviewProgress.headSha,
      fingerprint: reviewProgress.fingerprint,
      decision: reviewProgress.decision,
      updatedAt: reviewProgress.updatedAt,
    })
    .from(reviewProgress)
    .where(eq(reviewProgress.githubUserId, githubUserId));

  if (progressRows.length === 0) {
    return [];
  }

  // Distinct PRs the reviewer has progress on → one OR-of-ANDs filter for their decks.
  const seen = new Set<string>();
  const prRefs: Array<{ owner: string; repo: string; prNumber: number }> = [];
  for (const row of progressRows) {
    const key = prKey(row.owner, row.repo, row.prNumber);
    if (!seen.has(key)) {
      seen.add(key);
      prRefs.push({ owner: row.owner, repo: row.repo, prNumber: row.prNumber });
    }
  }

  const deckRows: ProgressDeckRow[] = await db
    .select({
      owner: decks.owner,
      repo: decks.repo,
      prNumber: decks.prNumber,
      headSha: decks.headSha,
      cards: decks.cards,
      createdAt: decks.createdAt,
      id: decks.id,
    })
    .from(decks)
    .where(
      or(
        ...prRefs.map((ref) =>
          and(
            eq(decks.owner, ref.owner),
            eq(decks.repo, ref.repo),
            eq(decks.prNumber, ref.prNumber),
          ),
        ),
      ),
    );

  return summarizeInProgress(progressRows, deckRows);
}

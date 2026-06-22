import type { Card } from "@diffsense/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decks, getDb, prStatus, reviewProgress } from "./db";
import {
  computeResume,
  getDecidedFingerprints,
  listInProgress,
  listReviewSessions,
  recordDecision,
} from "./reviewProgress";

/**
 * End-to-end coverage for pause & resume (issue #29) against a REAL Postgres — the
 * acceptance criteria exercised through the actual Drizzle queries, not mocks, so a
 * wrong column, a broken upsert target, or the new CHECK constraint would surface
 * here rather than in production. Requires `DATABASE_URL` with migrations applied
 * (the CI compose/service); skips locally when it is unset, mirroring `db.test.ts`.
 *
 * Covers: AC#1 (decision persists on swipe + last-write-wins upsert), AC#2 (dashboard
 * n/total), AC#3 (resume to the next unreviewed card), AC#4 (state survives a fresh
 * read for the same user / is per-user), AC#5 (DB-only staleness when a newer head's
 * deck exists), and the `decision` domain CHECK.
 */

const databaseUrl = process.env.DATABASE_URL;

// Isolate this run's rows from any other data in the shared DB.
const RUN = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
const USER = 800_000_000 + Math.round(Math.random() * 1e8);
const OTHER_USER = USER + 1;
const OWNER = `it-rp-${RUN}`;
const REPO = "web";
const PR = 7;
const H1 = `sha1-${RUN}`;
const H2 = `sha2-${RUN}`;

function card(fingerprint: string): Card {
  return {
    fingerprint,
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 1,
    highlights: [],
    suggestions: [],
    explanation: "does a thing",
  };
}

const CARDS = [card("a"), card("b"), card("c")];

function ref(headSha: string, githubUserId = USER) {
  return { githubUserId, owner: OWNER, repo: REPO, prNumber: PR, headSha };
}

describe.skipIf(!databaseUrl)("review progress round-trip (issue #29)", () => {
  beforeAll(async () => {
    // Seed the deck the reviewer is swiping (head H1) so totals/resume can be computed.
    await getDb()
      .insert(decks)
      .values({ owner: OWNER, repo: REPO, prNumber: PR, headSha: H1, cards: CARDS });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(reviewProgress).where(eq(reviewProgress.owner, OWNER));
    await db.delete(decks).where(eq(decks.owner, OWNER));
    await db.delete(prStatus).where(eq(prStatus.owner, OWNER));
  });

  beforeEach(async () => {
    // Each test starts from a clean slate of decisions + PR status (decks persist).
    await getDb().delete(reviewProgress).where(eq(reviewProgress.owner, OWNER));
    await getDb().delete(prStatus).where(eq(prStatus.owner, OWNER));
  });

  it("persists a decision on a swipe and reads it back (AC#1)", async () => {
    await recordDecision(ref(H1), "a", "up");
    await recordDecision(ref(H1), "b", "down");

    const decided = await getDecidedFingerprints(ref(H1));
    expect(decided).toEqual(
      expect.arrayContaining([
        { fingerprint: "a", decision: "up" },
        { fingerprint: "b", decision: "down" },
      ]),
    );
    expect(decided).toHaveLength(2);
  });

  it("upserts: re-swiping a card replaces the decision, last write wins (AC#1)", async () => {
    await recordDecision(ref(H1), "a", "up");
    await recordDecision(ref(H1), "a", "down");

    const decided = await getDecidedFingerprints(ref(H1));
    // Exactly one row for the card — replaced in place, not stacked.
    expect(decided).toEqual([{ fingerprint: "a", decision: "down" }]);
  });

  it("resumes at the next unreviewed card (AC#3)", async () => {
    await recordDecision(ref(H1), "a", "up");

    const decided = await getDecidedFingerprints(ref(H1));
    const resume = computeResume(CARDS, decided);
    // Card 0 (a) decided, card 1 (b) is next.
    expect(resume).toEqual({ index: 1, counts: { up: 1, down: 0 } });
  });

  it("keeps state per-user and serves it to a fresh read / new device (AC#4)", async () => {
    await recordDecision(ref(H1), "a", "up");

    // A fresh read for the SAME user (a reload or a second device) sees the decision.
    expect(await getDecidedFingerprints(ref(H1))).toEqual([{ fingerprint: "a", decision: "up" }]);
    // A different user has their own (empty) state — no cross-user bleed.
    expect(await getDecidedFingerprints(ref(H1, OTHER_USER))).toEqual([]);
  });

  it("lists the in-progress review with n/total on the dashboard (AC#2)", async () => {
    await recordDecision(ref(H1), "a", "up");

    const reviews = await listInProgress(USER);
    const mine = reviews.find((r) => r.owner === OWNER && r.prNumber === PR);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ headSha: H1, reviewed: 1, total: 3, stale: false });
  });

  it("flags the deck stale once a newer head's deck exists (AC#5)", async () => {
    await recordDecision(ref(H1), "a", "up");
    // A later push produced a fresh deck (H2) — the reviewer's H1 progress is now stale.
    await getDb()
      .insert(decks)
      .values({ owner: OWNER, repo: REPO, prNumber: PR, headSha: H2, cards: [card("x")] });

    const reviews = await listInProgress(USER);
    const mine = reviews.find((r) => r.owner === OWNER && r.headSha === H1);
    expect(mine).toMatchObject({ stale: true, reviewed: 1, total: 3 });

    // Clean up the extra deck so it can't leak into other tests.
    await getDb()
      .delete(decks)
      .where(and(eq(decks.owner, OWNER), eq(decks.headSha, H2)));
  });

  it("moves a touched PR into the Done bucket once pr_status is merged (#31, AC#2/AC#3)", async () => {
    // The full dashboard join end-to-end: the reviewer touched H1, and background sync
    // recorded the PR as merged. listReviewSessions must load review_progress + decks +
    // pr_status from real Postgres and route this session OUT of active and INTO archived.
    await recordDecision(ref(H1), "a", "up");
    await getDb()
      .insert(prStatus)
      .values({ owner: OWNER, repo: REPO, prNumber: PR, status: "merged", installationId: 99 });

    const { active, archived } = await listReviewSessions(USER);

    expect(active.find((r) => r.owner === OWNER && r.prNumber === PR)).toBeUndefined();
    const done = archived.find((r) => r.owner === OWNER && r.prNumber === PR);
    expect(done).toMatchObject({ headSha: H1, reviewed: 1, total: 3, status: "merged" });
  });

  it("keeps a touched PR in the active list while pr_status is still open (#31, AC#3)", async () => {
    // The inverse: an explicit open pr_status row (or none) leaves the session active so
    // the Done split only fires on a real terminal status, never spuriously.
    await recordDecision(ref(H1), "a", "up");
    await getDb()
      .insert(prStatus)
      .values({ owner: OWNER, repo: REPO, prNumber: PR, status: "open", installationId: 99 });

    const { active, archived } = await listReviewSessions(USER);

    expect(archived.find((r) => r.owner === OWNER && r.prNumber === PR)).toBeUndefined();
    expect(active.find((r) => r.owner === OWNER && r.prNumber === PR)).toMatchObject({
      headSha: H1,
      reviewed: 1,
      total: 3,
    });
  });

  it("badges a closed-not-merged PR as closed in the Done bucket (#31)", async () => {
    await recordDecision(ref(H1), "a", "up");
    await getDb()
      .insert(prStatus)
      .values({ owner: OWNER, repo: REPO, prNumber: PR, status: "closed", installationId: 99 });

    const { active, archived } = await listReviewSessions(USER);

    expect(active.find((r) => r.owner === OWNER && r.prNumber === PR)).toBeUndefined();
    expect(archived.find((r) => r.owner === OWNER && r.prNumber === PR)).toMatchObject({
      status: "closed",
    });
  });

  it("rejects a decision outside the up/down domain at the DB layer (CHECK constraint)", async () => {
    await expect(
      getDb().insert(reviewProgress).values({
        githubUserId: USER,
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha: H1,
        fingerprint: "bad",
        decision: "sideways",
      }),
    ).rejects.toThrow();
  });
});

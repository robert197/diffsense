import type { Card } from "@diffsense/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the review-progress store (issue #29). The pure `resumeState`
 * kernel is tested in `@diffsense/core`; here we prove the web layer's own value:
 * the keyed upsert on a swipe (`recordDecision`), the decided-cards read
 * (`getDecidedFingerprints`), and the dashboard projection (`summarizeInProgress`) —
 * its `n/total`, completed/untouched filtering, and DB-only staleness signal. The
 * Drizzle client and operators are mocked so no Postgres is needed.
 */

const h = vi.hoisted(() => ({
  inserted: [] as Array<{ values: Record<string, unknown>; conflict: Record<string, unknown> }>,
  selectRows: [] as Array<{ fingerprint: string; decision: string }>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  or: (...args: unknown[]) => ({ or: args }),
}));

vi.mock("./db", () => ({
  reviewProgress: {
    githubUserId: "github_user_id",
    owner: "owner",
    repo: "repo",
    prNumber: "pr_number",
    headSha: "head_sha",
    fingerprint: "fingerprint",
    decision: "decision",
    updatedAt: "updated_at",
  },
  decks: {},
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (conflict: Record<string, unknown>) => {
          h.inserted.push({ values, conflict });
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => Promise.resolve(h.selectRows) }) }),
  }),
}));

import {
  type ProgressDeckRow,
  type ProgressRow,
  computeResume,
  getDecidedFingerprints,
  recordDecision,
  summarizeInProgress,
} from "./reviewProgress";

const ref = { githubUserId: 42, owner: "acme", repo: "web", prNumber: 7, headSha: "h1" };

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

function deckRow(
  headSha: string,
  cards: unknown,
  createdAtMs: number,
  id: number,
  over: Partial<ProgressDeckRow> = {},
): ProgressDeckRow {
  return {
    owner: "acme",
    repo: "web",
    prNumber: 7,
    headSha,
    cards,
    createdAt: new Date(createdAtMs),
    id,
    ...over,
  };
}

function progressRow(headSha: string, fingerprint: string, updatedAtMs: number): ProgressRow {
  return {
    owner: "acme",
    repo: "web",
    prNumber: 7,
    headSha,
    fingerprint,
    decision: "up",
    updatedAt: new Date(updatedAtMs),
  };
}

describe("recordDecision", () => {
  beforeEach(() => {
    h.inserted.length = 0;
  });

  it("upserts a decision keyed by user + PR + head + fingerprint", async () => {
    await recordDecision(ref, "fp-1", "up");
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].values).toMatchObject({
      githubUserId: 42,
      owner: "acme",
      repo: "web",
      prNumber: 7,
      headSha: "h1",
      fingerprint: "fp-1",
      decision: "up",
    });
    // The conflict target is the 6-column key; the decision is replaced on re-swipe.
    expect(h.inserted[0].conflict.target).toHaveLength(6);
    expect((h.inserted[0].conflict.set as Record<string, unknown>).decision).toBe("up");
  });

  it("records a down decision for a flag swipe", async () => {
    await recordDecision(ref, "fp-2", "down");
    expect(h.inserted[0].values).toMatchObject({ fingerprint: "fp-2", decision: "down" });
  });
});

describe("getDecidedFingerprints", () => {
  beforeEach(() => {
    h.selectRows.length = 0;
  });

  it("returns the reviewer's decided cards for the deck", async () => {
    h.selectRows.push({ fingerprint: "a", decision: "up" }, { fingerprint: "b", decision: "down" });
    expect(await getDecidedFingerprints(ref)).toEqual([
      { fingerprint: "a", decision: "up" },
      { fingerprint: "b", decision: "down" },
    ]);
  });

  it("normalizes an unexpected decision value to up", async () => {
    h.selectRows.push({ fingerprint: "a", decision: "weird" });
    expect(await getDecidedFingerprints(ref)).toEqual([{ fingerprint: "a", decision: "up" }]);
  });

  it("returns an empty list when nothing has been decided", async () => {
    expect(await getDecidedFingerprints(ref)).toEqual([]);
  });
});

describe("summarizeInProgress", () => {
  const deck3 = [card("a"), card("b"), card("c")];

  it("computes n/total for an in-progress deck", () => {
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 2000)],
      [deckRow("h1", deck3, 1000, 1)],
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ prNumber: 7, reviewed: 1, total: 3, stale: false });
  });

  it("excludes a completed deck (all cards decided)", () => {
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 2000), progressRow("h1", "b", 2001), progressRow("h1", "c", 2002)],
      [deckRow("h1", deck3, 1000, 1)],
    );
    expect(reviews).toEqual([]);
  });

  it("excludes an untouched group whose decisions are not cards in this deck (reviewed === 0)", () => {
    // The reviewer has a decision row for "ghost", but the matching deck holds a/b/c —
    // so resumeState counts 0 reviewed and the group is not "in progress".
    const reviews = summarizeInProgress(
      [progressRow("h1", "ghost", 2000)],
      [deckRow("h1", deck3, 1000, 1)],
    );
    expect(reviews).toEqual([]);
  });

  it("excludes an empty deck (total === 0) even with a decision row present", () => {
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 2000)],
      [deckRow("h1", [], 1000, 1)],
    );
    expect(reviews).toEqual([]);
  });

  it("excludes a group whose deck row is missing", () => {
    const reviews = summarizeInProgress(
      [progressRow("gone", "a", 2000)],
      [deckRow("h1", deck3, 1000, 1)],
    );
    expect(reviews).toEqual([]);
  });

  it("flags a group as stale when a newer deck exists for the PR", () => {
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 2000)],
      [deckRow("h1", deck3, 1000, 1), deckRow("h2", [card("x"), card("y")], 5000, 2)],
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ headSha: "h1", stale: true });
  });

  it("does not flag the latest-head group as stale", () => {
    const reviews = summarizeInProgress(
      [progressRow("h2", "x", 6000)],
      [deckRow("h1", deck3, 1000, 1), deckRow("h2", [card("x"), card("y")], 5000, 2)],
    );
    expect(reviews[0]).toMatchObject({ headSha: "h2", stale: false, reviewed: 1, total: 2 });
  });

  it("skips a malformed deck payload (logged) without throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 2000)],
      [deckRow("h1", "not-an-array", 1000, 1)],
    );
    expect(reviews).toEqual([]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("sorts surviving reviews newest-activity first", () => {
    const otherDeck = deckRow("k1", [card("m"), card("n")], 1000, 9, { prNumber: 8 });
    const reviews = summarizeInProgress(
      [progressRow("h1", "a", 1000), { ...progressRow("k1", "m", 9000), prNumber: 8 }],
      [deckRow("h1", deck3, 1000, 1), otherDeck],
    );
    expect(reviews.map((r) => r.prNumber)).toEqual([8, 7]);
  });
});

describe("computeResume", () => {
  const deck3 = [card("a"), card("b"), card("c")];

  it("starts at card 0 with an empty tally when nothing is decided", () => {
    expect(computeResume(deck3, [])).toEqual({ index: 0, counts: { up: 0, down: 0 } });
  });

  it("resumes at the first undecided card and tallies the prior decisions (AC#3)", () => {
    expect(computeResume(deck3, [{ fingerprint: "a", decision: "up" }])).toEqual({
      index: 1,
      counts: { up: 1, down: 0 },
    });
  });

  it("counts a down (flag) decision toward the tally", () => {
    expect(
      computeResume(deck3, [
        { fingerprint: "a", decision: "up" },
        { fingerprint: "b", decision: "down" },
      ]),
    ).toEqual({ index: 2, counts: { up: 1, down: 1 } });
  });

  it("resumes at the first gap and counts per card even when decisions are non-contiguous", () => {
    // a and c decided, b not — resume at b (index 1); the tally still reflects both.
    expect(
      computeResume(deck3, [
        { fingerprint: "a", decision: "up" },
        { fingerprint: "c", decision: "up" },
      ]),
    ).toEqual({ index: 1, counts: { up: 2, down: 0 } });
  });

  it("ignores a decision whose card is not in this deck (a different head's leftover)", () => {
    expect(computeResume(deck3, [{ fingerprint: "ghost", decision: "down" }])).toEqual({
      index: 0,
      counts: { up: 0, down: 0 },
    });
  });
});

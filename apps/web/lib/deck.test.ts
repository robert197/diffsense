import type { Card } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";

// Capture inserts without a real database. `recordSwipe` calls `getDb().insert(table).values(...)`;
// the fake records the payload so the write contract is unit-testable.
const h = vi.hoisted(() => ({ inserts: [] as Array<{ values: Record<string, unknown> }> }));

vi.mock("./db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ values });
        return Promise.resolve();
      },
    }),
  }),
  decks: {},
  reactions: {},
}));

import { type DeckRow, latestDeckFromRows, recordSwipe } from "./deck";

const ref = { owner: "acme", repo: "web", prNumber: 7 };

function card(fingerprint: string): Card {
  return {
    fingerprint,
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 1.2,
    highlights: [],
    suggestions: [],
    explanation: "does a thing",
  };
}

function row(headSha: string, cards: unknown, createdAtMs: number, id: number): DeckRow {
  return { headSha, cards, createdAt: new Date(createdAtMs), id };
}

describe("latestDeckFromRows", () => {
  it("validates a stored row into a Deck, preserving card order", () => {
    const cards = [card("a"), card("b")];
    const deck = latestDeckFromRows([row("sha1", cards, 1000, 1)], ref);
    expect(deck).not.toBeNull();
    expect(deck?.headSha).toBe("sha1");
    expect(deck?.cards.map((c) => c.fingerprint)).toEqual(["a", "b"]);
  });

  it("returns null when the PR has no deck", () => {
    expect(latestDeckFromRows([], ref)).toBeNull();
  });

  it("picks the newest row by createdAt, breaking ties by id", () => {
    const older = row("old", [card("a")], 1000, 1);
    const newer = row("new", [card("b")], 2000, 2);
    expect(latestDeckFromRows([older, newer], ref)?.headSha).toBe("new");
    expect(latestDeckFromRows([newer, older], ref)?.headSha).toBe("new");

    const tieLow = row("low", [card("a")], 3000, 5);
    const tieHigh = row("high", [card("b")], 3000, 9);
    expect(latestDeckFromRows([tieLow, tieHigh], ref)?.headSha).toBe("high");
  });

  it("throws on a malformed cards payload rather than feeding a broken deck", () => {
    const bad = [{ fingerprint: "x", file: "a.ts", tier: "High", rank: 0, riskScore: 1 }];
    expect(() => latestDeckFromRows([row("sha", bad, 1000, 1)], ref)).toThrow();
  });
});

describe("recordSwipe", () => {
  it("appends an up reaction keyed by fingerprint + tier", async () => {
    h.inserts.length = 0;
    await recordSwipe(ref, "fp-up", "High", "up");
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].values).toMatchObject({
      owner: "acme",
      repo: "web",
      prNumber: 7,
      fingerprint: "fp-up",
      tier: "High",
      sentiment: "up",
    });
  });

  it("records a down reaction for a flag swipe", async () => {
    h.inserts.length = 0;
    await recordSwipe(ref, "fp-down", "Medium", "down");
    expect(h.inserts[0].values).toMatchObject({ fingerprint: "fp-down", sentiment: "down" });
  });
});

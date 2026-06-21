import type { Card, Deck } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { createDrizzleDeckStore } from "./deckStore.js";

const card: Card = {
  fingerprint: "fp-a",
  file: "src/auth.ts",
  tier: "High",
  rank: 0,
  riskScore: 4.2,
  highlights: [{ side: "R", start: 2, end: 4 }],
  suggestions: ["checkToken() is never awaited"],
  explanation: "Replaces the stub with a real token check.",
};

const deck: Deck = {
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  headSha: "abc123",
  cards: [card],
};

/** Minimal insert chain stub: captures the upsert the save issues. */
function insertStub() {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn((_row: Record<string, unknown>) => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoUpdate };
}

/** Minimal select chain stub returning the given rows. */
function selectStub(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, limit, where, from };
}

describe("createDrizzleDeckStore (#26)", () => {
  it("save upserts the deck on its (owner, repo, pr, head) key", async () => {
    const s = insertStub();
    const db = { insert: s.insert } as unknown as Database;

    await createDrizzleDeckStore(db).save(deck);

    expect(s.values).toHaveBeenCalledOnce();
    expect(s.values.mock.calls[0]?.[0]).toMatchObject({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      headSha: "abc123",
      cards: [card],
    });
    expect(s.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("get returns null when no row matches", async () => {
    const s = selectStub([]);
    const db = { select: s.select } as unknown as Database;

    const out = await createDrizzleDeckStore(db).get({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      headSha: "abc123",
    });

    expect(out).toBeNull();
  });

  it("get maps a stored row back to a validated deck", async () => {
    const s = selectStub([{ cards: [card] }]);
    const db = { select: s.select } as unknown as Database;

    const out = await createDrizzleDeckStore(db).get({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      headSha: "abc123",
    });

    expect(out).toEqual(deck);
  });

  it("get surfaces a row whose cards JSON fails the schema (no silent drop)", async () => {
    const bad = { cards: [{ ...card, explanation: "" }] }; // violates min(1)
    const s = selectStub([bad]);
    const db = { select: s.select } as unknown as Database;

    await expect(
      createDrizzleDeckStore(db).get({
        owner: "octo",
        repo: "demo",
        prNumber: 7,
        headSha: "abc123",
      }),
    ).rejects.toThrow();
  });
});

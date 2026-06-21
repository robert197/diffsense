import type { ChunkReview, Deck } from "@diffsense/core";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDrizzleConventionStore } from "../adapters/conventionStore.js";
import { createDrizzleCostStore } from "../adapters/costStore.js";
import { createDrizzleDeckStore } from "../adapters/deckStore.js";
import { createDrizzleFingerprintCache } from "../adapters/fingerprintCache.js";
import { createDrizzleReactionStore } from "../adapters/reactionStore.js";
import { createDb } from "./client.js";
import { costs, decks, processedEvents, reactions } from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;

// Requires a real Postgres with migrations applied (CI compose/service).
// Skips locally when DATABASE_URL is unset — see plan U3 execution note (R6).
describe.skipIf(!databaseUrl)("db round-trip (R6)", () => {
  const { db, client } = createDb(databaseUrl as string);

  afterAll(async () => {
    await client.end();
  });

  it("inserts and reads back a processed_events row", async () => {
    const deliveryId = `test-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    await db.insert(processedEvents).values({ deliveryId, action: "opened" });

    const rows = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.deliveryId, deliveryId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("opened");
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("records a reviewer reaction against its tier (R3)", async () => {
    const store = createDrizzleReactionStore(db);
    const fingerprint = `fp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    await store.record({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      fingerprint,
      tier: "High",
      sentiment: "up",
    });

    const rows = await db.select().from(reactions).where(eq(reactions.fingerprint, fingerprint));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe("High");
    expect(rows[0]?.sentiment).toBe("up");
    expect(rows[0]?.prNumber).toBe(42);
  });

  it("round-trips per-repo convention notes, last write wins (#7, R4)", async () => {
    const store = createDrizzleConventionStore(db);
    const repo = { owner: `octo-${Date.now()}`, repo: `demo-${Math.round(Math.random() * 1e6)}` };

    await expect(store.readConventions(repo)).resolves.toBeNull();

    await store.writeConventions(repo, "note A");
    await expect(store.readConventions(repo)).resolves.toBe("note A");

    await store.writeConventions(repo, "note B");
    await expect(store.readConventions(repo)).resolves.toBe("note B");
  });

  it("round-trips a cached ChunkReview by fingerprint, last write wins (#8)", async () => {
    const cache = createDrizzleFingerprintCache(db);
    const repo = { owner: `octo-${Date.now()}`, repo: `demo-${Math.round(Math.random() * 1e6)}` };
    const fingerprint = `fp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    const first: ChunkReview = {
      explanation: "adds a guard",
      claims: [{ claim: "guards null", evidence: "src/a.ts:1" }],
      rating: "low",
      reasons: ["small change"],
    };

    await expect(cache.get(repo, fingerprint)).resolves.toBeNull();

    await cache.set(repo, fingerprint, first);
    await expect(cache.get(repo, fingerprint)).resolves.toEqual(first);

    const second: ChunkReview = { ...first, rating: "high", reasons: ["touches auth"] };
    await cache.set(repo, fingerprint, second);
    await expect(cache.get(repo, fingerprint)).resolves.toEqual(second);
  });

  it("persists a per-PR inference cost record, append-only (#12)", async () => {
    const store = createDrizzleCostStore(db);
    const prNumber = Math.round(Math.random() * 1e6);

    await store.record({
      owner: "octo-org",
      repo: "demo",
      prNumber,
      inputTokens: 3_500_000,
      outputTokens: 350_000,
      costUsd: 36.75,
      overThreshold: true,
    });

    const rows = await db.select().from(costs).where(eq(costs.prNumber, prNumber));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(3_500_000);
    expect(rows[0]?.outputTokens).toBe(350_000);
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(36.75, 6);
    expect(rows[0]?.overThreshold).toBe(true);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("persists a deck and re-fetches it by PR + head SHA, upsert replacing in place (#26)", async () => {
    const store = createDrizzleDeckStore(db);
    const ref = {
      owner: `octo-${Date.now()}`,
      repo: `demo-${Math.round(Math.random() * 1e6)}`,
      prNumber: Math.round(Math.random() * 1e6),
      headSha: `sha-${Math.round(Math.random() * 1e6)}`,
    };
    const card = {
      fingerprint: "fp-a",
      file: "src/auth.ts",
      tier: "High" as const,
      rank: 0,
      riskScore: 4.2,
      highlights: [{ side: "R" as const, start: 2, end: 4 }],
      suggestions: ["checkToken() is never awaited"],
      explanation: "Adds a token check.",
    };
    const deck: Deck = { ...ref, cards: [card] };

    // Missing key reads back null.
    await expect(store.get(ref)).resolves.toBeNull();

    // First save persists; re-fetch round-trips through DeckSchema re-validation.
    await store.save(deck);
    await expect(store.get(ref)).resolves.toEqual(deck);

    // Re-running on the SAME head upserts in place (this exercises the
    // onConflictDoUpdate target == the UNIQUE(owner,repo,pr,head) constraint —
    // a mismatch would throw here against real Postgres, which stubs cannot catch).
    const replaced: Deck = { ...deck, cards: [{ ...card, explanation: "Revised." }] };
    await store.save(replaced);

    const after = await store.get(ref);
    expect(after).toEqual(replaced);
    // Exactly one row for the key — replaced, not stacked.
    const rows = await db.select().from(decks).where(eq(decks.headSha, ref.headSha));
    expect(rows).toHaveLength(1);
  });
});

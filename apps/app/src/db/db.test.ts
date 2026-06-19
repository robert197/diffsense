import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDrizzleReactionStore } from "../adapters/reactionStore.js";
import { createDb } from "./client.js";
import { processedEvents, reactions } from "./schema.js";

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
});

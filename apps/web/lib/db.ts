import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * The hosted card view's own Postgres access (issue #13). `apps/web` cannot
 * import `apps/app`, so it declares the two tables it touches here. These shapes
 * must stay in lockstep with `apps/app/src/db/schema.ts` (the `findings` table
 * #13 added and the existing `reactions` table) — a shared schema package is
 * deferred follow-up work. The view only reads `findings` and appends a refute
 * to `reactions`; it never gates merge.
 */

export interface Claim {
  claim: string;
  evidence: string;
}

/** Read-model: one row per reviewed chunk (mirrors app `findings`). */
export const findings = pgTable("findings", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  fingerprint: text("fingerprint").notNull(),
  file: text("file").notNull(),
  tier: text("tier").notNull(),
  rank: integer("rank").notNull(),
  explanation: text("explanation").notNull(),
  claims: jsonb("claims").$type<Claim[]>().notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  blastRadius: jsonb("blast_radius").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Precision signal: the same append-only table the app's ranked comment feeds. */
export const reactions = pgTable("reactions", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  fingerprint: text("fingerprint").notNull(),
  tier: text("tier").notNull(),
  sentiment: text("sentiment").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const schema = { findings, reactions };

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazy singleton Drizzle client over the shared `DATABASE_URL`. Lazy on purpose:
 * `next build` must not open a connection at import time, and a missing
 * `DATABASE_URL` should fail only when a page actually queries, not at boot.
 */
export function getDb() {
  if (cached) {
    return cached;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to read review findings");
  }
  cached = drizzle(postgres(url, { max: 5 }), { schema });
  return cached;
}

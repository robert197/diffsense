import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
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

/**
 * Read-model: one row per PR + head SHA, holding the ordered `Card[]` the swipe
 * deck renders (issue #26 writes it, issue #27 reads it). Mirrors the `decks`
 * table in `apps/app/src/db/schema.ts` (migration `0007_decks`) — lockstep, no
 * shared schema package yet. `apps/web` only reads it; the `cards` JSON is
 * re-validated against `DeckSchema` on read so a malformed row fails loudly.
 */
export const decks = pgTable(
  "decks",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    cards: jsonb("cards").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Lockstep with apps/app/src/db/schema.ts: the app's migration owns the
    // constraint, but the web declaration mirrors it so the derived shape stays
    // faithful to the authoritative one.
    deckUnique: unique("decks_owner_repo_pr_head_unique").on(
      table.owner,
      table.repo,
      table.prNumber,
      table.headSha,
    ),
    prIdx: index("decks_pr_idx").on(table.owner, table.repo, table.prNumber),
  }),
);

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

/**
 * Reviewer web session (issue #25). Mirrors the `web_sessions` table declared in
 * `apps/app/src/db/schema.ts` (migration `0006_web_sessions`). `apps/web` owns the
 * only reader/writer; the cookie carries an opaque token and this row is keyed by
 * its SHA-256 hash, with the GitHub tokens encrypted at rest.
 */
export const webSessions = pgTable(
  "web_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    githubUserId: integer("github_user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    githubAvatarUrl: text("github_avatar_url"),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  // Mirrors the TTL index in apps/app/src/db/schema.ts (lockstep, no shared pkg yet).
  (table) => ({
    expiresAtIdx: index("web_sessions_expires_at_idx").on(table.expiresAt),
  }),
);

const schema = { findings, decks, reactions, webSessions };

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

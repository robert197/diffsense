import { sql } from "drizzle-orm";
import {
  check,
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

/**
 * Read/write cache for localized card prose (issue #28). Mirrors the
 * `card_localizations` table declared in `apps/app/src/db/schema.ts` (migration
 * `0008_card_localizations`) — lockstep, no shared schema package yet. `apps/web`
 * is the only reader/writer: the deck read path translates a card's prose via the
 * `LLMProvider` port on a miss and upserts it here so a re-open reuses it. The
 * `localized` JSON is re-validated against `LocalizedCardSchema` on read.
 */
export const cardLocalizations = pgTable(
  "card_localizations",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    fingerprint: text("fingerprint").notNull(),
    language: text("language").notNull(),
    localized: jsonb("localized").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cardLangUnique: unique("card_localizations_owner_repo_fp_lang_unique").on(
      table.owner,
      table.repo,
      table.fingerprint,
      table.language,
    ),
    cardIdx: index("card_localizations_card_idx").on(table.owner, table.repo, table.fingerprint),
  }),
);

/**
 * Per-reviewer review progress (issue #29). Mirrors the `review_progress` table
 * declared in `apps/app/src/db/schema.ts` (migration `0009_review_progress`) —
 * lockstep, no shared schema package yet. `apps/web` is the only reader/writer: the
 * swipe action upserts a decision on every swipe, the deck page reads the reviewer's
 * decided cards back to resume at the next unreviewed one, and the dashboard lists
 * in-progress reviews. Keyed by `github_user_id` (stable identity) + `head_sha` so
 * state is per-reviewer, portable across devices, and tied to the reviewed commit.
 */
export const reviewProgress = pgTable(
  "review_progress",
  {
    id: serial("id").primaryKey(),
    githubUserId: integer("github_user_id").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    fingerprint: text("fingerprint").notNull(),
    decision: text("decision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionUnique: unique("review_progress_user_pr_head_fp_unique").on(
      table.githubUserId,
      table.owner,
      table.repo,
      table.prNumber,
      table.headSha,
      table.fingerprint,
    ),
    userIdx: index("review_progress_user_idx").on(table.githubUserId),
    // Enforce the swipe-sentiment domain at the DB (mirrors apps/app schema).
    decisionCheck: check(
      "review_progress_decision_check",
      sql`${table.decision} in ('up', 'down')`,
    ),
  }),
);

/**
 * PR comments a reviewer posts from a deck card (issue #30). Mirrors the
 * `pr_comments` table declared in `apps/app/src/db/schema.ts` (migration
 * `0010_pr_comments`) — lockstep, no shared schema package yet. `apps/web` is the
 * only reader/writer: the comment action records the posted comment on success, and
 * the deck page reads a reviewer's comments back to reflect them on the card. Keyed
 * per reviewer (`github_user_id`) + deck (PR + head SHA), with the GitHub comment id
 * unique so an at-least-once retry is idempotent.
 */
export const prComments = pgTable(
  "pr_comments",
  {
    id: serial("id").primaryKey(),
    githubUserId: integer("github_user_id").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    fingerprint: text("fingerprint").notNull(),
    body: text("body").notNull(),
    githubCommentId: integer("github_comment_id").notNull(),
    htmlUrl: text("html_url").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commentUnique: unique("pr_comments_github_comment_id_unique").on(table.githubCommentId),
    reviewerIdx: index("pr_comments_reviewer_idx").on(
      table.githubUserId,
      table.owner,
      table.repo,
      table.prNumber,
      table.headSha,
    ),
    kindCheck: check("pr_comments_kind_check", sql`${table.kind} in ('review', 'issue')`),
  }),
);

/**
 * Per-PR lifecycle status (issue #31). Mirrors the `pr_status` table declared in
 * `apps/app/src/db/schema.ts` (migration `0011_pr_status`) — lockstep, no shared
 * schema package yet. `apps/web` only reads it: the dashboard joins each reviewer's
 * `review_progress` groups against it to move merged/closed PRs out of the active
 * list into a badged "Done" view. Background sync (`apps/app`) is the only writer.
 */
export const prStatus = pgTable(
  "pr_status",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    status: text("status").notNull(),
    installationId: integer("installation_id").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    prUnique: unique("pr_status_owner_repo_pr_unique").on(table.owner, table.repo, table.prNumber),
    pollIdx: index("pr_status_poll_idx").on(table.status, table.syncedAt),
    statusCheck: check(
      "pr_status_status_check",
      sql`${table.status} in ('open', 'merged', 'closed')`,
    ),
  }),
);

const schema = {
  findings,
  decks,
  reactions,
  webSessions,
  cardLocalizations,
  reviewProgress,
  prComments,
  prStatus,
};

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

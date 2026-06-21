import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Minimal baseline table — exists to prove the Postgres connection + Drizzle
 * migration round-trip (issue #1, R6). Real domain tables (findings,
 * fingerprints, cost records) arrive with their owning slices.
 */
export const processedEvents = pgTable("processed_events", {
  id: serial("id").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Reviewer reactions on flagged chunks (issue #3) — the precision signal. Each
 * row records a 👍/👎 against the chunk's tier at the time of the click, so
 * risk-flag precision can be measured per tier (STRATEGY.md) with no separate
 * instrumentation. `ReactionStore` (in `core`) is the port; this is the table
 * its Drizzle adapter writes to.
 */
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
 * Per-repo learned conventions (issue #7) — the agent's accumulated `context.md`
 * (docs/ARCHITECTURE.md §5). One last-write-wins notes row per repo, read by the
 * review unit's `read_conventions` tool. `ConventionStore` (in `core`) is the
 * port; this is the table its Drizzle adapter upserts into.
 */
export const conventions = pgTable(
  "conventions",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    notes: text("notes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    repoUnique: unique("conventions_owner_repo_unique").on(table.owner, table.repo),
  }),
);

/**
 * Per-chunk review cache keyed by a structural fingerprint (issue #8,
 * docs/ARCHITECTURE.md §5). A recurring chunk reuses its stored `ChunkReview`
 * instead of issuing a fresh LLM call — inference follows attention, not PR size.
 * `FingerprintCache` (in `core`) is the port; this is the table its Drizzle
 * adapter upserts into. One review row per `(owner, repo, fingerprint)`.
 */
export const fingerprints = pgTable(
  "fingerprints",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** The cached `ChunkReview`, stored as JSON and re-validated on read. */
    review: jsonb("review").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chunkUnique: unique("fingerprints_owner_repo_fingerprint_unique").on(
      table.owner,
      table.repo,
      table.fingerprint,
    ),
  }),
);

/**
 * Per-chunk review findings (issue #13, docs/ARCHITECTURE.md §6) — the read-model
 * the hosted card view renders. One row per reviewed chunk: its identity, its
 * within-PR risk order, the review content (explanation/claims/reasons), and the
 * chunk's blast radius. One run's findings at a time per PR: a re-review replaces
 * the PR's rows (`FindingStore.replaceForPr`, transactional delete + insert), so
 * the card view never shows stacked duplicates of recurring chunks. `listByPr`
 * orders by `rank asc`. `FindingStore` (in `core`) is the port; this is the table
 * its Drizzle adapter writes, and the one `apps/web` reads back.
 */
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
  /** Falsifiable claims, stored as JSON and re-validated on read. */
  claims: jsonb("claims").notNull(),
  /** Named risk reasons, stored as JSON. */
  reasons: jsonb("reasons").notNull(),
  /** Blast-radius call sites, stored as JSON. */
  blastRadius: jsonb("blast_radius").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Reviewer web sessions (issue #25) — the entry path's persisted session. The
 * hosted web app authenticates a reviewer via the GitHub App's user-OAuth flow
 * and stores the session here, in the shared Postgres (self-host: no managed KV).
 * The session cookie carries an opaque token; this table is keyed by that token's
 * SHA-256 hash (`token_hash`) so the raw credential is never stored. The GitHub
 * access / refresh tokens are encrypted at rest (AES-256-GCM) — never plaintext.
 * `apps/web` owns the only reader/writer; the table lives here because `apps/app`
 * is the canonical schema + migration home (a shared schema package is deferred).
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
  // Index the TTL column so a periodic expired-session sweep
  // (DELETE ... WHERE expires_at <= now()) stays an index scan, not a full scan.
  (table) => ({
    expiresAtIdx: index("web_sessions_expires_at_idx").on(table.expiresAt),
  }),
);

/**
 * Built decks of review cards (issue #26, docs/ARCHITECTURE.md §2–§3) — the swipe
 * UI's read-model. One row per PR + head SHA: the deterministic ranking folded
 * with the agentic review findings into an ordered set of cards (risk score,
 * highlighted line ranges, suggestions, plain-language explanation). Keyed by head
 * SHA so a new push gets a fresh deck and never overwrites the one a reviewer is
 * mid-swipe through; re-running the engine on the same head upserts in place.
 * `DeckStore` (in `core`) is the port; this is the table its Drizzle adapter
 * writes and reads. The `cards` JSON is re-validated against `DeckSchema` on read.
 */
export const decks = pgTable(
  "decks",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    /** The ordered `Card[]`, stored as JSON and re-validated on read. */
    cards: jsonb("cards").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deckUnique: unique("decks_owner_repo_pr_head_unique").on(
      table.owner,
      table.repo,
      table.prNumber,
      table.headSha,
    ),
    // Listing a PR's decks across head SHAs stays an index scan.
    prIdx: index("decks_pr_idx").on(table.owner, table.repo, table.prNumber),
  }),
);

/**
 * Per-card localized prose cache (issue #28, docs/ARCHITECTURE.md §5). The swipe
 * deck's plain-language `explanation` + "what could be wrong" `suggestions` are
 * authored in English; when a reviewer picks another spoken language each card's
 * prose is translated once via the `LLMProvider` port and cached here, so
 * re-opening the deck reuses the translation instead of re-spending inference.
 * Keyed like the review `fingerprints` cache — `(owner, repo, fingerprint)` — plus
 * the target `language`, so a recurring chunk is translated once per language.
 * `LocalizationStore` (in `core`) is the port; the canonical schema + migration
 * live here, while `apps/web` (the read path) is the only reader/writer via its
 * `lib/db.ts` mirror — the same split `web_sessions` uses. The `localized` JSON is
 * re-validated against `LocalizedCardSchema` on read.
 */
export const cardLocalizations = pgTable(
  "card_localizations",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    fingerprint: text("fingerprint").notNull(),
    language: text("language").notNull(),
    /** The translated `LocalizedCard` (explanation + suggestions), as JSON. */
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
 * Per-reviewer review progress (issue #29) — the resume state behind pause & resume.
 * One row per (reviewer, PR, head SHA, card): the reviewer's 👍/👎 decision on that
 * card, upserted on every swipe. Position is *derived* from these rows (the next
 * unreviewed card is the first card with no decision), so a reload, logout, or device
 * switch picks up exactly where the reviewer left off. Keyed by `github_user_id` (the
 * stable identity, not the renameable login) so state is per-reviewer and portable
 * across devices, and by `head_sha` (reusing the deck's key) so a new push reviews new
 * code from scratch rather than silently resuming against stale lines. Canonical schema
 * + migration live here; `apps/web` (the only reader/writer, via its `lib/db.ts` mirror)
 * records decisions on swipe and reads them back to resume and to list in-progress
 * reviews — the same `apps/app`/`apps/web` split `decks` and `card_localizations` use.
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
    /** The per-card decision: "up" = looks good, "down" = flagged (swipe sentiment). */
    decision: text("decision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One decision per card per reviewer per head — the upsert target. Its prefix
    // (user, owner, repo, pr, head) also serves the deck-page resume read.
    decisionUnique: unique("review_progress_user_pr_head_fp_unique").on(
      table.githubUserId,
      table.owner,
      table.repo,
      table.prNumber,
      table.headSha,
      table.fingerprint,
    ),
    // Listing one reviewer's in-progress reviews for the dashboard stays an index scan.
    userIdx: index("review_progress_user_idx").on(table.githubUserId),
    // The decision domain is the swipe sentiment; enforce it at the DB so a direct
    // insert or a future caller bypassing the action's validation can't store a value
    // the read path would silently coerce to "up".
    decisionCheck: check(
      "review_progress_decision_check",
      sql`${table.decision} in ('up', 'down')`,
    ),
  }),
);

/**
 * Per-PR inference cost (issue #12, docs/ARCHITECTURE.md §2) — product
 * observability. One append-only row per review run records the summed token
 * usage, the USD cost (token usage × per-model rate), and whether the run crossed
 * the configured cost threshold, so cost-per-PR stays observable across the
 * PR-size distribution and across re-reviews. `CostStore` (in `core`) is the
 * port; this is the table its Drizzle adapter inserts into.
 */
export const costs = pgTable("costs", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  /** USD cost stored as exact numeric — never a lossy float for money. */
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
  overThreshold: boolean("over_threshold").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

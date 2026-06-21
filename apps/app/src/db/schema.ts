import {
  boolean,
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

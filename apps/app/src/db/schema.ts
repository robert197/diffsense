import {
  boolean,
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
 * chunk's blast radius. Append-only — a re-review adds rows and `listByPr` orders
 * by `rank asc, id desc` so the newest run's findings win. `FindingStore` (in
 * `core`) is the port; this is the table its Drizzle adapter writes, and the one
 * `apps/web` reads back.
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

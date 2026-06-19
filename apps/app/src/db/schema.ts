import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

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

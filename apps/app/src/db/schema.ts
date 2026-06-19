import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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

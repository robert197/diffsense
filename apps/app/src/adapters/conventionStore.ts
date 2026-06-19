import type { ConventionStore, RepoRef } from "@diffsense/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { conventions } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `ConventionStore` port (docs/ARCHITECTURE.md
 * §1, §5). `core` owns the port and the `RepoRef` shape; this is the only place
 * that knows it is Postgres. One last-write-wins notes row per repo.
 */
export function createDrizzleConventionStore(db: Database): ConventionStore {
  return {
    async readConventions({ owner, repo }: RepoRef): Promise<string | null> {
      const rows = await db
        .select({ notes: conventions.notes })
        .from(conventions)
        .where(and(eq(conventions.owner, owner), eq(conventions.repo, repo)))
        .limit(1);
      return rows[0]?.notes ?? null;
    },
    async writeConventions({ owner, repo }: RepoRef, notes: string): Promise<void> {
      await db
        .insert(conventions)
        .values({ owner, repo, notes })
        .onConflictDoUpdate({
          target: [conventions.owner, conventions.repo],
          set: { notes, updatedAt: new Date() },
        });
    },
  };
}

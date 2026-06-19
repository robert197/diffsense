import {
  type ChunkReview,
  ChunkReviewSchema,
  type FingerprintCache,
  type RepoRef,
} from "@diffsense/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { fingerprints } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `FingerprintCache` port (docs/ARCHITECTURE.md
 * §1, §5). `core` owns the port and the `ChunkReview` shape; this is the only
 * place that knows it is Postgres. The stored JSON is re-validated against
 * `ChunkReviewSchema` on read, so a malformed or stale row is treated as a miss
 * rather than poisoning a review. One row per `(owner, repo, fingerprint)`.
 */
export function createDrizzleFingerprintCache(db: Database): FingerprintCache {
  return {
    async get({ owner, repo }: RepoRef, fingerprint: string): Promise<ChunkReview | null> {
      const rows = await db
        .select({ review: fingerprints.review })
        .from(fingerprints)
        .where(
          and(
            eq(fingerprints.owner, owner),
            eq(fingerprints.repo, repo),
            eq(fingerprints.fingerprint, fingerprint),
          ),
        )
        .limit(1);

      const stored = rows[0]?.review;
      if (stored === undefined) {
        return null;
      }
      const parsed = ChunkReviewSchema.safeParse(stored);
      return parsed.success ? parsed.data : null;
    },

    async set({ owner, repo }: RepoRef, fingerprint: string, review: ChunkReview): Promise<void> {
      await db
        .insert(fingerprints)
        .values({ owner, repo, fingerprint, review })
        .onConflictDoUpdate({
          target: [fingerprints.owner, fingerprints.repo, fingerprints.fingerprint],
          set: { review, updatedAt: new Date() },
        });
    },
  };
}

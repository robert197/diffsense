import type {
  GitHubPrRef,
  PrStatusPollRow,
  PrStatusRecord,
  PrStatusSeed,
  PrStatusStore,
} from "@diffsense/core";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { prStatus } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `PrStatusStore` port (issue #31,
 * docs/ARCHITECTURE.md §1). `core` owns the port; this is the only place that knows
 * it is Postgres. One row per PR, keyed `UNIQUE(owner, repo, pr_number)`.
 *
 * - `recordStatus` upserts the authoritative label (the webhook update job and the
 *   poll when a PR's status actually changed).
 * - `seedOpen` tracks a freshly reviewed PR as open, but its conflict clause refreshes
 *   only while the row is still `open` — a late `synchronize` must never resurrect a
 *   PR we've already recorded as merged/closed.
 * - `markSynced` bumps `synced_at` when the poll found no change, so the bounded poll
 *   rotates through open PRs instead of re-checking the same few.
 * - `listOpenForPoll` returns up to `limit` still-open PRs, oldest-synced first.
 */
export function createDrizzlePrStatusStore(db: Database): PrStatusStore {
  return {
    async recordStatus(record: PrStatusRecord): Promise<void> {
      await db
        .insert(prStatus)
        .values({
          owner: record.owner,
          repo: record.repo,
          prNumber: record.prNumber,
          status: record.status,
          installationId: record.installationId,
        })
        .onConflictDoUpdate({
          target: [prStatus.owner, prStatus.repo, prStatus.prNumber],
          set: {
            status: record.status,
            installationId: record.installationId,
            updatedAt: sql`now()`,
            syncedAt: sql`now()`,
          },
        });
    },

    async seedOpen(ref: PrStatusSeed): Promise<void> {
      await db
        .insert(prStatus)
        .values({
          owner: ref.owner,
          repo: ref.repo,
          prNumber: ref.prNumber,
          status: "open",
          installationId: ref.installationId,
        })
        .onConflictDoUpdate({
          target: [prStatus.owner, prStatus.repo, prStatus.prNumber],
          // Refresh the installation + last-seen, but only while still open — never
          // clobber a terminal merged/closed status with a late open-PR event.
          set: { installationId: ref.installationId, syncedAt: sql`now()` },
          setWhere: eq(prStatus.status, "open"),
        });
    },

    async markSynced(refs: GitHubPrRef[]): Promise<void> {
      if (refs.length === 0) {
        return;
      }
      await db
        .update(prStatus)
        .set({ syncedAt: sql`now()` })
        .where(
          or(
            ...refs.map((ref) =>
              and(
                eq(prStatus.owner, ref.owner),
                eq(prStatus.repo, ref.repo),
                eq(prStatus.prNumber, ref.prNumber),
              ),
            ),
          ),
        );
    },

    async listOpenForPoll(limit: number): Promise<PrStatusPollRow[]> {
      const rows = await db
        .select({
          owner: prStatus.owner,
          repo: prStatus.repo,
          prNumber: prStatus.prNumber,
          installationId: prStatus.installationId,
          status: prStatus.status,
        })
        .from(prStatus)
        .where(eq(prStatus.status, "open"))
        // `id` breaks `synced_at` ties (rows seeded in one statement share `now()`),
        // so the batch boundary is deterministic and the oldest-synced scan can't
        // perpetually re-pick the same row just past the limit while skipping its peer.
        .orderBy(asc(prStatus.syncedAt), asc(prStatus.id))
        .limit(limit);

      // `status` is constrained to the lifecycle domain at the DB; narrow the text
      // column to the port's union for the caller.
      return rows.map((row) => ({ ...row, status: "open" as const }));
    },
  };
}

import {
  type GitHubPrRef,
  type PrLifecycle,
  type PrStatusReader,
  type PrStatusStore,
  derivePrStatus,
  reconcilePrStatus,
} from "@diffsense/core";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createGitHubApp } from "../adapters/githubApp.js";
import {
  type PrStatusReaderClient,
  createGitHubPrStatusReader,
} from "../adapters/prStatusReader.js";
import { createDrizzlePrStatusStore } from "../adapters/prStatusStore.js";
import type { Config } from "../config.js";
import { createDb } from "../db/client.js";
import {
  PR_STATUS_POLL_JOB,
  PR_STATUS_QUEUE_NAME,
  PR_STATUS_UPDATE_JOB,
  type PrStatusUpdateJob,
} from "../types.js";

/**
 * Background PR merge-status sync (issue #31). Consumes the `pr-status` queue and
 * keeps `pr_status` current from both sources:
 *
 * - `pr-status-update` — a `closed`/`reopened` webhook: derive the label and upsert.
 * - `pr-status-poll` — the repeatable fallback: walk the oldest-synced open PRs,
 *   ask GitHub their live state, and reconcile. This is what makes status correct
 *   after the app was offline during a merge (R4). Bounded batch + grouped tokens +
 *   the App's throttling plugin keep it within GitHub's rate budget (R5).
 *
 * The two handlers are exported as pure-port functions so they unit-test with fakes
 * — no Redis, no BullMQ, no Octokit.
 */

/** Apply one webhook-sourced status write. */
export async function handleStatusUpdate(
  job: PrStatusUpdateJob,
  store: PrStatusStore,
): Promise<void> {
  await store.recordStatus({
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    installationId: job.installationId,
    status: derivePrStatus({ state: job.state, merged: job.merged }),
  });
}

export interface PollDeps {
  store: PrStatusStore;
  /** Build a reader for one installation (the poll groups rows by installation). */
  readerFor: (installationId: number) => Promise<PrStatusReader>;
  batch: number;
}

/**
 * Reconcile one bounded batch of still-open PRs against their live GitHub state.
 * PRs whose status is unchanged, that 404, or whose live read fails get their
 * `synced_at` bumped so the poll rotates forward; PRs that merged/closed/reopened
 * get a full status write. Per-PR and per-installation errors are logged and skipped,
 * never fatal.
 *
 * Liveness invariant: every row whose GitHub read did not yield a pending status
 * write advances `synced_at`. The batch is the oldest-synced PRs (`listOpenForPoll`
 * orders `synced_at ASC`), so a row that failed to read and did NOT advance would
 * re-anchor the batch head every tick — a cluster of persistently-failing reads
 * (a suspended installation, deleted-but-still-open rows, sustained rate limiting)
 * would then starve every healthy open PR and defeat the offline-merge fallback
 * (R4) while wasting GitHub budget (R5). So a failed read rotates to the back
 * instead; the row stays `open` and is re-read on the next full rotation. The one
 * row we deliberately leave un-synced is a genuine change whose `recordStatus`
 * write failed — that has pending work, so the next tick should retry it promptly.
 */
export async function runStatusPoll({
  store,
  readerFor,
  batch,
}: PollDeps): Promise<{ checked: number; changed: number }> {
  const rows = await store.listOpenForPoll(batch);
  if (rows.length === 0) {
    return { checked: 0, changed: 0 };
  }

  // Group by installation so we mint one installation token per installation per
  // tick rather than one per PR (R5).
  const byInstallation = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byInstallation.get(row.installationId);
    if (list) {
      list.push(row);
    } else {
      byInstallation.set(row.installationId, [row]);
    }
  }

  // Rows to advance `synced_at` for (read OK + no change, 404, or read failed).
  const toSync: GitHubPrRef[] = [];
  let checked = 0;
  let changed = 0;

  for (const [installationId, group] of byInstallation) {
    let reader: PrStatusReader;
    try {
      reader = await readerFor(installationId);
    } catch (err) {
      console.error(`[pr-status] could not build reader for installation ${installationId}:`, err);
      // The whole installation is unreadable this tick (e.g. suspended/uninstalled).
      // Rotate its rows to the back so they don't pin the batch head forever (R4/R5).
      for (const row of group) {
        toSync.push({ owner: row.owner, repo: row.repo, prNumber: row.prNumber });
      }
      continue;
    }
    for (const row of group) {
      const ref: GitHubPrRef = { owner: row.owner, repo: row.repo, prNumber: row.prNumber };
      checked++;
      let live: PrLifecycle | null;
      try {
        live = await reader.getPullRequestState(ref);
      } catch (err) {
        // A read failure (transient GitHub error, or the throttler giving up after its
        // bounded retries) still advances `synced_at` so the row rotates to the back of
        // the oldest-synced batch rather than re-anchoring the head every tick. It stays
        // `open`, so it is re-read on the next full rotation.
        console.error(
          `[pr-status] poll read failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`,
          err,
        );
        toSync.push(ref);
        continue;
      }
      if (live === null) {
        // PR no longer exists — bump synced_at so we don't re-check it immediately.
        toSync.push(ref);
        continue;
      }
      const result = reconcilePrStatus(row.status, live);
      if (!result.changed) {
        toSync.push(ref);
        continue;
      }
      try {
        await store.recordStatus({ ...ref, installationId, status: result.status });
        changed++;
      } catch (err) {
        // The PR genuinely changed but persisting it failed — leave `synced_at`
        // untouched so the next tick retries the write promptly rather than waiting a
        // full rotation. A row-specific write failure is rare and self-limiting (a
        // batch-wide DB outage fails `listOpenForPoll` and the whole tick instead).
        console.error(
          `[pr-status] poll write failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`,
          err,
        );
      }
    }
  }

  await store.markSynced(toSync);
  return { checked, changed };
}

/**
 * BullMQ consumer for the status queue — the status worker's composition root.
 * Wires the rate-limit-aware App, the DB-backed store, and a per-installation
 * reader, then dispatches each job by name to the handlers above.
 */
export function startStatusWorker(config: Config): Worker {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("status worker redis error:", err));
  const app = createGitHubApp(config);
  const { db } = createDb(config.databaseUrl);
  const store = createDrizzlePrStatusStore(db);

  const readerFor = async (installationId: number): Promise<PrStatusReader> => {
    const octokit = (await app.getInstallationOctokit(
      installationId,
    )) as unknown as PrStatusReaderClient;
    return createGitHubPrStatusReader(octokit);
  };

  const worker = new Worker(
    PR_STATUS_QUEUE_NAME,
    async (job) => {
      if (job.name === PR_STATUS_UPDATE_JOB) {
        await handleStatusUpdate(job.data as PrStatusUpdateJob, store);
        return;
      }
      if (job.name === PR_STATUS_POLL_JOB) {
        const result = await runStatusPoll({ store, readerFor, batch: config.prStatusPollBatch });
        if (result.checked > 0) {
          console.log(`[pr-status] poll checked ${result.checked}, updated ${result.changed}`);
        }
        return;
      }
      // A job name this consumer doesn't recognize (a stale repeatable from a prior
      // deploy, or a typo in the job constants) would otherwise be silently acked.
      console.warn(`[pr-status] ignoring unknown job name: ${job.name}`);
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`status job ${job?.id} failed:`, err);
  });
  worker.on("error", (err) => {
    console.error("status worker error:", err);
  });

  return worker;
}

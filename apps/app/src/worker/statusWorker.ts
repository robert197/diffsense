import {
  type GitHubPrRef,
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
 * PRs whose status is unchanged (or that 404) get their `synced_at` bumped so the
 * poll rotates forward; PRs that merged/closed/reopened get a full status write.
 * Per-PR and per-installation errors are logged and skipped, never fatal.
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

  const unchanged: GitHubPrRef[] = [];
  let checked = 0;
  let changed = 0;

  for (const [installationId, group] of byInstallation) {
    let reader: PrStatusReader;
    try {
      reader = await readerFor(installationId);
    } catch (err) {
      console.error(`[pr-status] could not build reader for installation ${installationId}:`, err);
      continue;
    }
    for (const row of group) {
      const ref: GitHubPrRef = { owner: row.owner, repo: row.repo, prNumber: row.prNumber };
      checked++;
      try {
        const live = await reader.getPullRequestState(ref);
        if (live === null) {
          // PR no longer exists — bump synced_at so we don't re-check it immediately.
          unchanged.push(ref);
          continue;
        }
        const result = reconcilePrStatus(row.status, live);
        if (result.changed) {
          await store.recordStatus({ ...ref, installationId, status: result.status });
          changed++;
        } else {
          unchanged.push(ref);
        }
      } catch (err) {
        // Leave it for the next tick (don't bump synced_at) so a transient failure
        // is retried sooner rather than waiting a full rotation.
        console.error(`[pr-status] poll failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`, err);
      }
    }
  }

  await store.markSynced(unchanged);
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
      }
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

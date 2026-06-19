import { App } from "@octokit/app";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { GitHubClient } from "../adapters/github.js";
import type { Config } from "../config.js";
import { type PrRef, REVIEW_QUEUE_NAME } from "../types.js";
import { handlePullRequestEvent } from "./handlePullRequestEvent.js";

/**
 * BullMQ consumer — the composition root. Deserializes a `PrRef`, builds an
 * installation-scoped Octokit (KTD3/KTD4), and calls the seam. Thin on purpose:
 * all behavior lives in `handlePullRequestEvent`.
 */
export function startWorker(config: Config): Worker<PrRef> {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("worker redis error:", err));
  const app = new App({ appId: config.githubAppId, privateKey: config.githubPrivateKey });

  const worker = new Worker<PrRef>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      const ref = job.data;
      const octokit = (await app.getInstallationOctokit(
        ref.installationId,
      )) as unknown as GitHubClient;
      // PrRef is a superset of PullRequestEvent — pass it directly.
      await handlePullRequestEvent(ref, octokit, { reactionBaseUrl: config.publicBaseUrl });
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`review job ${job?.id} failed:`, err);
  });
  // BullMQ Worker is an EventEmitter — an unhandled "error" event crashes the
  // process on transient Redis failures. ioredis auto-reconnects; just log.
  worker.on("error", (err) => {
    console.error("worker error:", err);
  });

  return worker;
}

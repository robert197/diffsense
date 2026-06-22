import type { PrStatusStore } from "@diffsense/core";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDrizzleDeckStore } from "../adapters/deckStore.js";
import type { GitHubClient } from "../adapters/github.js";
import { createGitHubApp } from "../adapters/githubApp.js";
import { createDrizzlePrStatusStore } from "../adapters/prStatusStore.js";
import type { Config } from "../config.js";
import { createDb } from "../db/client.js";
import { type PrRef, REVIEW_QUEUE_NAME } from "../types.js";
import { buildReviewSupport, runReviewForRef } from "./reviewRunner.js";

/**
 * BullMQ consumer — the composition root. Deserializes a `PrRef`, builds an
 * installation-scoped Octokit (KTD3/KTD4), and calls the shared review runner.
 * The deterministic ranked comment always ships. When an LLM is configured, the
 * runner also runs the agentic review pass and persists per-chunk findings for
 * the hosted card view (#13); with no LLM key it stays exactly as before — rank
 * + deck + comment only. The runner (`reviewRunner.ts`) is shared verbatim with
 * the agent-facing CLI (`diffsense review`, #32), so both run one pipeline.
 */
export function startWorker(config: Config): Worker<PrRef> {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("worker redis error:", err));
  // Rate-limit-aware App (issue #31, R5): the installation Octokit it mints carries
  // the throttling + retry plugins, so both the review diff fetch and the status
  // poll respect GitHub's budget.
  const app = createGitHubApp(config);

  // One DB pool for every store-backed port. The deck store is wired on *every*
  // run — the deck is deterministic, so it does not depend on an LLM — while the
  // agentic review pass is wired only when an LLM key is present.
  const { db } = createDb(config.databaseUrl);
  const deckStore = createDrizzleDeckStore(db);
  const prStatusStore = createDrizzlePrStatusStore(db);
  const reviewSupport = buildReviewSupport(db);

  const worker = new Worker<PrRef>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      const ref = job.data;
      const octokit = (await app.getInstallationOctokit(
        ref.installationId,
      )) as unknown as GitHubClient;
      await runReviewForRef(octokit, ref, {
        deckStore,
        reviewSupport,
        reactionBaseUrl: config.publicBaseUrl,
        cardViewBaseUrl: config.webBaseUrl,
      });
      // Track this PR as open so background sync can later reconcile it (issue #31).
      // Best-effort and additive — a seed failure must never sink the ranked comment.
      await seedPrStatus(prStatusStore, ref);
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

/**
 * Track a freshly reviewed PR as `open` so the background poll has a row (with an
 * installation id) to reconcile later (issue #31). Best-effort: a failure logs and
 * returns rather than throwing, so it never sinks the guaranteed ranked comment.
 * `seedOpen` never clobbers a terminal merged/closed status, so a late `synchronize`
 * can't resurrect a PR that already left the active list.
 */
async function seedPrStatus(store: PrStatusStore, ref: PrRef): Promise<void> {
  try {
    await store.seedOpen({
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      installationId: ref.installationId,
    });
  } catch (err) {
    console.error(`could not seed pr_status for ${ref.owner}/${ref.repo}#${ref.prNumber}:`, err);
  }
}

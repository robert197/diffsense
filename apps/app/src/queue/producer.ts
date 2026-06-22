import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  PR_STATUS_POLL_JOB,
  PR_STATUS_QUEUE_NAME,
  PR_STATUS_UPDATE_JOB,
  type PrRef,
  type PrStatusUpdateJob,
  REVIEW_JOB_NAME,
  REVIEW_QUEUE_NAME,
} from "../types.js";

export interface Producer {
  enqueue: (ref: PrRef) => Promise<void>;
  close: () => Promise<void>;
}

export interface StatusProducer {
  /** Enqueue a status write from a closed/reopened webhook (issue #31). */
  enqueueStatus: (job: PrStatusUpdateJob) => Promise<void>;
  /**
   * Register (idempotently) the repeatable poll that reconciles still-open PRs.
   * A stable job id means a restart re-upserts the same schedule rather than
   * stacking duplicate repeatables.
   */
  scheduleStatusPoll: (opts: { everyMs: number }) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * BullMQ producer backed by Redis. The webhook delivery id is used as the job
 * id so duplicate deliveries collapse to one job; the worker still upserts the
 * comment idempotently.
 */
export function createProducer(redisUrl: string): Producer {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("producer redis error:", err));
  const queue = new Queue<PrRef>(REVIEW_QUEUE_NAME, { connection });

  return {
    enqueue: async (ref) => {
      await queue.add(REVIEW_JOB_NAME, ref, {
        jobId: ref.deliveryId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500, age: 86_400 },
        removeOnFail: 100,
      });
    },
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
}

/**
 * BullMQ producer for the background PR merge-status queue (issue #31). The webhook
 * path enqueues a status-update job (delivery id as job id, so duplicate deliveries
 * collapse); the worker role schedules the repeatable poll at startup.
 */
export function createStatusProducer(redisUrl: string): StatusProducer {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("status producer redis error:", err));
  // Two job shapes share this queue (update payload + empty poll tick) — leave the
  // data generic unconstrained; each `add` below is typed at the call site.
  const queue = new Queue(PR_STATUS_QUEUE_NAME, { connection });

  return {
    enqueueStatus: async (job) => {
      await queue.add(PR_STATUS_UPDATE_JOB, job, {
        jobId: job.deliveryId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500, age: 86_400 },
        removeOnFail: 100,
      });
    },
    scheduleStatusPoll: async ({ everyMs }) => {
      await queue.add(
        PR_STATUS_POLL_JOB,
        {},
        {
          repeat: { every: everyMs },
          // Stable id → the repeatable is upserted, never duplicated across restarts.
          jobId: PR_STATUS_POLL_JOB,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    },
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
}

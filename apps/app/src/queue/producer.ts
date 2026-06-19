import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { type PrRef, REVIEW_JOB_NAME, REVIEW_QUEUE_NAME } from "../types.js";

export interface Producer {
  enqueue: (ref: PrRef) => Promise<void>;
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

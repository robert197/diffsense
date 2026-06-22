import { serve } from "@hono/node-server";
import { createDrizzleDeckStore } from "./adapters/deckStore.js";
import { createDrizzleReactionStore } from "./adapters/reactionStore.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createServer } from "./ingress/server.js";
import { createProducer, createStatusProducer } from "./queue/producer.js";
import { startWorker } from "./worker/index.js";
import { startStatusWorker } from "./worker/statusWorker.js";

/**
 * Role dispatch — one image, three roles selected by argv/ROLE (KTD7).
 * `serve` runs the Hono ingress; `worker` runs the BullMQ consumer.
 * (`web` is served by apps/web's own container.)
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  process.exit(1);
});

function onShutdown(close: () => Promise<void>): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      console.log(`received ${sig}, draining...`);
      try {
        await close();
      } finally {
        process.exit(0);
      }
    });
  }
}

const role = process.argv[2] ?? process.env.ROLE ?? "serve";
const config = loadConfig();

if (role === "serve") {
  const producer = createProducer(config.redisUrl);
  const statusProducer = createStatusProducer(config.redisUrl);
  const { db, client } = createDb(config.databaseUrl);
  const reactionStore = createDrizzleReactionStore(db);
  const deckStore = createDrizzleDeckStore(db);
  const app = createServer({
    webhookSecret: config.githubWebhookSecret,
    enqueue: producer.enqueue,
    enqueueStatus: statusProducer.enqueueStatus,
    recordReaction: reactionStore.record,
    getDeck: deckStore.get,
    deckApiSecret: config.deckApiSecret,
  });
  serve({ fetch: app.fetch, port: config.port });
  console.log(`diffsense serve listening on :${config.port}`);
  onShutdown(async () => {
    await producer.close();
    await statusProducer.close();
    await client.end();
  });
} else if (role === "worker") {
  const worker = startWorker(config);
  // Background PR merge-status sync (issue #31) runs inside the worker role: a second
  // consumer for the status queue plus the repeatable poll that reconciles open PRs.
  const statusWorker = startStatusWorker(config);
  const statusProducer = createStatusProducer(config.redisUrl);
  statusProducer
    .scheduleStatusPoll({ everyMs: config.prStatusPollIntervalMs })
    .then(() => console.log(`pr-status poll scheduled every ${config.prStatusPollIntervalMs}ms`))
    .catch((err) => console.error("failed to schedule pr-status poll:", err));
  console.log("diffsense worker started");
  onShutdown(async () => {
    await worker.close();
    await statusWorker.close();
    await statusProducer.close();
  });
} else {
  console.error(`unknown role: ${role} (expected "serve" or "worker")`);
  process.exit(1);
}

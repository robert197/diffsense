import { Webhooks } from "@octokit/webhooks";
import { Hono } from "hono";
import type { PrRef } from "../types.js";

const MAX_BODY_BYTES = 5_000_000;

export interface IngressDeps {
  webhookSecret: string;
  enqueue: (ref: PrRef) => Promise<void>;
}

/** Minimal shape of the `pull_request` webhook payload fields we consume. */
interface PullRequestPayload {
  action?: string;
  number?: number;
  repository?: { name?: string; owner?: { login?: string } };
  installation?: { id?: number };
}

/**
 * Hono ingress. Verifies the webhook HMAC signature (KTD3), narrows to
 * `pull_request` `opened`/`synchronize`, enqueues a serializable `PrRef`
 * (KTD4), and acks 202 fast. Signature failures → 401. The producer is
 * injected so tests run without Redis.
 */
export function createServer({ webhookSecret, enqueue }: IngressDeps): Hono {
  const app = new Hono();
  const webhooks = new Webhooks({ secret: webhookSecret });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const id = c.req.header("x-github-delivery");
    const name = c.req.header("x-github-event");

    // Cap the unauthenticated body read on this public endpoint (DoS guard).
    // GitHub caps webhook payloads at ~25MB; reject well below that.
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    const body = await c.req.text();

    if (!signature || !id || !name) {
      return c.json({ error: "missing webhook headers" }, 400);
    }

    const verified = await webhooks.verify(body, signature).catch(() => false);
    if (!verified) {
      return c.json({ error: "invalid signature" }, 401);
    }

    if (name !== "pull_request") {
      return c.body(null, 204);
    }

    let payload: PullRequestPayload;
    try {
      payload = JSON.parse(body) as PullRequestPayload;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const action = payload.action;
    if (action !== "opened" && action !== "synchronize") {
      return c.body(null, 204);
    }

    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const prNumber = payload.number;
    const installationId = payload.installation?.id;

    if (!owner || !repo || prNumber === undefined || installationId === undefined) {
      return c.json({ error: "incomplete pull_request payload" }, 400);
    }

    try {
      await enqueue({ owner, repo, prNumber, installationId, action, deliveryId: id });
    } catch (err) {
      // Redis/queue unavailable — 503 so GitHub retries the delivery.
      console.error("failed to enqueue review job:", err);
      return c.json({ error: "queue unavailable" }, 503);
    }
    return c.json({ accepted: true }, 202);
  });

  return app;
}

import { type ChunkReaction, ChunkReactionSchema } from "@diffsense/core";
import { Webhooks } from "@octokit/webhooks";
import { Hono } from "hono";
import type { PrRef } from "../types.js";

const MAX_BODY_BYTES = 5_000_000;

export interface IngressDeps {
  webhookSecret: string;
  enqueue: (ref: PrRef) => Promise<void>;
  /**
   * Records a reviewer 👍/👎 on a flagged chunk (issue #3). Optional: when
   * absent, the `/reactions` route is inert (404) so a deployment that has not
   * wired a store does not advertise a broken link.
   */
  recordReaction?: (reaction: ChunkReaction) => Promise<void>;
}

/** Minimal shape of the `pull_request` webhook payload fields we consume. */
interface PullRequestPayload {
  action?: string;
  number?: number;
  repository?: { name?: string; owner?: { login?: string } };
  installation?: { id?: number };
}

/**
 * Read a request body as text, aborting once `maxBytes` is exceeded. Unlike
 * `Request.text()`, this caps the actual bytes pulled from the stream, so a
 * request with no (or a lying) content-length cannot buffer unbounded memory.
 * Throws once the cap is passed.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("payload too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Hono ingress. Verifies the webhook HMAC signature (KTD3), narrows to
 * `pull_request` `opened`/`synchronize`, enqueues a serializable `PrRef`
 * (KTD4), and acks 202 fast. Signature failures → 401. The producer is
 * injected so tests run without Redis.
 */
export function createServer({ webhookSecret, enqueue, recordReaction }: IngressDeps): Hono {
  const app = new Hono();
  const webhooks = new Webhooks({ secret: webhookSecret });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // One-click reviewer feedback (issue #3). The 👍/👎 links in the ranked
  // comment point here. A GET that records is the pragmatic choice for a
  // click-through link in a GitHub comment; the data is advisory, non-auth
  // signal, so this is an acceptable trade for the MVP. Params are validated by
  // the same Zod schema the store expects.
  app.get("/reactions", async (c) => {
    if (!recordReaction) {
      return c.json({ error: "reactions not enabled" }, 404);
    }
    const q = c.req.query();
    const parsed = ChunkReactionSchema.safeParse({
      owner: q.owner,
      repo: q.repo,
      prNumber: Number(q.pr),
      fingerprint: q.fp,
      tier: q.tier,
      sentiment: q.s,
    });
    if (!parsed.success) {
      return c.json({ error: "invalid reaction parameters" }, 400);
    }
    try {
      await recordReaction(parsed.data);
    } catch (err) {
      console.error("failed to record reaction:", err);
      return c.json({ error: "could not record reaction" }, 503);
    }
    return c.text("Thanks, recorded. You can close this tab.");
  });

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const id = c.req.header("x-github-delivery");
    const name = c.req.header("x-github-event");

    // Cap the unauthenticated body read on this public endpoint (DoS guard).
    // GitHub caps webhook payloads at ~25MB; reject well below that. Enforce on
    // the actual bytes read, not just content-length: a request that omits the
    // header or sends chunked would otherwise buffer an unbounded payload.
    let body: string;
    try {
      body = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
    } catch {
      return c.json({ error: "payload too large" }, 413);
    }

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

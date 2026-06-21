import { randomUUID } from "node:crypto";
import { type ChunkReaction, ChunkReactionSchema, type Deck, type DeckRef } from "@diffsense/core";
import { Webhooks } from "@octokit/webhooks";
import { Hono } from "hono";
import { z } from "zod";
import type { PrRef } from "../types.js";

const MAX_BODY_BYTES = 5_000_000;

/** Body of an on-demand deck request (issue #26): which PR to process. */
const DeckRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  installationId: z.number().int().positive(),
});

/** Query of a deck re-fetch (issue #26): the PR + head SHA the deck is keyed to. */
const DeckQuerySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.coerce.number().int().positive(),
  headSha: z.string().min(1),
});

export interface IngressDeps {
  webhookSecret: string;
  enqueue: (ref: PrRef) => Promise<void>;
  /**
   * Records a reviewer 👍/👎 on a flagged chunk (issue #3). Optional: when
   * absent, the `/reactions` route is inert (404) so a deployment that has not
   * wired a store does not advertise a broken link.
   */
  recordReaction?: (reaction: ChunkReaction) => Promise<void>;
  /**
   * Re-fetch a persisted deck of cards (issue #26). Optional: when absent, the
   * `GET /decks` route is inert (404) — a deployment with no DeckStore wired
   * does not advertise a read it cannot serve.
   */
  getDeck?: (ref: DeckRef) => Promise<Deck | null>;
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

/** Validate `/reactions` query params against the store's schema. */
function parseReactionParams(q: Record<string, string>) {
  return ChunkReactionSchema.safeParse({
    owner: q.owner,
    repo: q.repo,
    prNumber: Number(q.pr),
    fingerprint: q.fp,
    tier: q.tier,
    sentiment: q.s,
  });
}

/** Escape a string for safe interpolation into an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal confirm page whose button POSTs the reaction back to this endpoint.
 * The original query string is preserved on the form action so the POST sees
 * the same validated params. This is what keeps automated link prefetchers
 * from recording reactions: they fetch the GET but never submit the form.
 */
function renderConfirmPage(reaction: ChunkReaction): string {
  const params = new URLSearchParams({
    owner: reaction.owner,
    repo: reaction.repo,
    pr: String(reaction.prNumber),
    fp: reaction.fingerprint,
    tier: reaction.tier,
    s: reaction.sentiment,
  });
  const action = `/reactions?${params.toString()}`;
  const label = reaction.sentiment === "up" ? "👍 helpful" : "👎 not helpful";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Confirm reaction</title></head>
<body>
<p>Record this reaction as <strong>${escapeHtml(label)}</strong>?</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit">Confirm</button>
</form>
</body>
</html>`;
}

/**
 * Hono ingress. Verifies the webhook HMAC signature (KTD3), narrows to
 * `pull_request` `opened`/`synchronize`, enqueues a serializable `PrRef`
 * (KTD4), and acks 202 fast. Signature failures → 401. The producer is
 * injected so tests run without Redis.
 */
export function createServer({
  webhookSecret,
  enqueue,
  recordReaction,
  getDeck,
}: IngressDeps): Hono {
  const app = new Hono();
  const webhooks = new Webhooks({ secret: webhookSecret });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // On-demand deck processing (issue #26). A reviewer opening a PR in the web app
  // triggers a review run here, decoupled from the GitHub webhook: it enqueues the
  // same job the webhook does (the worker ranks, reviews, and persists the deck),
  // then acks 202 — the deck is read back via `GET /decks` once the run lands.
  app.post("/decks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = DeckRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid deck request" }, 400);
    }
    const { owner, repo, prNumber, installationId } = parsed.data;
    try {
      await enqueue({
        owner,
        repo,
        prNumber,
        installationId,
        action: "synchronize",
        deliveryId: `ondemand-${randomUUID()}`,
      });
    } catch (err) {
      console.error("failed to enqueue deck job:", err);
      return c.json({ error: "queue unavailable" }, 503);
    }
    return c.json({ accepted: true }, 202);
  });

  // Re-fetch the persisted deck for a PR at a head SHA (issue #26). Keyed by head
  // SHA so the swipe UI resumes the exact deck it was built against.
  app.get("/decks", async (c) => {
    if (!getDeck) {
      return c.json({ error: "decks not enabled" }, 404);
    }
    const parsed = DeckQuerySchema.safeParse({
      owner: c.req.query("owner"),
      repo: c.req.query("repo"),
      prNumber: c.req.query("pr"),
      headSha: c.req.query("sha"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid deck query" }, 400);
    }
    let deck: Deck | null;
    try {
      deck = await getDeck(parsed.data);
    } catch (err) {
      console.error("failed to read deck:", err);
      return c.json({ error: "could not read deck" }, 503);
    }
    if (!deck) {
      return c.json({ error: "deck not found" }, 404);
    }
    return c.json(deck);
  });

  // Reviewer feedback (issue #3). The 👍/👎 links in the ranked comment point
  // here. The write is a POST, not a GET: a GET that writes gets fired
  // automatically by email link scanners (Outlook SafeLinks, Mimecast) and
  // link prefetchers, which would poison the precision signal with reactions
  // no human ever made. So the GET only renders a one-click confirm page and
  // the button on it POSTs the reaction. Params are validated by the same Zod
  // schema the store expects on both routes.
  app.get("/reactions", (c) => {
    if (!recordReaction) {
      return c.json({ error: "reactions not enabled" }, 404);
    }
    const parsed = parseReactionParams(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid reaction parameters" }, 400);
    }
    return c.html(renderConfirmPage(parsed.data));
  });

  app.post("/reactions", async (c) => {
    if (!recordReaction) {
      return c.json({ error: "reactions not enabled" }, 404);
    }
    const parsed = parseReactionParams(c.req.query());
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

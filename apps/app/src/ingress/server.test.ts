import { createHmac } from "node:crypto";
import type { Deck, DeckRef } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import openedFixture from "../../test/fixtures/pull_request.opened.json" with { type: "json" };
import synchronizeFixture from "../../test/fixtures/pull_request.synchronize.json" with {
  type: "json",
};
import type { PrRef, PrStatusUpdateJob } from "../types.js";
import { createServer } from "./server.js";

const SECRET = "test-webhook-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function post(
  app: ReturnType<typeof createServer>,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request("/webhook", { method: "POST", body, headers });
}

function baseHeaders(body: string, event = "pull_request") {
  return {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "delivery-123",
    "x-hub-signature-256": sign(body),
  };
}

describe("ingress /webhook (R2)", () => {
  it("enqueues and acks 202 for a signed pull_request.opened", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify(openedFixture);

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      installationId: 12345,
      action: "opened",
      deliveryId: "delivery-123",
    });
  });

  it("carries the synchronize action through to the job", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify(synchronizeFixture);

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(202);
    expect(enqueue.mock.calls[0]?.[0].action).toBe("synchronize");
  });

  it("rejects an invalid signature with 401 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify(openedFixture);

    const res = await post(app, body, {
      ...baseHeaders(body),
      "x-hub-signature-256": "sha256=deadbeef",
    });

    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("acks closed with 204 when no status queue is wired", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify({ ...openedFixture, action: "closed" });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues a merged status write on closed and does not run a review (#31)", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const enqueueStatus = vi.fn<(job: PrStatusUpdateJob) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, enqueueStatus });
    const body = JSON.stringify({
      ...openedFixture,
      action: "closed",
      pull_request: { ...openedFixture.pull_request, merged: true, state: "closed" },
    });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(202);
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueStatus).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      installationId: 12345,
      state: "closed",
      merged: true,
      deliveryId: "delivery-123",
    });
  });

  it("records merged=false for a closed-not-merged PR (#31)", async () => {
    const enqueueStatus = vi.fn<(job: PrStatusUpdateJob) => Promise<void>>(async () => {});
    const app = createServer({
      webhookSecret: SECRET,
      enqueue: vi.fn(async () => {}),
      enqueueStatus,
    });
    const body = JSON.stringify({
      ...openedFixture,
      action: "closed",
      pull_request: { ...openedFixture.pull_request, merged: false, state: "closed" },
    });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(202);
    expect(enqueueStatus.mock.calls[0]?.[0]).toMatchObject({ state: "closed", merged: false });
  });

  it("maps reopened back to open status (#31)", async () => {
    const enqueueStatus = vi.fn<(job: PrStatusUpdateJob) => Promise<void>>(async () => {});
    const app = createServer({
      webhookSecret: SECRET,
      enqueue: vi.fn(async () => {}),
      enqueueStatus,
    });
    const body = JSON.stringify({ ...openedFixture, action: "reopened" });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(202);
    expect(enqueueStatus.mock.calls[0]?.[0]).toMatchObject({ state: "open", merged: false });
  });

  it("ignores an unrelated action with 204 even when the status queue is wired (#31)", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const enqueueStatus = vi.fn<(job: PrStatusUpdateJob) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, enqueueStatus });
    const body = JSON.stringify({ ...openedFixture, action: "labeled" });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueStatus).not.toHaveBeenCalled();
  });

  it("returns 503 when the queue is unavailable", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {
      throw new Error("redis down");
    });
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify(openedFixture);

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(503);
  });

  it("returns 413 when the actual body exceeds the size cap", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    // Oversized body with no honest content-length: the cap must hold on the
    // bytes actually read, not on the header.
    const body = "x".repeat(6_000_000);

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ignores non-pull_request events with 204", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify({ zen: "Keep it logically awesome." });

    const res = await post(app, body, baseHeaders(body, "ping"));

    expect(res.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("ingress /reactions (R3)", () => {
  const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
  const validQuery = "owner=octo-org&repo=demo&pr=42&fp=abc123def4567890&tier=High&s=up";

  const post = (query: string) =>
    new Request(`http://localhost/reactions?${query}`, { method: "POST" });

  it("does not record on GET — only renders a confirm page that POSTs", async () => {
    const recordReaction = vi.fn(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const res = await app.request(`/reactions?${validQuery}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(recordReaction).not.toHaveBeenCalled();
    // The button POSTs back with the same params, so prefetchers can't write.
    expect(html).toContain('method="post"');
    expect(html).toContain("/reactions?");
    expect(html).toContain("pr=42");
  });

  it("records a valid reaction on POST and returns 200", async () => {
    const recordReaction = vi.fn(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const res = await app.request(post(validQuery));

    expect(res.status).toBe(200);
    expect(recordReaction).toHaveBeenCalledOnce();
    expect(recordReaction).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      fingerprint: "abc123def4567890",
      tier: "High",
      sentiment: "up",
    });
  });

  it("rejects an invalid sentiment with 400 and does not record", async () => {
    const recordReaction = vi.fn(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const res = await app.request(post("owner=o&repo=r&pr=1&fp=x&tier=High&s=love"));

    expect(res.status).toBe(400);
    expect(recordReaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown tier with 400", async () => {
    const recordReaction = vi.fn(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const res = await app.request(post("owner=o&repo=r&pr=1&fp=x&tier=Critical&s=up"));

    expect(res.status).toBe(400);
    expect(recordReaction).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty pr with 400", async () => {
    const recordReaction = vi.fn(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const missing = await app.request(post("owner=o&repo=r&fp=x&tier=High&s=up"));
    const empty = await app.request(post("owner=o&repo=r&pr=&fp=x&tier=High&s=up"));

    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(recordReaction).not.toHaveBeenCalled();
  });

  it("returns 404 when reactions are not wired", async () => {
    const app = createServer({ webhookSecret: SECRET, enqueue });

    const getRes = await app.request(`/reactions?${validQuery}`);
    const postRes = await app.request(post(validQuery));

    expect(getRes.status).toBe(404);
    expect(postRes.status).toBe(404);
  });

  it("returns 503 when recording fails", async () => {
    const recordReaction = vi.fn(async () => {
      throw new Error("db down");
    });
    const app = createServer({ webhookSecret: SECRET, enqueue, recordReaction });

    const res = await app.request(post(validQuery));

    expect(res.status).toBe(503);
  });
});

describe("ingress POST /decks (#26)", () => {
  const DECK_SECRET = "deck-trigger-secret-0123456789";
  const auth = { authorization: `Bearer ${DECK_SECRET}` };

  const jsonPost = (body: unknown, headers: Record<string, string> = auth) =>
    new Request("http://localhost/decks", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const validBody = { owner: "octo-org", repo: "demo", prNumber: 42, installationId: 12345 };

  it("enqueues an on-demand review job and acks 202 with a valid bearer token", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(jsonPost(validBody));

    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    const ref = enqueue.mock.calls[0]?.[0] as PrRef;
    expect(ref).toMatchObject({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      installationId: 12345,
      action: "synchronize",
    });
    expect(ref.deliveryId).toMatch(/^ondemand-/);
  });

  it("is disabled (404) and never enqueues when no deck secret is configured", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });

    const res = await app.request(jsonPost(validBody, {}));

    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing bearer token with 401 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(jsonPost(validBody, {}));

    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token with 401 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(jsonPost(validBody, { authorization: "Bearer wrong-secret" }));

    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(jsonPost({ owner: "o", repo: "r" }));

    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(
      new Request("http://localhost/decks", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 413 before enqueueing", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(
      new Request("http://localhost/decks", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: "x".repeat(70_000),
      }),
    );

    expect(res.status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns 503 when the queue is unavailable", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {
      throw new Error("redis down");
    });
    const app = createServer({ webhookSecret: SECRET, enqueue, deckApiSecret: DECK_SECRET });

    const res = await app.request(jsonPost(validBody));

    expect(res.status).toBe(503);
  });
});

describe("ingress GET /decks (#26)", () => {
  const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
  const DECK_SECRET = "deck-trigger-secret-0123456789";
  const deck: Deck = {
    owner: "octo-org",
    repo: "demo",
    prNumber: 42,
    headSha: "abc123",
    cards: [
      {
        fingerprint: "fp-a",
        file: "src/auth.ts",
        tier: "High",
        rank: 0,
        riskScore: 4.2,
        highlights: [{ side: "R", start: 2, end: 4 }],
        suggestions: ["checkToken() is never awaited"],
        explanation: "Adds a token check.",
      },
    ],
  };
  const query = "owner=octo-org&repo=demo&pr=42&sha=abc123";

  it("returns the persisted deck as JSON (no secret configured)", async () => {
    const getDeck = vi.fn<(ref: DeckRef) => Promise<Deck | null>>(async () => deck);
    const app = createServer({ webhookSecret: SECRET, enqueue, getDeck });

    const res = await app.request(`/decks?${query}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(deck);
    expect(getDeck).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      headSha: "abc123",
    });
  });

  it("requires a bearer token when a deck secret is configured", async () => {
    const getDeck = vi.fn<(ref: DeckRef) => Promise<Deck | null>>(async () => deck);
    const app = createServer({
      webhookSecret: SECRET,
      enqueue,
      getDeck,
      deckApiSecret: DECK_SECRET,
    });

    const unauthorized = await app.request(`/decks?${query}`);
    expect(unauthorized.status).toBe(401);
    expect(getDeck).not.toHaveBeenCalled();

    const authorized = await app.request(
      new Request(`http://localhost/decks?${query}`, {
        headers: { authorization: `Bearer ${DECK_SECRET}` },
      }),
    );
    expect(authorized.status).toBe(200);
    expect(getDeck).toHaveBeenCalledOnce();
  });

  it("returns 404 when the deck does not exist", async () => {
    const getDeck = vi.fn<(ref: DeckRef) => Promise<Deck | null>>(async () => null);
    const app = createServer({ webhookSecret: SECRET, enqueue, getDeck });

    const res = await app.request(`/decks?${query}`);

    expect(res.status).toBe(404);
  });

  it("rejects a missing head SHA with 400", async () => {
    const getDeck = vi.fn<(ref: DeckRef) => Promise<Deck | null>>(async () => deck);
    const app = createServer({ webhookSecret: SECRET, enqueue, getDeck });

    const res = await app.request("/decks?owner=octo-org&repo=demo&pr=42");

    expect(res.status).toBe(400);
    expect(getDeck).not.toHaveBeenCalled();
  });

  it("returns 404 when decks are not wired", async () => {
    const app = createServer({ webhookSecret: SECRET, enqueue });

    const res = await app.request(`/decks?${query}`);

    expect(res.status).toBe(404);
  });

  it("returns 503 when the store read fails", async () => {
    const getDeck = vi.fn<(ref: DeckRef) => Promise<Deck | null>>(async () => {
      throw new Error("db down");
    });
    const app = createServer({ webhookSecret: SECRET, enqueue, getDeck });

    const res = await app.request(`/decks?${query}`);

    expect(res.status).toBe(503);
  });
});

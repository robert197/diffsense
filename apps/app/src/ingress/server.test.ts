import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import openedFixture from "../../test/fixtures/pull_request.opened.json" with { type: "json" };
import synchronizeFixture from "../../test/fixtures/pull_request.synchronize.json" with {
  type: "json",
};
import type { PrRef } from "../types.js";
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

  it("acks non-target actions with 204 and does not enqueue", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify({ ...openedFixture, action: "closed" });

    const res = await post(app, body, baseHeaders(body));

    expect(res.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
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

  it("returns 413 when the body exceeds the size cap", async () => {
    const enqueue = vi.fn<(ref: PrRef) => Promise<void>>(async () => {});
    const app = createServer({ webhookSecret: SECRET, enqueue });
    const body = JSON.stringify(openedFixture);

    const res = await post(app, body, {
      ...baseHeaders(body),
      "content-length": String(6_000_000),
    });

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

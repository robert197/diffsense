import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * GitHub App Setup URL route. The load-bearing behavior is the no-open-redirect
 * guarantee: regardless of GitHub-supplied query params, the handler redirects to a
 * fixed internal `/repos` path derived from config.
 */

import { GET } from "./route";

const BASE = "https://app.example.com";

function setupReq(query: Record<string, string> = {}): NextRequest {
  const url = new URL(`${BASE}/api/github/setup`);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
  process.env.WEB_BASE_URL = BASE;
});

describe("GET /api/github/setup", () => {
  it("redirects to /repos?installed=1 after an install", () => {
    const res = GET(setupReq({ installation_id: "12345", setup_action: "install" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/repos?installed=1`);
  });

  it("ignores GitHub-supplied query params for the destination (no open redirect)", () => {
    const res = GET(
      setupReq({ installation_id: "9", setup_action: "install", state: "https://evil.example" }),
    );
    expect(res.headers.get("location")).toBe(`${BASE}/repos?installed=1`);
  });

  it("redirects the same way for setup_action=update", () => {
    const res = GET(setupReq({ installation_id: "9", setup_action: "update" }));
    expect(res.headers.get("location")).toBe(`${BASE}/repos?installed=1`);
  });
});

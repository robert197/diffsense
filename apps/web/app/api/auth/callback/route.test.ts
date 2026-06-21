import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OAuth callback route tests (issue #25). The security-load-bearing behavior is
 * the CSRF `state` check and the open-redirect-free error handling; the network
 * exchange, identity read, and session persistence are faked so we exercise the
 * route's branching, not GitHub.
 */

const { exchangeMock, createSessionMock, getUserMock } = vi.hoisted(() => ({
  exchangeMock: vi.fn(),
  createSessionMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock("../../../../lib/auth/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/auth/oauth")>();
  return { ...actual, exchangeCodeForToken: (...args: unknown[]) => exchangeMock(...args) };
});

vi.mock("../../../../lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/auth/session")>();
  return { ...actual, createSession: (...args: unknown[]) => createSessionMock(...args) };
});

vi.mock("../../../../lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/github")>();
  return { ...actual, createGitHubClient: () => ({ getAuthenticatedUser: getUserMock }) };
});

import { SESSION_COOKIE, STATE_COOKIE } from "../../../../lib/auth/session";
import { GET } from "./route";

const BASE = "https://app.example.com";

function callbackReq(opts: { code?: string; state?: string; cookieState?: string }): NextRequest {
  const url = new URL(`${BASE}/api/auth/callback`);
  if (opts.code !== undefined) url.searchParams.set("code", opts.code);
  if (opts.state !== undefined) url.searchParams.set("state", opts.state);
  const headers: Record<string, string> = {};
  if (opts.cookieState !== undefined) headers.cookie = `${STATE_COOKIE}=${opts.cookieState}`;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
  process.env.WEB_BASE_URL = BASE;
  exchangeMock.mockReset();
  createSessionMock.mockReset();
  getUserMock.mockReset();
});

describe("OAuth callback GET", () => {
  it("completes the flow: exchanges the code, sets the session cookie, redirects to /repos", async () => {
    exchangeMock.mockResolvedValue({ accessToken: "gho_x" });
    getUserMock.mockResolvedValue({ id: 1, login: "octocat", avatarUrl: null });
    createSessionMock.mockResolvedValue("sess-token");

    const res = await GET(callbackReq({ code: "the-code", state: "nonce", cookieState: "nonce" }));

    expect(res.headers.get("location")).toBe(`${BASE}/repos`);
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("sess-token");
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched state (CSRF) without exchanging the code", async () => {
    const res = await GET(callbackReq({ code: "c", state: "attacker", cookieState: "real" }));

    expect(res.headers.get("location")).toBe(`${BASE}/?error=auth`);
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBeFalsy();
  });

  it("rejects when the state cookie is absent", async () => {
    const res = await GET(callbackReq({ code: "c", state: "nonce" }));

    expect(res.headers.get("location")).toBe(`${BASE}/?error=auth`);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("redirects to the error page when the token exchange fails", async () => {
    exchangeMock.mockRejectedValue(new Error("bad_verification_code"));

    const res = await GET(callbackReq({ code: "c", state: "nonce", cookieState: "nonce" }));

    expect(res.headers.get("location")).toBe(`${BASE}/?error=auth`);
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

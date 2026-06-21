import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  parseTokenResponse,
  refreshAccessToken,
} from "./oauth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildAuthorizeUrl", () => {
  it("targets the GitHub authorize endpoint with client_id, redirect_uri, state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "Iv1.abc",
        redirectUri: "https://app.example.com/api/auth/callback",
        state: "nonce123",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/auth/callback");
    expect(url.searchParams.get("state")).toBe("nonce123");
  });
});

describe("parseTokenResponse", () => {
  it("parses access token plus optional refresh/expiry", () => {
    const tokens = parseTokenResponse({
      access_token: "gho_x",
      refresh_token: "ghr_y",
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
    });
    expect(tokens).toEqual({
      accessToken: "gho_x",
      refreshToken: "ghr_y",
      expiresInSeconds: 28800,
      refreshTokenExpiresInSeconds: 15897600,
    });
  });

  it("parses a non-expiring token (no refresh/expiry fields)", () => {
    expect(parseTokenResponse({ access_token: "gho_x" })).toEqual({
      accessToken: "gho_x",
      refreshToken: undefined,
      expiresInSeconds: undefined,
      refreshTokenExpiresInSeconds: undefined,
    });
  });

  it("throws on a GitHub error body", () => {
    expect(() => parseTokenResponse({ error: "bad_verification_code" })).toThrow(
      /bad_verification_code/,
    );
  });

  it("throws when access_token is missing", () => {
    expect(() => parseTokenResponse({})).toThrow(/access_token/);
  });
});

describe("exchangeCodeForToken", () => {
  it("POSTs to the token endpoint with Accept: application/json and maps the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "gho_x" }));
    const tokens = await exchangeCodeForToken(
      {
        clientId: "id",
        clientSecret: "secret",
        code: "the-code",
        redirectUri: "https://app.example.com/api/auth/callback",
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(tokens.accessToken).toBe("gho_x");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(JSON.parse((init as RequestInit).body as string).code).toBe("the-code");
  });

  it("surfaces a GitHub error body as a throw", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad_verification_code" }));
    await expect(
      exchangeCodeForToken(
        { clientId: "id", clientSecret: "s", code: "c", redirectUri: "r" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("throws on a non-2xx transport status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      exchangeCodeForToken(
        { clientId: "id", clientSecret: "s", code: "c", redirectUri: "r" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/500/);
  });
});

describe("refreshAccessToken", () => {
  it("sends grant_type=refresh_token and the refresh token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "gho_new" }));
    const tokens = await refreshAccessToken(
      { clientId: "id", clientSecret: "s", refreshToken: "ghr_old" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(tokens.accessToken).toBe("gho_new");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("ghr_old");
  });
});

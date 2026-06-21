import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Composition tests for the DB-backed reviewer session (issue #25). The crypto /
 * oauth / github primitives are unit-tested elsewhere; this file covers the
 * session lifecycle that decides "is this reviewer still signed in" — TTL
 * enforcement, decrypt-failure handling, and the token-refresh outcomes — which
 * is the heart of the "a session is persisted" acceptance criterion.
 *
 * next/headers (cookies), next/navigation (redirect), the DB client, and the
 * OAuth refresh call are faked; everything in session.ts itself runs for real.
 */

// Hoisted so the vi.mock factories below can close over this shared, resettable state.
const h = vi.hoisted(() => ({
  cookieStore: {} as Record<string, { value: string } | undefined>,
  db: {
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
    selectResult: [] as Array<Record<string, unknown>>,
  },
  refreshMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => h.cookieStore[name] }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getDb: () => ({
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.db.inserted.push(v);
        },
      }),
      select: () => ({ from: () => ({ where: async () => h.db.selectResult }) }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            h.db.updated.push(v);
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          h.db.deleted += 1;
        },
      }),
    }),
  };
});

vi.mock("./oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oauth")>();
  return { ...actual, refreshAccessToken: (...args: unknown[]) => h.refreshMock(...args) };
});

import { deriveKey, encrypt, hashToken } from "./crypto";
import {
  SESSION_COOKIE,
  accessTokenNeedsRefresh,
  clearSessionRow,
  createSession,
  getSession,
  requireSession,
} from "./session";

const SECRET = "test-session-secret-0123456789";
const key = deriveKey(SECRET);

function rowFor(token: string, overrides: Record<string, unknown> = {}) {
  const future = new Date(Date.now() + 60_000);
  return {
    tokenHash: hashToken(token),
    githubUserId: 42,
    githubLogin: "octocat",
    githubAvatarUrl: "https://a/octocat.png",
    accessTokenEncrypted: encrypt("gho_access", key),
    accessTokenExpiresAt: null as Date | null,
    refreshTokenEncrypted: null as string | null,
    refreshTokenExpiresAt: null as Date | null,
    createdAt: new Date(),
    expiresAt: future,
    ...overrides,
  };
}

function signIn(token: string) {
  h.cookieStore[SESSION_COOKIE] = { value: token };
}

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
  process.env.SESSION_SECRET = SECRET;
  process.env.WEB_BASE_URL = "https://app.example.com";
  for (const k of Object.keys(h.cookieStore)) delete h.cookieStore[k];
  h.db.inserted = [];
  h.db.updated = [];
  h.db.deleted = 0;
  h.db.selectResult = [];
  h.refreshMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accessTokenNeedsRefresh", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  it("never refreshes a non-expiring (null) token", () => {
    expect(accessTokenNeedsRefresh(null, now)).toBe(false);
  });

  it("does not refresh a token comfortably in the future", () => {
    expect(accessTokenNeedsRefresh(new Date(now + 3600_000), now)).toBe(false);
  });

  it("refreshes a token within the early-refresh skew window", () => {
    expect(accessTokenNeedsRefresh(new Date(now + 30_000), now, 60)).toBe(true);
  });

  it("refreshes an already-expired token", () => {
    expect(accessTokenNeedsRefresh(new Date(now - 1), now)).toBe(true);
  });
});

describe("createSession + getSession round trip", () => {
  it("persists an encrypted token and resolves the signed-in identity", async () => {
    const token = await createSession(
      { id: 42, login: "octocat", avatarUrl: "https://a/octocat.png" },
      { accessToken: "gho_real" },
    );

    expect(h.db.inserted).toHaveLength(1);
    const persisted = h.db.inserted[0];
    expect(persisted.tokenHash).toBe(hashToken(token));
    // Raw token is never stored; the GitHub token is encrypted at rest.
    expect(persisted.accessTokenEncrypted).not.toContain("gho_real");
    expect(persisted.githubLogin).toBe("octocat");

    h.db.selectResult = [persisted];
    signIn(token);

    const session = await getSession();
    expect(session).not.toBeNull();
    // The stable numeric id keys per-reviewer resumable state (#29).
    expect(session?.userId).toBe(42);
    expect(session?.login).toBe("octocat");
    expect(session?.avatarUrl).toBe("https://a/octocat.png");
    expect(session?.github).toBeDefined();
  });
});

describe("getSession sign-out conditions", () => {
  it("returns null with no session cookie", async () => {
    expect(await getSession()).toBeNull();
  });

  it("returns null when the cookie has no matching row", async () => {
    signIn("orphan-token");
    h.db.selectResult = [];
    expect(await getSession()).toBeNull();
  });

  it("returns null for a row past its TTL", async () => {
    signIn("tok");
    h.db.selectResult = [rowFor("tok", { expiresAt: new Date(Date.now() - 1000) })];
    expect(await getSession()).toBeNull();
  });

  it("returns null when the stored token fails GCM authentication (tampered/wrong key)", async () => {
    signIn("tok");
    h.db.selectResult = [rowFor("tok", { accessTokenEncrypted: "not:a:valid-payload" })];
    expect(await getSession()).toBeNull();
  });
});

describe("getSession token refresh", () => {
  it("refreshes an expired access token and persists the rotated token", async () => {
    signIn("tok");
    h.db.selectResult = [
      rowFor("tok", {
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshTokenEncrypted: encrypt("ghr_old", key),
      }),
    ];
    h.refreshMock.mockResolvedValue({
      accessToken: "gho_new",
      refreshToken: "ghr_new",
      expiresInSeconds: 28800,
      refreshTokenExpiresInSeconds: 15897600,
    });

    const session = await getSession();
    expect(session).not.toBeNull();
    expect(h.refreshMock).toHaveBeenCalledTimes(1);
    expect(h.db.updated).toHaveLength(1);
    // The newly persisted access token is the rotated one, still encrypted.
    expect(h.db.updated[0].accessTokenEncrypted).not.toContain("gho_new");
  });

  it("returns null (signed out) when refresh fails — never throws", async () => {
    signIn("tok");
    h.db.selectResult = [
      rowFor("tok", {
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshTokenEncrypted: encrypt("ghr_old", key),
      }),
    ];
    h.refreshMock.mockRejectedValue(new Error("token endpoint returned 401"));

    await expect(getSession()).resolves.toBeNull();
    expect(h.db.updated).toHaveLength(0);
  });

  it("returns null when the access token is expired and there is no refresh token", async () => {
    signIn("tok");
    h.db.selectResult = [
      rowFor("tok", {
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshTokenEncrypted: null,
      }),
    ];
    expect(await getSession()).toBeNull();
    expect(h.refreshMock).not.toHaveBeenCalled();
  });
});

describe("requireSession", () => {
  it("redirects to /login when signed out", async () => {
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("clearSessionRow", () => {
  it("deletes the row for the current cookie", async () => {
    signIn("tok");
    await clearSessionRow();
    expect(h.db.deleted).toBe(1);
  });

  it("is a no-op when there is no cookie", async () => {
    await clearSessionRow();
    expect(h.db.deleted).toBe(0);
  });
});

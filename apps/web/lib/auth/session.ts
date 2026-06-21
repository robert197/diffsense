import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, webSessions } from "../db";
import { type GitHubClient, createGitHubClient } from "../github";
import { type AuthConfig, loadAuthConfig } from "./config";
import { decrypt, deriveKey, encrypt, hashToken, randomToken } from "./crypto";
import { type OAuthTokens, refreshAccessToken } from "./oauth";

/**
 * DB-backed reviewer session (issue #25). The cookie holds an opaque token; the
 * `web_sessions` row is keyed by its SHA-256 hash, and the GitHub tokens are
 * encrypted at rest. Self-host: state lives in the shared Postgres, secrets come
 * only from env. This module composes the unit-tested crypto / oauth / github
 * primitives with Next's request-scoped cookie store.
 *
 * Cookie *writes* happen only in Route Handlers (login callback / logout), where
 * the cookie is set on the returned response. Reads happen anywhere. Server
 * components must never mutate cookies — the 401 path therefore deletes only the
 * DB row (`clearSessionRow`), which makes the next `getSession` return null.
 */

export const SESSION_COOKIE = "ds_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
// Refresh an expiring access token slightly early to avoid edge races.
const REFRESH_SKEW_SECONDS = 60;

export interface ActiveSession {
  login: string;
  avatarUrl: string | null;
  /** A GitHub client already bound to this session's (fresh) access token. */
  github: GitHubClient;
}

/** Cookie attributes for the session token — set on the response in routes. */
export function sessionCookieOptions(config: AuthConfig) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.secureCookies,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Persist a session row after a successful OAuth exchange and return the raw
 * cookie token. The caller (the callback route) sets it on the response so the
 * cookie is reliably attached to the redirect.
 */
export async function createSession(
  user: { id: number; login: string; avatarUrl: string | null },
  tokens: OAuthTokens,
): Promise<string> {
  const config = loadAuthConfig();
  const key = deriveKey(config.sessionSecret);
  const token = randomToken();
  const now = Date.now();

  await getDb()
    .insert(webSessions)
    .values({
      tokenHash: hashToken(token),
      githubUserId: user.id,
      githubLogin: user.login,
      githubAvatarUrl: user.avatarUrl,
      accessTokenEncrypted: encrypt(tokens.accessToken, key),
      accessTokenExpiresAt: expiryFrom(now, tokens.expiresInSeconds),
      refreshTokenEncrypted: tokens.refreshToken ? encrypt(tokens.refreshToken, key) : null,
      refreshTokenExpiresAt: expiryFrom(now, tokens.refreshTokenExpiresInSeconds),
      expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000),
    });

  return token;
}

/**
 * Resolve the current session, or `null` when signed out. Decrypts the access
 * token and refreshes it when expired (if a refresh token exists); a session past
 * its own TTL, missing its row, or whose token can't be refreshed is treated as
 * signed out. Read-only with respect to cookies — safe in server components.
 */
export async function getSession(): Promise<ActiveSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const config = loadAuthConfig();
  const key = deriveKey(config.sessionSecret);
  const tokenHash = hashToken(token);
  const [row] = await getDb()
    .select()
    .from(webSessions)
    .where(eq(webSessions.tokenHash, tokenHash));
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  let accessToken: string;
  try {
    accessToken = decrypt(row.accessTokenEncrypted, key);
  } catch {
    return null;
  }

  const refreshed = await maybeRefresh(row, config, key);
  if (refreshed) {
    accessToken = refreshed;
  }

  return {
    login: row.githubLogin,
    avatarUrl: row.githubAvatarUrl,
    github: createGitHubClient(accessToken),
  };
}

/** Read the session and redirect to `/login` when absent (page guard). */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

/**
 * Delete the current session's DB row without touching the cookie. Safe to call
 * from a server component (e.g. on a GitHub 401): the orphaned cookie no longer
 * matches a row, so the next `getSession` returns null and the guard redirects.
 */
export async function clearSessionRow(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDb()
      .delete(webSessions)
      .where(eq(webSessions.tokenHash, hashToken(token)));
  }
}

type SessionRow = typeof webSessions.$inferSelect;

/** Refresh + persist an expired access token; returns the new token or null. */
async function maybeRefresh(
  row: SessionRow,
  config: AuthConfig,
  key: Buffer,
): Promise<string | null> {
  const expiresAt = row.accessTokenExpiresAt?.getTime();
  if (!expiresAt || expiresAt - REFRESH_SKEW_SECONDS * 1000 > Date.now()) {
    return null; // non-expiring token, or still valid
  }
  if (!row.refreshTokenEncrypted) {
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(row.refreshTokenEncrypted, key);
  } catch {
    return null;
  }

  const tokens = await refreshAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken,
  });
  const now = Date.now();
  await getDb()
    .update(webSessions)
    .set({
      accessTokenEncrypted: encrypt(tokens.accessToken, key),
      accessTokenExpiresAt: expiryFrom(now, tokens.expiresInSeconds),
      refreshTokenEncrypted: tokens.refreshToken
        ? encrypt(tokens.refreshToken, key)
        : row.refreshTokenEncrypted,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresInSeconds
        ? expiryFrom(now, tokens.refreshTokenExpiresInSeconds)
        : row.refreshTokenExpiresAt,
    })
    .where(eq(webSessions.tokenHash, row.tokenHash));
  return tokens.accessToken;
}

function expiryFrom(nowMs: number, seconds: number | undefined): Date | null {
  return typeof seconds === "number" ? new Date(nowMs + seconds * 1000) : null;
}

import { NextResponse } from "next/server";
import { loadAuthConfig, redirectUri } from "../../lib/auth/config";
import { randomToken } from "../../lib/auth/crypto";
import { buildAuthorizeUrl } from "../../lib/auth/oauth";
import { STATE_COOKIE, STATE_TTL_SECONDS } from "../../lib/auth/session";

/**
 * Start the GitHub OAuth flow (issue #25). Generate a CSRF `state` nonce, stash
 * it in a short-lived httpOnly cookie, and redirect the reviewer to GitHub's
 * authorize page. The callback verifies the returned `state` against this cookie.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const config = loadAuthConfig();
  const state = randomToken();
  const authorizeUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: redirectUri(config),
    state,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadAuthConfig, redirectUri } from "../../../../lib/auth/config";
import { timingSafeEqualString } from "../../../../lib/auth/crypto";
import { exchangeCodeForToken } from "../../../../lib/auth/oauth";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  createSession,
  sessionCookieOptions,
} from "../../../../lib/auth/session";
import { createGitHubClient } from "../../../../lib/github";

/**
 * OAuth callback (issue #25). Verify the `state` nonce against the cookie set by
 * `/login` (CSRF guard), exchange the code for a user token, read the identity,
 * persist the session, and redirect to the repo picker. Redirect targets are
 * fixed internal paths — never request-derived — so there is no open redirect.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const reposUrl = `${config.webBaseUrl}/repos`;
  const errorUrl = `${config.webBaseUrl}/?error=auth`;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;

  // CSRF guard: the returned state must match the single-use cookie nonce.
  // Constant-time compare for defense in depth (consistent with the codebase's
  // hashed-token handling), after the presence checks short-circuit.
  if (!code || !state || !expectedState || !timingSafeEqualString(state, expectedState)) {
    return clearState(NextResponse.redirect(errorUrl));
  }

  let sessionToken: string;
  try {
    const tokens = await exchangeCodeForToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: redirectUri(config),
    });
    const user = await createGitHubClient(tokens.accessToken).getAuthenticatedUser();
    sessionToken = await createSession(user, tokens);
  } catch (err) {
    // Log server-side so production sign-in failures are diagnosable; the
    // reviewer still gets the generic ?error=auth screen (no detail leak).
    console.error("oauth callback failed", err);
    return clearState(NextResponse.redirect(errorUrl));
  }

  // Set the session cookie on the redirect response itself (reliable in route
  // handlers) and drop the single-use state nonce.
  const res = clearState(NextResponse.redirect(reposUrl));
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions(config));
  return res;
}

function clearState(res: NextResponse): NextResponse {
  res.cookies.delete(STATE_COOKIE);
  return res;
}

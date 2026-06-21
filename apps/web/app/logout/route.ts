import { NextResponse } from "next/server";
import { loadAuthConfig } from "../../lib/auth/config";
import { SESSION_COOKIE, clearSessionRow } from "../../lib/auth/session";

/**
 * Sign out (issue #25). Delete the session row, clear the cookie on the response,
 * and return to the home page. POST is the primary entry (the logout form); GET is
 * a convenience.
 */

export const dynamic = "force-dynamic";

async function handle(): Promise<NextResponse> {
  const config = loadAuthConfig();
  await clearSessionRow();
  const res = NextResponse.redirect(`${config.webBaseUrl}/`);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export const POST = handle;
export const GET = handle;

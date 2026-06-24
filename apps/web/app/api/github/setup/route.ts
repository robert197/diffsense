import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadAuthConfig } from "../../../../lib/auth/config";

/**
 * GitHub App Setup URL (org-aware onboarding). After a reviewer installs or updates
 * the diffsense App on GitHub, GitHub redirects here with `installation_id` and
 * `setup_action`. We don't need to exchange or persist anything — the next `/repos`
 * render and the modal's reopen-refetch pick up the new installation through the
 * normal `/user/installations` path — so this handler simply bounces the reviewer
 * back to the repo picker, closing the install loop without a manual refresh.
 *
 * The redirect target is a FIXED internal path built from config, never from the
 * request's query params (which are GitHub-supplied) — same no-open-redirect rule as
 * the OAuth callback. The `installed=1` marker is available for a future toast /
 * auto-open but does not affect routing.
 *
 * NOTE (out of band): for this to fire, the GitHub App's "Setup URL" must be set to
 * `${WEB_BASE_URL}/api/github/setup` (with "Redirect on update" enabled) in the
 * App's settings on GitHub. Without it, install simply doesn't auto-return.
 */

export const dynamic = "force-dynamic";

export function GET(_req: NextRequest): NextResponse {
  const config = loadAuthConfig();
  return NextResponse.redirect(`${config.webBaseUrl}/repos?installed=1`);
}

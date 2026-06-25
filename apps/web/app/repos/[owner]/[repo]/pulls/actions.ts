"use server";

import { getSession } from "../../../../../lib/auth/session";
import { GitHubAuthError, type PullRequest } from "../../../../../lib/github";

/**
 * Refetch one repo's open PRs for the client-side sync seam (PullsList). A
 * `"use server"` action is an independently-invokable endpoint, so it re-checks the
 * session itself rather than trusting the page guard — same discipline as
 * `loadAddableRepos`. This is the performant path the live list calls on tab refocus
 * and manual refresh: only the PR array crosses the wire, not a whole page re-render.
 * A 401 (expired sign-in) returns `{ error: "reauth" }` so the client can route to
 * `/login`; other failures throw so the client can surface a retry rather than show a
 * silently-empty list.
 */
export type LoadPullsResult = { pulls: PullRequest[] } | { error: "reauth" };

export async function loadOpenPullRequests(owner: string, repo: string): Promise<LoadPullsResult> {
  if (!owner.trim() || !repo.trim()) {
    // A blank target can't address a repo — treat it as nothing to sync rather than
    // sending an empty path to GitHub.
    return { pulls: [] };
  }

  const session = await getSession();
  if (!session) {
    return { error: "reauth" };
  }

  try {
    const pulls = await session.github.listOpenPullRequests(owner, repo);
    return { pulls };
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return { error: "reauth" };
    }
    throw err;
  }
}

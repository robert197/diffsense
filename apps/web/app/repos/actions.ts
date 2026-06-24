"use server";

import {
  type AddableReposResult,
  buildAddableGroups,
  computeInstallableTargets,
} from "../../lib/addableRepos";
import { getSession } from "../../lib/auth/session";
import { GitHubAuthError, GitHubRateLimitError, type Organization } from "../../lib/github";
import { appSlug, buildInstallUrl } from "../../lib/githubApp";

/**
 * Load the "Add repositories" modal's browse list (issue: add-repositories-modal).
 * A `"use server"` action is an independently-invokable endpoint, so it re-checks
 * the session itself rather than trusting the page guard. It fetches every repo the
 * reviewer can reach plus the installed subset, then hands both to the pure
 * `buildAddableGroups` shaper. A GitHub 401 (token revoked/expired beyond refresh)
 * returns `{ error: "reauth" }` so the modal can prompt a re-sign-in instead of
 * blanking; one installation's transient failure degrades only that account's
 * `added` flags (the repo still shows, just not marked installed).
 */
export async function loadAddableRepos(): Promise<AddableReposResult> {
  const session = await getSession();
  if (!session) {
    return { error: "reauth" };
  }

  try {
    // The installation list, the full accessible set, and the user's orgs are
    // independent reads — fetch them together so the first modal open isn't
    // serialised. Org listing degrades gracefully: a GitHub-App user token may lack
    // org-membership read, so a non-auth failure just means no install cards (the
    // generic footer link remains). A 401 still re-surfaces as reauth.
    const [installations, accessible, orgs] = await Promise.all([
      session.github.listInstallations(),
      session.github.listAccessibleRepositories(),
      session.github.listUserOrganizations().catch((err): Organization[] => {
        if (err instanceof GitHubAuthError) {
          throw err;
        }
        return [];
      }),
    ]);
    const installedLists = await Promise.all(
      installations.map((installation) =>
        // Per-installation failures must not sink the whole modal: a transient
        // non-auth failure for one account just means its repos aren't marked
        // "added". A rate-limit, though, would mis-mark every repo in that account
        // as not-added — a wrong signal — so re-throw it (like auth) to surface a
        // retry rather than silently showing "Add" on already-installed repos.
        session.github
          .listInstallationRepositories(installation.id)
          .catch((err) => {
            if (err instanceof GitHubAuthError || err instanceof GitHubRateLimitError) {
              throw err;
            }
            return [];
          }),
      ),
    );

    const installedFullNames = new Set<string>();
    for (const list of installedLists) {
      for (const repo of list) {
        installedFullNames.add(repo.fullName);
      }
    }

    const slug = appSlug();
    return {
      groups: buildAddableGroups(accessible, installedFullNames, installations, slug),
      installableTargets: computeInstallableTargets(orgs, session.login, installations),
      installNewUrl: buildInstallUrl(slug),
    };
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return { error: "reauth" };
    }
    throw err;
  }
}

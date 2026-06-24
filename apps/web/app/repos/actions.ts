"use server";

import {
  type AddableReposResult,
  buildAddableGroups,
  computeInstallableTargets,
} from "../../lib/addableRepos";
import { getSession } from "../../lib/auth/session";
import { GitHubAuthError, GitHubRateLimitError, type Repository } from "../../lib/github";
import { appSlug, buildInstallUrl } from "../../lib/githubApp";

/**
 * Load the "Add repositories" modal data. A `"use server"` action is an
 * independently-invokable endpoint, so it re-checks the session itself rather than
 * trusting the page guard. A GitHub App can only review repos in accounts where it is
 * installed, so the source of truth is the installations: each installed account's
 * repos (private included) become a reviewable group, and the user's orgs without an
 * installation become install/request targets. A 401 anywhere returns
 * `{ error: "reauth" }`; an org-membership read that fails for a non-auth reason just
 * means no install cards; one installation's transient failure degrades only its group.
 */
export async function loadAddableRepos(): Promise<AddableReposResult> {
  const session = await getSession();
  if (!session) {
    return { error: "reauth" };
  }

  try {
    // Installations and org memberships are independent reads — fetch together.
    // Memberships degrade gracefully (a GitHub-App user token may lack the read):
    // a non-auth failure yields no install cards; a 401 still re-surfaces as reauth.
    const [installations, memberships] = await Promise.all([
      session.github.listInstallations(),
      session.github.listUserMemberships().catch((err) => {
        if (err instanceof GitHubAuthError) {
          throw err;
        }
        return [];
      }),
    ]);

    // Fetch each installation's repos. A transient non-auth failure degrades just
    // that group (empty repos); auth and rate-limit re-throw so the modal can prompt
    // a retry rather than silently showing an installed account as empty.
    const reposByInstallationId = new Map<number, Repository[]>();
    const repoLists = await Promise.all(
      installations.map((installation) =>
        session.github.listInstallationRepositories(installation.id).catch((err) => {
          if (err instanceof GitHubAuthError || err instanceof GitHubRateLimitError) {
            throw err;
          }
          return [];
        }),
      ),
    );
    installations.forEach((installation, i) => {
      reposByInstallationId.set(installation.id, repoLists[i]);
    });

    return {
      groups: buildAddableGroups(installations, reposByInstallationId),
      installableTargets: computeInstallableTargets(memberships, session.login, installations),
      installNewUrl: buildInstallUrl(appSlug()),
    };
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return { error: "reauth" };
    }
    throw err;
  }
}

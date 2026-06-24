"use server";

import { type AddableReposResult, buildAddableGroups } from "../../lib/addableRepos";
import { getSession } from "../../lib/auth/session";
import { GitHubAuthError } from "../../lib/github";
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
    const installations = await session.github.listInstallations();
    const [accessible, ...installedLists] = await Promise.all([
      session.github.listAccessibleRepositories(),
      ...installations.map((installation) =>
        // Per-installation failures must not sink the whole modal: a non-auth
        // failure for one account just means its repos aren't marked "added".
        session.github
          .listInstallationRepositories(installation.id)
          .catch((err) => {
            if (err instanceof GitHubAuthError) {
              throw err;
            }
            return [];
          }),
      ),
    ]);

    const installedFullNames = new Set<string>();
    for (const list of installedLists) {
      for (const repo of list) {
        installedFullNames.add(repo.fullName);
      }
    }

    const slug = appSlug();
    return {
      groups: buildAddableGroups(accessible, installedFullNames, installations, slug),
      installNewUrl: buildInstallUrl(slug),
    };
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return { error: "reauth" };
    }
    throw err;
  }
}

/**
 * GitHub App identity helpers for the "Add repositories" flow. Adding a repo to
 * diffsense means installing/configuring the GitHub App on it — only GitHub's
 * installation UI can grant the App access, so the modal routes the user there.
 *
 * The App *slug* (its public handle, e.g. `diffsense`) is what those install URLs
 * are keyed on. Unlike `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` it is not a secret —
 * it appears verbatim in every public install link — so it is safe to surface in
 * URLs handed to the browser. Read at request time (never module load) to match the
 * fail-at-request posture of `loadAuthConfig`.
 */

const APPS_BASE = "https://github.com/apps";

/** Read the configured App slug, or throw a clear error when it is unset. */
export function appSlug(env: NodeJS.ProcessEnv = process.env): string {
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!slug) {
    throw new Error("Missing GITHUB_APP_SLUG (the GitHub App's public slug, e.g. `diffsense`)");
  }
  return slug;
}

/**
 * Build the GitHub installation URL the reviewer is sent to in order to grant the
 * App access. With an `accountId` it targets that specific account's repo-selection
 * screen; without one it opens the generic "pick an account" install page.
 */
export function buildInstallUrl(slug: string, opts: { accountId?: number } = {}): string {
  if (typeof opts.accountId === "number") {
    return `${APPS_BASE}/${slug}/installations/new/permissions?target_id=${opts.accountId}`;
  }
  return `${APPS_BASE}/${slug}/installations/new`;
}

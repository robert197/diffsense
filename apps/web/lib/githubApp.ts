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
 * The canonical "install / configure this App" URL. GitHub routes it correctly in
 * every case: pick an account to install on, add repos to an existing installation,
 * or configure the account that already has it.
 *
 * We deliberately do NOT build a per-account `…/installations/new/permissions?target_id=`
 * deep link. That shape 404s in common cases — when the App is already installed on
 * the target account, or without a matching `target_type` — and the chicken-and-egg
 * it was meant to solve (pre-selecting an org) is handled fine by the generic page:
 * GitHub lists exactly the accounts the user can install on, including new orgs. A
 * working generic link beats a convenient link that 404s.
 */
export function buildInstallUrl(slug: string): string {
  return `${APPS_BASE}/${slug}/installations/new`;
}

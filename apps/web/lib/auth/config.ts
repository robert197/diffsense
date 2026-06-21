/**
 * Auth configuration for the reviewer entry path (issue #25), validated from env
 * (fail fast). Secrets only ever come from the environment — never from code or
 * the request (CLAUDE.md / docs/STACK.md self-host rule).
 *
 * Uses the GitHub App's user-authorization (OAuth) flow: the App's own
 * `client_id` / `client_secret` (distinct from `GITHUB_APP_ID` /
 * `GITHUB_PRIVATE_KEY`) mint a user-to-server token, which can read the
 * installations and repos that user can access.
 *
 * Validation runs at request time inside the route handlers, not at module load,
 * so `next build` and importing this module never require the secrets to be set.
 */

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  /** Public base URL of the web app, used to build the OAuth redirect URI. */
  webBaseUrl: string;
  /** `true` in production so cookies carry the `Secure` flag. */
  secureCookies: boolean;
}

const REQUIRED: Array<[keyof Omit<AuthConfig, "secureCookies">, string]> = [
  ["clientId", "GITHUB_OAUTH_CLIENT_ID"],
  ["clientSecret", "GITHUB_OAUTH_CLIENT_SECRET"],
  ["sessionSecret", "SESSION_SECRET"],
  ["webBaseUrl", "WEB_BASE_URL"],
];

/** Load and validate the auth config, throwing a single aggregated error. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const values = {
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    webBaseUrl: env.WEB_BASE_URL,
  };

  const missing = REQUIRED.filter(([key]) => !values[key]?.trim()).map(([, envName]) => envName);
  if (missing.length > 0) {
    throw new Error(`Missing required auth env: ${missing.join(", ")}`);
  }

  return {
    clientId: values.clientId as string,
    clientSecret: values.clientSecret as string,
    sessionSecret: values.sessionSecret as string,
    webBaseUrl: stripTrailingSlash(values.webBaseUrl as string),
    secureCookies: env.NODE_ENV === "production",
  };
}

/** The OAuth callback URL — must exactly match the GitHub App's registered URL. */
export function redirectUri(config: AuthConfig): string {
  return `${config.webBaseUrl}/api/auth/callback`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

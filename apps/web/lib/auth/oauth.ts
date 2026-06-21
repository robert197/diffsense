/**
 * GitHub App user-authorization (OAuth) flow (issue #25). The web app sends the
 * reviewer to GitHub to authorize, then exchanges the returned code for a
 * user-to-server access token. Pure URL building + response parsing live here;
 * the single network call (`fetch`) is injectable so the logic is unit-testable.
 *
 * GitHub Apps ignore the `scope` param — access is governed by the App's
 * configured permissions and the installations the user can reach.
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export type FetchLike = typeof globalThis.fetch;

export interface OAuthTokens {
  accessToken: string;
  /** Present only when the App issues expiring user tokens. */
  refreshToken?: string;
  /** Seconds until the access token expires, when expiring tokens are enabled. */
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
}

/** Build the GitHub authorize URL the reviewer is redirected to. */
export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Parse the token-endpoint JSON. GitHub returns `200` with an `error` field on
 * failure (e.g. `bad_verification_code`), so a thrown error here means "do not
 * trust this response", not necessarily a transport failure.
 */
export function parseTokenResponse(body: unknown): OAuthTokens {
  if (!body || typeof body !== "object") {
    throw new Error("unexpected token response");
  }
  const data = body as Record<string, unknown>;
  if (typeof data.error === "string") {
    throw new Error(`github oauth error: ${data.error}`);
  }
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("token response missing access_token");
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresInSeconds: numberOrUndefined(data.expires_in),
    refreshTokenExpiresInSeconds: numberOrUndefined(data.refresh_token_expires_in),
  };
}

/** Exchange an authorization code for user-to-server tokens. */
export async function exchangeCodeForToken(
  params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<OAuthTokens> {
  return postForTokens(
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    },
    fetchImpl,
  );
}

/** Refresh an expiring user token using its refresh token. */
export async function refreshAccessToken(
  params: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<OAuthTokens> {
  return postForTokens(
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    },
    fetchImpl,
  );
}

async function postForTokens(
  payload: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<OAuthTokens> {
  const res = await fetchImpl(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`token endpoint returned ${res.status}`);
  }
  return parseTokenResponse(await res.json());
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

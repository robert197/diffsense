/**
 * Minimal GitHub REST client for the reviewer entry path (issue #25). Bound to a
 * user-to-server access token, it reads the identity, the App installations and
 * repos the user can access, and a repo's open PRs. Plain `fetch` (injectable for
 * tests) instead of Octokit — this slice needs four read calls, and `apps/web`
 * keeps its dependency surface minimal. GitHub is the product's domain, so a
 * GitHub-specific client here does not touch the provider-agnostic (LLM) rule.
 */

import type { FetchLike } from "./auth/oauth";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PER_PAGE = 100;
// Bound pagination so a huge installation can't loop unbounded. Repos beyond
// MAX_PAGES * PER_PAGE are not shown this slice; a fuller pagination UI is deferred.
const MAX_PAGES = 5;
const OPEN_PR_PER_PAGE = 100;
// Per-request deadline. `fetch` has no default timeout, so a stalled GitHub
// connection would otherwise hang a server render (and its worker) indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

/** Thrown when GitHub rejects the token (401) — the caller clears the session. */
export class GitHubAuthError extends Error {
  constructor(message = "github authentication failed") {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/**
 * Thrown when GitHub rate-limits the token (403/429 with the rate-limit signal).
 * Distinct from a generic failure so the UI can show a "try again shortly"
 * message instead of an opaque error.
 */
export class GitHubRateLimitError extends Error {
  constructor(message = "github rate limit exceeded") {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface Installation {
  id: number;
  account: string;
  avatarUrl: string | null;
  accountType: string;
}

export interface Repository {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  pushedAt: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string | null;
  updatedAt: string;
  draft: boolean;
  url: string;
}

export interface GitHubClient {
  getAuthenticatedUser(): Promise<GitHubUser>;
  listInstallations(): Promise<Installation[]>;
  listInstallationRepositories(installationId: number): Promise<Repository[]>;
  listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>;
  /**
   * Raw text of a file at a specific commit, or `null` when it cannot be shown as
   * code (absent at that ref, a directory, or binary). The swipe deck (#27) uses
   * this to render the highlighted lines a card points at, fetched at the deck's
   * head SHA so the card's absolute line numbers line up.
   */
  getFileAtRef(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
}

/** Construct a token-bound GitHub client. `fetchImpl` is injectable for tests. */
export function createGitHubClient(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): GitHubClient {
  async function get(path: string): Promise<unknown> {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new GitHubAuthError();
    }
    if (isRateLimited(res)) {
      throw new GitHubRateLimitError(`github ${path} rate limited (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`github ${path} returned ${res.status}`);
    }
    return res.json();
  }

  return {
    async getAuthenticatedUser(): Promise<GitHubUser> {
      return mapUser(await get("/user"));
    },

    async listInstallations(): Promise<Installation[]> {
      const out: Installation[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = asRecord(await get(`/user/installations?per_page=${PER_PAGE}&page=${page}`));
        const items = asArray(body.installations);
        out.push(...items.map(mapInstallation));
        if (items.length < PER_PAGE) {
          break;
        }
      }
      return out;
    },

    async listInstallationRepositories(installationId: number): Promise<Repository[]> {
      const out: Repository[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = asRecord(
          await get(
            `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
          ),
        );
        const items = asArray(body.repositories);
        out.push(...items.map(mapRepository));
        if (items.length < PER_PAGE) {
          break;
        }
      }
      return out;
    },

    async listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/pulls?state=open&sort=updated&direction=desc&per_page=${OPEN_PR_PER_PAGE}`;
      const out: PullRequest[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const items = asArray(await get(`${base}&page=${page}`));
        out.push(...items.map(mapPullRequest));
        if (items.length < OPEN_PR_PER_PAGE) {
          break;
        }
      }
      return out;
    },

    async getFileAtRef(
      owner: string,
      repo: string,
      path: string,
      ref: string,
    ): Promise<string | null> {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetchImpl(
        `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            // Raw media type returns the file bytes directly, not the JSON envelope.
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": API_VERSION,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      if (isRateLimited(res)) {
        throw new GitHubRateLimitError(`github contents/${path} rate limited (${res.status})`);
      }
      // Any other failure (404 absent, 403 denied, directory, 5xx) is non-fatal —
      // the card degrades to its highlight ranges rather than breaking the deck.
      if (!res.ok) {
        return null;
      }
      const body = await res.text();
      // A NUL byte means binary content that cannot be shown as source lines.
      return body.includes("\u0000") ? null : body;
    },
  };
}

/**
 * GitHub signals rate limiting with 429, or 403 plus an exhausted rate-limit
 * budget / a Retry-After. A plain 403 (genuine permission denial) is not treated
 * as rate limiting.
 */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) {
    return true;
  }
  if (res.status !== 403) {
    return false;
  }
  return (
    res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"
  );
}

function mapUser(raw: unknown): GitHubUser {
  const data = asRecord(raw);
  const id = Number(data.id);
  const login = typeof data.login === "string" ? data.login : "";
  // The identity drives the session row (github_user_id is NOT NULL, login is
  // shown to the reviewer). A malformed /user response must fail loudly here
  // rather than insert a NaN id or an empty login downstream.
  if (!Number.isInteger(id) || login.length === 0) {
    throw new Error("github /user returned an unexpected identity shape");
  }
  return {
    id,
    login,
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}

function mapInstallation(raw: unknown): Installation {
  const data = asRecord(raw);
  const account = asRecord(data.account);
  return {
    id: Number(data.id),
    account: String(account.login ?? ""),
    avatarUrl: typeof account.avatar_url === "string" ? account.avatar_url : null,
    accountType: String(account.type ?? "User"),
  };
}

function mapRepository(raw: unknown): Repository {
  const data = asRecord(raw);
  const owner = asRecord(data.owner);
  return {
    owner: String(owner.login ?? ""),
    name: String(data.name ?? ""),
    fullName: String(data.full_name ?? ""),
    private: Boolean(data.private),
    pushedAt: typeof data.pushed_at === "string" ? data.pushed_at : null,
  };
}

function mapPullRequest(raw: unknown): PullRequest {
  const data = asRecord(raw);
  const user = asRecord(data.user);
  return {
    number: Number(data.number),
    title: String(data.title ?? ""),
    author: typeof user.login === "string" ? user.login : null,
    updatedAt: String(data.updated_at ?? ""),
    draft: Boolean(data.draft),
    url: String(data.html_url ?? ""),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Minimal GitHub REST client for the reviewer entry path (issue #25). Bound to a
 * user-to-server access token, it reads the identity, the App installations and
 * their repositories, the user's org memberships, a repo's open PRs / file content /
 * head SHA, and posts one comment. Plain `fetch` (injectable for tests) instead of
 * Octokit — `apps/web` keeps its dependency surface minimal. GitHub is the product's
 * domain, so a GitHub-specific client here does not touch the provider-agnostic
 * (LLM) rule.
 */

import type {
  GitHubGateway,
  GitHubPrRef,
  PostedComment,
  PrCommentAnchor,
  PrCommentInput,
} from "@diffsense/core";
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

/**
 * Thrown when GitHub rejects a write with a genuine 403 permission denial (a
 * reviewer without write access trying to comment), as distinct from a rate-limited
 * 403. Lets the comment action surface a clear "you don't have permission" message
 * instead of an opaque error (issue #30, AC#5).
 */
export class GitHubPermissionError extends Error {
  constructor(message = "github permission denied") {
    super(message);
    this.name = "GitHubPermissionError";
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
  /** `"all"` repos in the account, or only a `"selected"` subset. */
  repositorySelection: "all" | "selected";
  /** GitHub's configure page for this installation (add/remove repos), or `null`. */
  configureUrl: string | null;
}

/**
 * An organisation membership of the signed-in user (`GET /user/memberships/orgs`).
 * `role` decides whether they can install the App directly (`admin`) or only
 * *request* it from the org's owners (`member`). Backs the add-repositories modal's
 * Install/Request cards for orgs that don't yet have diffsense.
 */
export interface OrgMembership {
  login: string;
  role: "admin" | "member";
  state: string;
}

/**
 * Whether an account is a GitHub organisation (vs a personal user). GitHub's
 * `account.type` is a free string (`"Organization"` / `"User"`); centralise the
 * comparison so the repo picker and the add-repositories modal can't drift on
 * casing or the literal.
 */
export function isOrgAccount(accountType: string): boolean {
  return accountType.toLowerCase() === "organization";
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

/**
 * The web role's GitHub adapter. It implements the core `GitHubGateway` port
 * (`postComment`) so a reviewer can leave a PR comment from a card (issue #30) —
 * posted with *their* OAuth token, attributed to them, not the App. The read
 * methods below back the reviewer entry path; `GitHubGateway` adds the one write.
 */
export interface GitHubClient extends GitHubGateway {
  getAuthenticatedUser(): Promise<GitHubUser>;
  listInstallations(): Promise<Installation[]>;
  listInstallationRepositories(installationId: number): Promise<Repository[]>;
  /**
   * The organisations the signed-in user belongs to, with their role
   * (`GET /user/memberships/orgs`). Used to offer install/request targets in the
   * add-repositories modal: admins can install, members can only request.
   */
  listUserMemberships(): Promise<OrgMembership[]>;
  listOpenPullRequests(owner: string, repo: string): Promise<PullRequest[]>;
  /**
   * Raw text of a file at a specific commit, or `null` when it cannot be shown as
   * code (absent at that ref, a directory, or binary). The swipe deck (#27) uses
   * this to render the highlighted lines a card points at, fetched at the deck's
   * head SHA so the card's absolute line numbers line up.
   */
  getFileAtRef(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /**
   * The PR's current head commit SHA, or `null` when the PR no longer exists (404).
   * Pause & resume (#29) compares this live head against the deck's head SHA so a
   * reviewer resuming a deck built against an earlier commit is told it is stale.
   */
  getPullRequestHead(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ headSha: string } | null>;
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

  /**
   * POST helper for writes. Like `get`, it treats 401 and rate-limiting as the
   * universal fatal cases (thrown here); every other status is returned so the
   * caller can branch — `postComment` needs the raw 422 to fall back from an
   * anchored review comment to a conversation comment, and a 403 to map to a
   * permission error.
   */
  async function postJson(
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new GitHubAuthError();
    }
    if (isRateLimited(res)) {
      throw new GitHubRateLimitError(`github ${path} rate limited (${res.status})`);
    }
    const data = asRecord(await res.json().catch(() => ({})));
    return { ok: res.ok, status: res.status, data };
  }

  /** A general PR-conversation comment (the unanchored path + the 422 fallback). */
  async function postConversation(
    base: string,
    prNumber: number,
    body: string,
  ): Promise<PostedComment> {
    const issue = await postJson(`${base}/issues/${prNumber}/comments`, { body });
    if (!issue.ok) {
      throwPostError(issue.status, `issues/${prNumber}/comments`);
    }
    return mapPostedComment(issue.data, "issue");
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

    async listUserMemberships(): Promise<OrgMembership[]> {
      const out: OrgMembership[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const items = asArray(
          await get(`/user/memberships/orgs?per_page=${PER_PAGE}&page=${page}`),
        );
        out.push(...items.map(mapMembership));
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

    async getPullRequestHead(
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<{ headSha: string } | null> {
      const res = await fetchImpl(
        `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/pulls/${encodeURIComponent(String(prNumber))}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      // The PR was deleted/transferred — treat as "no live head" so the deck still
      // renders (staleness simply can't be determined) rather than erroring the page.
      if (res.status === 404) {
        return null;
      }
      if (isRateLimited(res)) {
        throw new GitHubRateLimitError(`github pulls/${prNumber} rate limited (${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`github pulls/${prNumber} returned ${res.status}`);
      }
      const head = asRecord(asRecord(await res.json()).head);
      const sha = typeof head.sha === "string" ? head.sha : "";
      return sha.length > 0 ? { headSha: sha } : null;
    },

    async postComment(ref: GitHubPrRef, input: PrCommentInput): Promise<PostedComment> {
      const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
      const { anchor } = input;

      // No anchor → a general PR-conversation comment.
      if (!anchor) {
        return postConversation(base, ref.prNumber, input.body);
      }

      // Anchored → a diff-anchored review comment on the card's file + lines.
      const reviewBody: Record<string, unknown> = {
        body: input.body,
        commit_id: anchor.commitId,
        path: anchor.file,
        line: anchor.line,
        side: anchor.side,
      };
      if (anchor.startLine !== undefined) {
        reviewBody.start_line = anchor.startLine;
        reviewBody.start_side = anchor.side;
      }
      const review = await postJson(`${base}/pulls/${ref.prNumber}/comments`, reviewBody);
      if (review.ok) {
        return mapPostedComment(review.data, "review");
      }
      // 422 = the line is not part of the diff for this commit. "Anchored where
      // possible" (AC): fall back to a conversation comment that references the
      // file/line so the reviewer's words are never lost to a positioning quirk.
      if (review.status !== 422) {
        throwPostError(review.status, `pulls/${ref.prNumber}/comments`);
      }
      return postConversation(base, ref.prNumber, withAnchorPrefix(input.body, anchor));
    },
  };
}

/** Prefix a fallback conversation comment with the file/line it was meant to anchor to. */
function withAnchorPrefix(body: string, anchor: PrCommentAnchor): string {
  const lines =
    anchor.startLine !== undefined
      ? `lines ${anchor.startLine}–${anchor.line}`
      : `line ${anchor.line}`;
  return `Re: \`${anchor.file}\` (added ${lines}):\n\n${body}`;
}

/** Map GitHub's create-comment response to a `PostedComment`, or fail loudly. */
function mapPostedComment(data: Record<string, unknown>, kind: "review" | "issue"): PostedComment {
  const id = Number(data.id);
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : "";
  if (!Number.isInteger(id) || htmlUrl.length === 0) {
    throw new Error("github create-comment returned an unexpected shape (missing id/html_url)");
  }
  return { id, htmlUrl, kind };
}

/**
 * Map a failed write status to a typed error. A 403 reaching here is a genuine
 * permission denial — a rate-limited 403 was already caught by `isRateLimited` in
 * `postJson` — so it becomes `GitHubPermissionError`; anything else is generic.
 */
function throwPostError(status: number, path: string): never {
  if (status === 403) {
    throw new GitHubPermissionError(`github ${path} forbidden (403)`);
  }
  throw new Error(`github ${path} returned ${status}`);
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
    repositorySelection: data.repository_selection === "selected" ? "selected" : "all",
    configureUrl: typeof data.html_url === "string" ? data.html_url : null,
  };
}

function mapMembership(raw: unknown): OrgMembership {
  const data = asRecord(raw);
  const org = asRecord(data.organization);
  return {
    login: String(org.login ?? ""),
    role: data.role === "admin" ? "admin" : "member",
    state: String(data.state ?? ""),
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

import { describe, expect, it, vi } from "vitest";
import {
  GitHubAuthError,
  GitHubPermissionError,
  GitHubRateLimitError,
  createGitHubClient,
} from "./github";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function repoPage(count: number, offset = 0) {
  return {
    total_count: 9999,
    repositories: Array.from({ length: count }, (_, i) => ({
      name: `r${offset + i}`,
      full_name: `acme/r${offset + i}`,
      private: false,
      pushed_at: null,
      owner: { login: "acme" },
    })),
  };
}

function prPage(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    number: offset + i,
    title: `pr ${offset + i}`,
    user: { login: "dev" },
    updated_at: "2026-06-20T10:00:00Z",
    draft: false,
    html_url: `https://github.com/acme/web/pull/${offset + i}`,
  }));
}

describe("createGitHubClient", () => {
  it("sends the bearer token and maps the authenticated user", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 42, login: "octocat", avatar_url: "https://a/octocat.png" }),
    );
    const client = createGitHubClient("gho_tok", fetchImpl as unknown as typeof fetch);
    const user = await client.getAuthenticatedUser();

    expect(user).toEqual({ id: 42, login: "octocat", avatarUrl: "https://a/octocat.png" });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_tok");
  });

  it("maps installations with account login/avatar/type", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        total_count: 1,
        installations: [
          {
            id: 7,
            account: { login: "acme", avatar_url: "https://a/acme.png", type: "Organization" },
          },
        ],
      }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.listInstallations()).toEqual([
      { id: 7, account: "acme", avatarUrl: "https://a/acme.png", accountType: "Organization" },
    ]);
  });

  it("follows a second page of installation repositories then stops", async () => {
    const firstPage = {
      total_count: 101,
      repositories: Array.from({ length: 100 }, (_, i) => ({
        name: `r${i}`,
        full_name: `acme/r${i}`,
        private: false,
        pushed_at: "2026-06-01T00:00:00Z",
        owner: { login: "acme" },
      })),
    };
    const secondPage = {
      total_count: 101,
      repositories: [
        {
          name: "r100",
          full_name: "acme/r100",
          private: true,
          pushed_at: null,
          owner: { login: "acme", id: 99 },
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const repos = await client.listInstallationRepositories(7);

    expect(repos).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repos[100]).toEqual({
      owner: "acme",
      ownerId: 99,
      name: "r100",
      fullName: "acme/r100",
      private: true,
      pushedAt: null,
    });
  });

  it("requests open PRs and maps number/title/author/draft", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          number: 3,
          title: "Fix bug",
          user: { login: "dev" },
          updated_at: "2026-06-20T10:00:00Z",
          draft: false,
          html_url: "https://github.com/acme/web/pull/3",
        },
      ]),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const prs = await client.listOpenPullRequests("acme", "web");

    expect(prs).toEqual([
      {
        number: 3,
        title: "Fix bug",
        author: "dev",
        updatedAt: "2026-06-20T10:00:00Z",
        draft: false,
        url: "https://github.com/acme/web/pull/3",
      },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toContain("state=open");
  });

  it("returns an empty list when a repo has no open PRs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.listOpenPullRequests("acme", "web")).toEqual([]);
  });

  it("stops paginating repositories at the MAX_PAGES cap (no unbounded loop)", async () => {
    // Every page is full (100) so the early `< PER_PAGE` break never fires; the
    // loop must stop at the 5-page ceiling rather than calling forever.
    const fetchImpl = vi.fn(async () => jsonResponse(repoPage(100)));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const repos = await client.listInstallationRepositories(7);

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(repos).toHaveLength(500);
  });

  it("paginates open PRs across pages and stops on a short page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(prPage(100)))
      .mockResolvedValueOnce(jsonResponse(prPage(2, 100)));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const prs = await client.listOpenPullRequests("acme", "web");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(prs).toHaveLength(102);
    expect(fetchImpl.mock.calls[0][0]).toContain("page=1");
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
  });

  it("throws GitHubAuthError on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getAuthenticatedUser()).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubRateLimitError on 429", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "slow down" }, 429));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listInstallations()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("treats a 403 with an exhausted rate-limit budget as rate limited", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listInstallations()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("treats a plain 403 (permission denial) as a generic error, not rate limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const err = await client.listInstallations().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect(err).not.toBeInstanceOf(GitHubAuthError);
  });

  it("throws a generic error on 500", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listInstallations()).rejects.toThrow(/500/);
  });

  it("rejects a malformed identity response (missing numeric id)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ login: "octocat" }));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getAuthenticatedUser()).rejects.toThrow(/identity/);
  });

  it("lists accessible repositories from /user/repos and maps owner/private/fullName", async () => {
    // /user/repos returns a bare array (not the {repositories:[…]} envelope the
    // installation endpoint uses), so the mapper must read the array directly.
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          name: "web",
          full_name: "acme/web",
          private: true,
          pushed_at: null,
          owner: { login: "acme", id: 1 },
        },
        {
          name: "site",
          full_name: "octocat/site",
          private: false,
          pushed_at: null,
          owner: { login: "octocat", id: 2 },
        },
      ]),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const repos = await client.listAccessibleRepositories();

    expect(fetchImpl.mock.calls[0][0]).toContain("/user/repos");
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "affiliation=owner,collaborator,organization_member",
    );
    expect(repos).toEqual([
      {
        owner: "acme",
        ownerId: 1,
        name: "web",
        fullName: "acme/web",
        private: true,
        pushedAt: null,
      },
      {
        owner: "octocat",
        ownerId: 2,
        name: "site",
        fullName: "octocat/site",
        private: false,
        pushedAt: null,
      },
    ]);
  });

  it("paginates accessible repositories across pages and stops on a short page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(repoPage(100).repositories))
      .mockResolvedValueOnce(jsonResponse(repoPage(3, 100).repositories));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const repos = await client.listAccessibleRepositories();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repos).toHaveLength(103);
  });

  it("stops paginating accessible repositories at the MAX_PAGES cap", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(repoPage(100).repositories));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const repos = await client.listAccessibleRepositories();

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(repos).toHaveLength(500);
  });

  it("returns an empty list when the user can access no repositories", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.listAccessibleRepositories()).toEqual([]);
  });

  it("throws GitHubAuthError on 401 listing accessible repositories", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listAccessibleRepositories()).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubRateLimitError on a rate-limited 403 listing accessible repositories", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listAccessibleRepositories()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("lists the user's organisations from /user/orgs and maps login/id/avatar", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { login: "devs-group", id: 48035703, avatar_url: "https://a/dg.png" },
        { login: "acme", id: 7, avatar_url: null },
      ]),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const orgs = await client.listUserOrganizations();

    expect(fetchImpl.mock.calls[0][0]).toContain("/user/orgs");
    expect(orgs).toEqual([
      { login: "devs-group", id: 48035703, avatarUrl: "https://a/dg.png" },
      { login: "acme", id: 7, avatarUrl: null },
    ]);
  });

  it("paginates organisations across pages and stops on a short page", async () => {
    const orgPage = (n: number, offset = 0) =>
      Array.from({ length: n }, (_, i) => ({ login: `o${offset + i}`, id: offset + i }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(orgPage(100)))
      .mockResolvedValueOnce(jsonResponse(orgPage(2, 100)));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const orgs = await client.listUserOrganizations();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(orgs).toHaveLength(102);
  });

  it("stops paginating organisations at the MAX_PAGES cap", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ login: `o${i}`, id: i }));
    const fetchImpl = vi.fn(async () => jsonResponse(fullPage));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const orgs = await client.listUserOrganizations();

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(orgs).toHaveLength(500);
  });

  it("returns an empty list when the user belongs to no organisations", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.listUserOrganizations()).toEqual([]);
  });

  it("throws GitHubAuthError on 401 listing organisations", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listUserOrganizations()).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubRateLimitError on a rate-limited 403 listing organisations", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.listUserOrganizations()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});

function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", ...headers } });
}

describe("getFileAtRef", () => {
  it("returns the raw file text and requests the raw media type at the ref", async () => {
    const fetchImpl = vi.fn(async () => textResponse("line1\nline2\n"));
    const client = createGitHubClient("gho_tok", fetchImpl as unknown as typeof fetch);

    const text = await client.getFileAtRef("acme", "web", "src/a.ts", "abc123");

    expect(text).toBe("line1\nline2\n");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/repos/acme/web/contents/src/a.ts?ref=abc123");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_tok");
    expect(headers.Accept).toBe("application/vnd.github.raw+json");
  });

  it("returns null when the file is absent at the ref (404)", async () => {
    const fetchImpl = vi.fn(async () => textResponse("Not Found", 404));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.getFileAtRef("acme", "web", "gone.ts", "sha")).toBeNull();
  });

  it("throws GitHubAuthError on 401", async () => {
    const fetchImpl = vi.fn(async () => textResponse("", 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getFileAtRef("acme", "web", "a.ts", "sha")).rejects.toBeInstanceOf(
      GitHubAuthError,
    );
  });

  it("throws GitHubRateLimitError on 403 with rate-limit headers", async () => {
    const fetchImpl = vi.fn(async () => textResponse("", 403, { "x-ratelimit-remaining": "0" }));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getFileAtRef("acme", "web", "a.ts", "sha")).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it("percent-encodes path segments and the ref", async () => {
    const fetchImpl = vi.fn(async () => textResponse("x"));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await client.getFileAtRef("acme", "web", "src/a b/файл.ts", "feature/x");
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/contents/src/a%20b/%D1%84%D0%B0%D0%B9%D0%BB.ts");
    expect(url).toContain("?ref=feature%2Fx");
  });

  it("returns null for binary content (contains a NUL byte)", async () => {
    const fetchImpl = vi.fn(async () => textResponse(`PNG${String.fromCharCode(0)}binary`));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.getFileAtRef("acme", "web", "logo.png", "sha")).toBeNull();
  });
});

describe("postComment", () => {
  const ref = { owner: "acme", repo: "web", prNumber: 7 };
  const anchor = {
    file: "src/a.ts",
    line: 18,
    startLine: 12,
    side: "RIGHT" as const,
    commitId: "sha1",
  };

  function created(id: number, url: string): Response {
    return jsonResponse({ id, html_url: url }, 201);
  }

  it("posts an anchored review comment to pulls/{n}/comments with the diff fields", async () => {
    const fetchImpl = vi.fn(async () =>
      created(101, "https://github.com/acme/web/pull/7#discussion_r101"),
    );
    const client = createGitHubClient("gho_tok", fetchImpl as unknown as typeof fetch);

    const posted = await client.postComment(ref, { body: "Looks off here.", anchor });

    expect(posted).toEqual({
      id: 101,
      htmlUrl: "https://github.com/acme/web/pull/7#discussion_r101",
      kind: "review",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/repos/acme/web/pulls/7/comments");
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({
      body: "Looks off here.",
      commit_id: "sha1",
      path: "src/a.ts",
      line: 18,
      side: "RIGHT",
      start_line: 12,
      start_side: "RIGHT",
    });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_tok");
  });

  it("posts an unanchored comment to issues/{n}/comments", async () => {
    const fetchImpl = vi.fn(async () =>
      created(202, "https://github.com/acme/web/pull/7#issuecomment-202"),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);

    const posted = await client.postComment(ref, { body: "General note." });

    expect(posted.kind).toBe("issue");
    expect(posted.id).toBe(202);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/repos/acme/web/issues/7/comments");
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).toEqual({
      body: "General note.",
    });
  });

  it("falls back to a conversation comment when the anchored post 422s (line not in diff)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "line must be part of the diff" }, 422))
      .mockResolvedValueOnce(created(303, "https://github.com/acme/web/pull/7#issuecomment-303"));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);

    const posted = await client.postComment(ref, { body: "Off here.", anchor });

    expect(posted.kind).toBe("issue");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call attempted the review comment, second fell back to the issue comment.
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/pulls/7/comments");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/issues/7/comments");
    // The fallback body references the file/line it was meant to anchor to.
    const fallback = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body)).body;
    expect(fallback).toContain("Re: `src/a.ts`");
    expect(fallback).toContain("lines 12–18");
    expect(fallback).toContain("Off here.");
  });

  it("throws GitHubPermissionError on a plain 403 (write access denied)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Resource not accessible" }, 403));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.postComment(ref, { body: "x" })).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it("throws GitHubRateLimitError on a rate-limited 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.postComment(ref, { body: "x" })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it("throws GitHubAuthError on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.postComment(ref, { body: "x" })).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws a generic error on a 500 from the review-comment endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.postComment(ref, { body: "x", anchor })).rejects.toThrow(/500/);
  });
});

describe("getPullRequestHead", () => {
  it("returns the PR's current head SHA from the pulls endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 7, head: { sha: "deadbeef" } }));
    const client = createGitHubClient("gho_tok", fetchImpl as unknown as typeof fetch);

    expect(await client.getPullRequestHead("acme", "web", 7)).toEqual({ headSha: "deadbeef" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/repos/acme/web/pulls/7");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_tok");
  });

  it("returns null when the PR no longer exists (404)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.getPullRequestHead("acme", "web", 9)).toBeNull();
  });

  it("returns null when the head SHA is missing from the response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 7, head: {} }));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    expect(await client.getPullRequestHead("acme", "web", 7)).toBeNull();
  });

  it("throws GitHubAuthError on 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getPullRequestHead("acme", "web", 7)).rejects.toBeInstanceOf(
      GitHubAuthError,
    );
  });

  it("throws GitHubRateLimitError on a rate-limited 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
    );
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getPullRequestHead("acme", "web", 7)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it("throws a generic error (not rate-limit) on a plain 403 permission denial", async () => {
    // resolveStaleDeck's catch must absorb this as a non-fatal "can't decide
    // staleness" rather than mistaking it for a rate limit or an auth failure.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    const err = await client.getPullRequestHead("acme", "web", 7).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect(err).not.toBeInstanceOf(GitHubAuthError);
  });

  it("throws a generic error on 500 (transient upstream failure)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    const client = createGitHubClient("t", fetchImpl as unknown as typeof fetch);
    await expect(client.getPullRequestHead("acme", "web", 7)).rejects.toThrow(/500/);
  });
});

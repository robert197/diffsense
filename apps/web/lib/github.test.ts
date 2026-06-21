import { describe, expect, it, vi } from "vitest";
import { GitHubAuthError, GitHubRateLimitError, createGitHubClient } from "./github";

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
          owner: { login: "acme" },
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

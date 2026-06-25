import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAuthError, type GitHubClient, type PullRequest } from "../../../../../lib/github";

// The action re-checks the session itself; mock it so we can drive auth states.
const getSession = vi.fn();
vi.mock("../../../../../lib/auth/session", () => ({ getSession: () => getSession() }));

import { loadOpenPullRequests } from "./actions";

function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: "Add widget",
    author: "octocat",
    updatedAt: "2026-06-24T10:00:00Z",
    draft: false,
    url: "https://github.com/acme/web/pull/1",
    ...over,
  };
}

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listOpenPullRequests: vi.fn(async () => []),
    ...over,
  } as unknown as GitHubClient;
}

afterEach(() => {
  getSession.mockReset();
});

describe("loadOpenPullRequests", () => {
  it("returns { error: 'reauth' } when signed out", async () => {
    getSession.mockResolvedValue(null);
    expect(await loadOpenPullRequests("acme", "web")).toEqual({ error: "reauth" });
  });

  it("returns the open PRs for an authed session, owner/repo passed through", async () => {
    const listOpenPullRequests = vi.fn(async () => [pull({ number: 7 })]);
    getSession.mockResolvedValue({
      github: fakeClient({ listOpenPullRequests }),
      login: "octocat",
    });

    const result = await loadOpenPullRequests("acme", "web");
    if ("error" in result) throw new Error("expected pulls");
    expect(result.pulls).toEqual([pull({ number: 7 })]);
    expect(listOpenPullRequests).toHaveBeenCalledWith("acme", "web");
  });

  it("maps a 401 from listOpenPullRequests to { error: 'reauth' }", async () => {
    const github = fakeClient({
      listOpenPullRequests: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });
    expect(await loadOpenPullRequests("acme", "web")).toEqual({ error: "reauth" });
  });

  it("rethrows a non-auth error instead of faking an empty list", async () => {
    const github = fakeClient({
      listOpenPullRequests: vi.fn(async () => {
        throw new Error("transient 500");
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });
    await expect(loadOpenPullRequests("acme", "web")).rejects.toThrow("transient 500");
  });

  it("does not call GitHub for a blank owner or repo", async () => {
    const listOpenPullRequests = vi.fn(async () => []);
    getSession.mockResolvedValue({
      github: fakeClient({ listOpenPullRequests }),
      login: "octocat",
    });
    expect(await loadOpenPullRequests("", "web")).toEqual({ pulls: [] });
    expect(await loadOpenPullRequests("acme", "  ")).toEqual({ pulls: [] });
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    // The blank guard short-circuits before the session read — no wasted round-trip.
    expect(getSession).not.toHaveBeenCalled();
  });
});

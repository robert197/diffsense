import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAuthError, type GitHubClient, type Repository } from "../../lib/github";

// The action re-checks the session itself; mock it so we can drive auth states.
const getSession = vi.fn();
vi.mock("../../lib/auth/session", () => ({ getSession: () => getSession() }));

import { loadAddableRepos } from "./actions";

function repo(over: Partial<Repository> = {}): Repository {
  return {
    owner: "acme",
    ownerId: 10,
    name: "web",
    fullName: "acme/web",
    private: false,
    pushedAt: null,
    ...over,
  };
}

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listInstallations: vi.fn(async () => []),
    listAccessibleRepositories: vi.fn(async () => []),
    listInstallationRepositories: vi.fn(async () => []),
    ...over,
  } as unknown as GitHubClient;
}

beforeEach(() => {
  process.env.GITHUB_APP_SLUG = "diffsense";
});

afterEach(() => {
  getSession.mockReset();
  process.env.GITHUB_APP_SLUG = undefined;
});

describe("loadAddableRepos", () => {
  it("returns { error: 'reauth' } when signed out", async () => {
    getSession.mockResolvedValue(null);
    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("annotates accessible repos with installed state and groups them", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        { id: 7, account: "acme", avatarUrl: null, accountType: "Organization" },
      ]),
      listAccessibleRepositories: vi.fn(async () => [
        repo({ fullName: "acme/web", name: "web" }),
        repo({ fullName: "acme/api", name: "api" }),
      ]),
      listInstallationRepositories: vi.fn(async () => [
        repo({ fullName: "acme/api", name: "api" }),
      ]),
    });
    getSession.mockResolvedValue({ github });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.groups).toHaveLength(1);
    const repos = result.groups[0].repos;
    expect(repos.find((r) => r.name === "api")?.added).toBe(true);
    expect(repos.find((r) => r.name === "web")?.added).toBe(false);
  });

  it("degrades a single installation's non-auth failure to 'not added' (no throw)", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        { id: 7, account: "acme", avatarUrl: null, accountType: "Organization" },
      ]),
      listAccessibleRepositories: vi.fn(async () => [repo({ fullName: "acme/web" })]),
      listInstallationRepositories: vi.fn(async () => {
        throw new Error("transient 500");
      }),
    });
    getSession.mockResolvedValue({ github });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.groups[0].repos[0].added).toBe(false);
  });

  it("returns { error: 'reauth' } when listing accessible repos hits a 401", async () => {
    const github = fakeClient({
      listAccessibleRepositories: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("returns empty groups and a generic install URL when the user can access no repos", async () => {
    getSession.mockResolvedValue({ github: fakeClient() });
    expect(await loadAddableRepos()).toEqual({
      groups: [],
      installNewUrl: "https://github.com/apps/diffsense/installations/new",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAuthError,
  type GitHubClient,
  GitHubRateLimitError,
  type Repository,
} from "../../lib/github";

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
    listUserOrganizations: vi.fn(async () => []),
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

  it("returns { error: 'reauth' } when listInstallations hits a 401", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("returns { error: 'reauth' } when a per-installation fetch hits a 401", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        { id: 7, account: "acme", avatarUrl: null, accountType: "Organization" },
      ]),
      listAccessibleRepositories: vi.fn(async () => [repo({ fullName: "acme/web" })]),
      listInstallationRepositories: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("propagates a per-installation rate-limit instead of silently marking repos not-added", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        { id: 7, account: "acme", avatarUrl: null, accountType: "Organization" },
      ]),
      listAccessibleRepositories: vi.fn(async () => [repo({ fullName: "acme/web" })]),
      listInstallationRepositories: vi.fn(async () => {
        throw new GitHubRateLimitError();
      }),
    });
    getSession.mockResolvedValue({ github });

    await expect(loadAddableRepos()).rejects.toBeInstanceOf(GitHubRateLimitError);
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
    getSession.mockResolvedValue({ github: fakeClient(), login: "octocat" });
    expect(await loadAddableRepos()).toEqual({
      groups: [],
      installableTargets: [{ account: "octocat", accountType: "User" }],
      installNewUrl: "https://github.com/apps/diffsense/installations/new",
    });
  });

  it("surfaces orgs without an installation as installable targets", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        { id: 7, account: "acme", avatarUrl: null, accountType: "Organization" },
      ]),
      listUserOrganizations: vi.fn(async () => [
        { login: "devs-group", id: 48035703, avatarUrl: null },
        { login: "acme", id: 7, avatarUrl: null },
      ]),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    // acme is already installed → excluded; devs-group + personal remain.
    expect(result.installableTargets).toEqual([
      { account: "devs-group", accountType: "Organization" },
      { account: "octocat", accountType: "User" },
    ]);
  });

  it("degrades to no install targets when listUserOrganizations fails (non-auth)", async () => {
    const github = fakeClient({
      listUserOrganizations: vi.fn(async () => {
        throw new Error("403 members read");
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    // Personal account still offered; org listing simply contributed nothing.
    expect(result.installableTargets).toEqual([{ account: "octocat", accountType: "User" }]);
  });

  it("returns { error: 'reauth' } when listUserOrganizations hits a 401", async () => {
    const github = fakeClient({
      listUserOrganizations: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });
});

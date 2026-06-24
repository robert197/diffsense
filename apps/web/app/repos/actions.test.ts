import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAuthError,
  type GitHubClient,
  GitHubRateLimitError,
  type Installation,
  type Repository,
} from "../../lib/github";

// The action re-checks the session itself; mock it so we can drive auth states.
const getSession = vi.fn();
vi.mock("../../lib/auth/session", () => ({ getSession: () => getSession() }));

import { loadAddableRepos } from "./actions";

function repo(over: Partial<Repository> = {}): Repository {
  return {
    owner: "acme",
    name: "web",
    fullName: "acme/web",
    private: false,
    pushedAt: null,
    ...over,
  };
}

function installation(over: Partial<Installation> = {}): Installation {
  return {
    id: 7,
    account: "acme",
    avatarUrl: null,
    accountType: "Organization",
    repositorySelection: "all",
    configureUrl: "https://github.com/organizations/acme/settings/installations/7",
    ...over,
  };
}

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listInstallations: vi.fn(async () => []),
    listInstallationRepositories: vi.fn(async () => []),
    listUserMemberships: vi.fn(async () => []),
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

  it("builds a group from an installation's repos", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [installation({ id: 7, account: "acme" })]),
      listInstallationRepositories: vi.fn(async () => [
        repo({ fullName: "acme/web", name: "web" }),
        repo({ fullName: "acme/secret", name: "secret", private: true }),
      ]),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].account).toBe("acme");
    expect(result.groups[0].repos.map((r) => r.name).sort()).toEqual(["secret", "web"]);
  });

  it("sets manageUrl on a group whose installation is 'selected'", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [
        installation({ id: 7, account: "acme", repositorySelection: "selected" }),
      ]),
      listInstallationRepositories: vi.fn(async () => [repo({ fullName: "acme/web" })]),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.groups[0].manageUrl).toBe(
      "https://github.com/organizations/acme/settings/installations/7",
    );
  });

  it("labels admin orgs install and member orgs request among installable targets", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [installation({ id: 7, account: "acme" })]),
      listUserMemberships: vi.fn(async () => [
        { login: "devs-group", role: "member" as const, state: "active" },
        { login: "owned-org", role: "admin" as const, state: "active" },
        { login: "acme", role: "admin" as const, state: "active" },
      ]),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    // acme already installed → excluded; member -> request, admin -> install.
    expect(result.installableTargets).toEqual([
      { account: "devs-group", accountType: "Organization", installType: "request" },
      { account: "octocat", accountType: "User", installType: "install" },
      { account: "owned-org", accountType: "Organization", installType: "install" },
    ]);
  });

  it("degrades to no install targets when listUserMemberships fails (non-auth)", async () => {
    const github = fakeClient({
      listUserMemberships: vi.fn(async () => {
        throw new Error("403 members read");
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.installableTargets).toEqual([
      { account: "octocat", accountType: "User", installType: "install" },
    ]);
  });

  it("absorbs a rate-limit from listUserMemberships (degrade, don't reauth or throw)", async () => {
    const github = fakeClient({
      listUserMemberships: vi.fn(async () => {
        throw new GitHubRateLimitError();
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups, not reauth");
    expect(result.installableTargets).toEqual([
      { account: "octocat", accountType: "User", installType: "install" },
    ]);
  });

  it("returns { error: 'reauth' } when listUserMemberships hits a 401", async () => {
    const github = fakeClient({
      listUserMemberships: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("returns { error: 'reauth' } when listInstallations hits a 401", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => {
        throw new GitHubAuthError();
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    expect(await loadAddableRepos()).toEqual({ error: "reauth" });
  });

  it("degrades a single installation's non-auth repo-fetch failure to an empty group", async () => {
    const github = fakeClient({
      listInstallations: vi.fn(async () => [installation({ id: 7, account: "acme" })]),
      listInstallationRepositories: vi.fn(async () => {
        throw new Error("transient 500");
      }),
    });
    getSession.mockResolvedValue({ github, login: "octocat" });

    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.groups[0].repos).toEqual([]);
  });

  it("always includes a generic install URL", async () => {
    getSession.mockResolvedValue({ github: fakeClient(), login: "octocat" });
    const result = await loadAddableRepos();
    if ("error" in result) throw new Error("expected groups");
    expect(result.installNewUrl).toBe("https://github.com/apps/diffsense/installations/new");
  });
});

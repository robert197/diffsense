import { describe, expect, it } from "vitest";
import { buildAddableGroups, computeInstallableTargets } from "./addableRepos";
import type { Installation, OrgMembership, Repository } from "./github";

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
    id: 1,
    account: "acme",
    avatarUrl: null,
    accountType: "Organization",
    repositorySelection: "all",
    configureUrl: "https://github.com/organizations/acme/settings/installations/1",
    ...over,
  };
}

function membership(login: string, role: "admin" | "member"): OrgMembership {
  return { login, role, state: "active" };
}

describe("buildAddableGroups", () => {
  it("builds one group per installation from its repos (private preserved)", () => {
    const inst = installation({ id: 7, account: "acme" });
    const repos = new Map([
      [
        7,
        [
          repo({ fullName: "acme/web", name: "web" }),
          repo({ fullName: "acme/secret", name: "secret", private: true }),
        ],
      ],
    ]);
    const groups = buildAddableGroups([inst], repos);
    expect(groups).toHaveLength(1);
    expect(groups[0].account).toBe("acme");
    expect(groups[0].repos.map((r) => r.name)).toEqual(["web", "secret"]);
    expect(groups[0].repos.find((r) => r.name === "secret")?.private).toBe(true);
  });

  it("sets manageUrl only for a 'selected' installation", () => {
    const all = installation({ id: 1, account: "all-org", repositorySelection: "all" });
    const selected = installation({
      id: 2,
      account: "sel-org",
      repositorySelection: "selected",
      configureUrl: "https://github.com/organizations/sel-org/settings/installations/2",
    });
    const groups = buildAddableGroups([all, selected], new Map());
    expect(groups.find((g) => g.account === "all-org")?.manageUrl).toBeNull();
    expect(groups.find((g) => g.account === "sel-org")?.manageUrl).toBe(
      "https://github.com/organizations/sel-org/settings/installations/2",
    );
  });

  it("sorts repos most-recently-pushed first and groups alphabetically", () => {
    const groups = buildAddableGroups(
      [installation({ id: 1, account: "zeta" }), installation({ id: 2, account: "alpha" })],
      new Map([
        [
          1,
          [
            repo({ fullName: "zeta/old", name: "old", pushedAt: "2026-01-01T00:00:00Z" }),
            repo({ fullName: "zeta/new", name: "new", pushedAt: "2026-06-01T00:00:00Z" }),
          ],
        ],
      ]),
    );
    expect(groups.map((g) => g.account)).toEqual(["alpha", "zeta"]);
    expect(groups.find((g) => g.account === "zeta")?.repos.map((r) => r.name)).toEqual([
      "new",
      "old",
    ]);
  });

  it("returns a group with no repos when an installation has none fetched", () => {
    const groups = buildAddableGroups([installation({ id: 1, account: "acme" })], new Map());
    expect(groups[0].repos).toEqual([]);
  });
});

describe("computeInstallableTargets", () => {
  it("labels admin orgs install and member orgs request; personal is install", () => {
    const targets = computeInstallableTargets(
      [membership("devs-group", "member"), membership("acme", "admin")],
      "octocat",
      [],
    );
    expect(targets).toEqual([
      { account: "acme", accountType: "Organization", installType: "install" },
      { account: "devs-group", accountType: "Organization", installType: "request" },
      { account: "octocat", accountType: "User", installType: "install" },
    ]);
  });

  it("excludes an org that already has an installation (case-insensitive), keeps personal", () => {
    const targets = computeInstallableTargets([membership("Devs-Group", "member")], "octocat", [
      installation({ account: "devs-group" }),
    ]);
    // Devs-Group is installed as devs-group → dropped; personal octocat remains.
    expect(targets.map((t) => t.account)).toEqual(["octocat"]);
  });

  it("returns empty when no memberships and personal is installed", () => {
    expect(
      computeInstallableTargets([], "octocat", [installation({ account: "octocat" })]),
    ).toEqual([]);
  });

  it("omits the personal account when the login is blank", () => {
    expect(computeInstallableTargets([], "", [])).toEqual([]);
  });
});

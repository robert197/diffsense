import { describe, expect, it } from "vitest";
import { buildAddableGroups } from "./addableRepos";
import type { Installation, Repository } from "./github";

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

function installation(over: Partial<Installation> = {}): Installation {
  return { id: 1, account: "acme", avatarUrl: null, accountType: "Organization", ...over };
}

const SLUG = "diffsense";

describe("buildAddableGroups", () => {
  it("marks a repo added only when it is in the installed set", () => {
    const groups = buildAddableGroups(
      [repo({ fullName: "acme/web", name: "web" }), repo({ fullName: "acme/api", name: "api" })],
      new Set(["acme/api"]),
      [installation()],
      SLUG,
    );
    const repos = groups[0].repos;
    expect(repos.find((r) => r.name === "api")?.added).toBe(true);
    expect(repos.find((r) => r.name === "web")?.added).toBe(false);
  });

  it("groups repos by account and resolves accountType from the installation", () => {
    const groups = buildAddableGroups(
      [
        repo({ owner: "acme", ownerId: 10, fullName: "acme/web", name: "web" }),
        repo({ owner: "octocat", ownerId: 20, fullName: "octocat/site", name: "site" }),
      ],
      new Set(),
      [installation({ account: "acme", accountType: "Organization" })],
      SLUG,
    );
    const acme = groups.find((g) => g.account === "acme");
    const octocat = groups.find((g) => g.account === "octocat");
    expect(acme?.accountType).toBe("Organization");
    // No installation for octocat → defaults to User.
    expect(octocat?.accountType).toBe("User");
  });

  it("uses the canonical install URL for every account group", () => {
    const groups = buildAddableGroups(
      [
        repo({ owner: "acme", ownerId: 555, fullName: "acme/web" }),
        repo({ owner: "octocat", ownerId: null, fullName: "octocat/site" }),
      ],
      new Set(),
      [],
      SLUG,
    );
    for (const group of groups) {
      expect(group.installUrl).toBe("https://github.com/apps/diffsense/installations/new");
    }
  });

  it("sorts not-added repos before added within a group", () => {
    const groups = buildAddableGroups(
      [
        repo({ fullName: "acme/added", name: "added" }),
        repo({ fullName: "acme/fresh", name: "fresh" }),
      ],
      new Set(["acme/added"]),
      [installation()],
      SLUG,
    );
    expect(groups[0].repos.map((r) => r.name)).toEqual(["fresh", "added"]);
  });

  it("orders accounts with at least one addable repo before fully-added accounts", () => {
    const groups = buildAddableGroups(
      [
        repo({ owner: "zeta", ownerId: 1, fullName: "zeta/all-added", name: "x" }),
        repo({ owner: "alpha", ownerId: 2, fullName: "alpha/fresh", name: "y" }),
      ],
      new Set(["zeta/all-added"]),
      [],
      SLUG,
    );
    // alpha has an addable repo, zeta is fully added → alpha first despite Z<A.
    expect(groups.map((g) => g.account)).toEqual(["alpha", "zeta"]);
  });

  it("returns no groups for an empty accessible list", () => {
    expect(buildAddableGroups([], new Set(), [], SLUG)).toEqual([]);
  });
});

/**
 * Pure shaping for the "Add repositories" modal. Given the repos a reviewer can
 * reach (`/user/repos`), the set already installed on diffsense, and the App slug,
 * it produces account-grouped rows annotated with whether each repo is *added*
 * (the App is installed) and a GitHub install URL the reviewer follows to add the
 * not-yet-added ones. Kept free of I/O so the grouping/sorting/annotation logic is
 * unit-testable without a session or network; the `"use server"` action wraps it.
 */

import type { Installation, Organization, Repository } from "./github";
import { buildInstallUrl } from "./githubApp";

/** A reachable repo plus whether diffsense is already installed on it. */
export type AddableRepo = Omit<Repository, "ownerId"> & { added: boolean };

export interface AddableGroup {
  account: string;
  /** `"Organization"` or `"User"` — drives the account icon in the modal. */
  accountType: string;
  /** Where to send the reviewer to grant the App access to repos in this account. */
  installUrl: string;
  repos: AddableRepo[];
}

/**
 * An account (org or the user's own) the reviewer can onboard but that does NOT yet
 * have diffsense installed. Surfaced as an "Install on <account>" card so org repos
 * become reachable — a GitHub App user token can't list an org's repos until the App
 * is installed there.
 */
export interface InstallableTarget {
  account: string;
  accountType: "Organization" | "User";
}

export type AddableReposResult =
  | { groups: AddableGroup[]; installableTargets: InstallableTarget[]; installNewUrl: string }
  | { error: "reauth" };

/**
 * Accounts the reviewer can install diffsense on but hasn't yet: their orgs plus
 * their personal account, minus any account that already has an installation
 * (case-insensitive). Sorted alphabetically. Pure — no I/O.
 */
export function computeInstallableTargets(
  orgs: Organization[],
  personalLogin: string,
  installations: Installation[],
): InstallableTarget[] {
  // GitHub logins are globally unique across users and orgs, so the org list has no
  // duplicates and can't collide with the personal login — filtering against the
  // installed set is enough; no separate dedup pass needed.
  const installed = new Set(installations.map((i) => i.account.toLowerCase()));
  const candidates: InstallableTarget[] = [
    ...orgs.map((o) => ({ account: o.login, accountType: "Organization" as const })),
    { account: personalLogin, accountType: "User" as const },
  ];
  return candidates
    .filter((c) => c.account && !installed.has(c.account.toLowerCase()))
    .sort((a, b) => a.account.localeCompare(b.account));
}

/**
 * Group accessible repos by owner account, mark each `added`, and resolve a
 * per-account install URL. Sort order surfaces the actionable repos first:
 * not-added before added within a group, then most-recently-pushed first; groups
 * are ordered with any not-fully-added account first, then alphabetically.
 */
export function buildAddableGroups(
  accessible: Repository[],
  installedFullNames: Set<string>,
  installations: Installation[],
  slug: string,
): AddableGroup[] {
  // Account login (lowercased) → its installation, so we can label org vs user
  // consistently with the existing /repos page even for already-installed accounts.
  const installByAccount = new Map<string, Installation>();
  for (const installation of installations) {
    installByAccount.set(installation.account.toLowerCase(), installation);
  }

  const byOwner = new Map<string, { account: string; repos: AddableRepo[] }>();
  for (const repo of accessible) {
    const key = repo.owner.toLowerCase();
    let bucket = byOwner.get(key);
    if (!bucket) {
      bucket = { account: repo.owner, repos: [] };
      byOwner.set(key, bucket);
    }
    const { ownerId, ...repoFields } = repo;
    bucket.repos.push({ ...repoFields, added: installedFullNames.has(repo.fullName) });
  }

  // One canonical install link for every account — GitHub's install page lists the
  // accounts the user can install/configure on (see buildInstallUrl for why we don't
  // build per-account deep links).
  const installUrl = buildInstallUrl(slug);
  const groups: AddableGroup[] = [];
  for (const bucket of byOwner.values()) {
    const installation = installByAccount.get(bucket.account.toLowerCase());
    bucket.repos.sort(compareRepos);
    groups.push({
      account: bucket.account,
      accountType: installation?.accountType ?? "User",
      installUrl,
      repos: bucket.repos,
    });
  }

  groups.sort(compareGroups);
  return groups;
}

/** Not-added repos first; within the same added-state, most recently pushed first. */
function compareRepos(a: AddableRepo, b: AddableRepo): number {
  if (a.added !== b.added) {
    return a.added ? 1 : -1;
  }
  return pushedTime(b.pushedAt) - pushedTime(a.pushedAt);
}

/** Accounts with at least one not-yet-added repo first, then alphabetical. */
function compareGroups(a: AddableGroup, b: AddableGroup): number {
  const aActionable = a.repos.some((r) => !r.added);
  const bActionable = b.repos.some((r) => !r.added);
  if (aActionable !== bActionable) {
    return aActionable ? -1 : 1;
  }
  return a.account.localeCompare(b.account);
}

function pushedTime(pushedAt: string | null): number {
  if (!pushedAt) {
    return 0;
  }
  const t = Date.parse(pushedAt);
  return Number.isNaN(t) ? 0 : t;
}

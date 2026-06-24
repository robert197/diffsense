/**
 * Pure shaping for the "Add repositories" modal. Given the repos a reviewer can
 * reach (`/user/repos`), the set already installed on diffsense, and the App slug,
 * it produces account-grouped rows annotated with whether each repo is *added*
 * (the App is installed) and a GitHub install URL the reviewer follows to add the
 * not-yet-added ones. Kept free of I/O so the grouping/sorting/annotation logic is
 * unit-testable without a session or network; the `"use server"` action wraps it.
 */

import type { Installation, Repository } from "./github";
import { buildInstallUrl } from "./githubApp";

export interface AddableRepo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  pushedAt: string | null;
  /** True when diffsense's GitHub App is already installed on this repo. */
  added: boolean;
}

export interface AddableGroup {
  account: string;
  /** `"Organization"` or `"User"` — drives the account icon in the modal. */
  accountType: string;
  /** Where to send the reviewer to grant the App access to repos in this account. */
  installUrl: string;
  repos: AddableRepo[];
}

export type AddableReposResult =
  | { groups: AddableGroup[]; installNewUrl: string }
  | { error: "reauth" };

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

  const byOwner = new Map<string, { ownerId: number | null; repos: AddableRepo[] }>();
  for (const repo of accessible) {
    const key = repo.owner.toLowerCase();
    let bucket = byOwner.get(key);
    if (!bucket) {
      bucket = { ownerId: repo.ownerId, repos: [] };
      byOwner.set(key, bucket);
    }
    // Prefer the first non-null ownerId seen for the account (for the install URL).
    if (bucket.ownerId === null && repo.ownerId !== null) {
      bucket.ownerId = repo.ownerId;
    }
    bucket.repos.push({
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      private: repo.private,
      pushedAt: repo.pushedAt,
      added: installedFullNames.has(repo.fullName),
    });
  }

  const groups: AddableGroup[] = [];
  for (const bucket of byOwner.values()) {
    const account = bucket.repos[0]?.owner ?? "";
    const installation = installByAccount.get(account.toLowerCase());
    bucket.repos.sort(compareRepos);
    groups.push({
      account,
      accountType: installation?.accountType ?? "User",
      installUrl: buildInstallUrl(
        slug,
        bucket.ownerId !== null ? { accountId: bucket.ownerId } : {},
      ),
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

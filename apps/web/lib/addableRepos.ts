/**
 * Pure shaping for the "Add repositories" modal. A GitHub App can only review repos
 * in accounts where it is installed, so the modal's source of truth is the set of
 * installations: each installed account becomes a group of its (reviewable, private
 * included) repos, and accounts the user belongs to *without* an installation become
 * install/request targets. Kept free of I/O so the grouping/sorting logic is
 * unit-testable; the `"use server"` action fetches and wraps it.
 */

import type { Installation, OrgMembership, Repository } from "./github";

/** One installed account and the repos diffsense can review there. */
export interface AddableGroup {
  account: string;
  /** `"Organization"` or `"User"` — drives the account icon in the modal. */
  accountType: string;
  /**
   * GitHub's configure page for this installation when only a *selected* subset of
   * repos is shared (so the reviewer can add more); `null` when the App already has
   * access to *all* repos in the account.
   */
  manageUrl: string | null;
  repos: Repository[];
}

/**
 * An account the reviewer can onboard but that does NOT yet have diffsense. `install`
 * when they can grant access directly (org admin or their own account); `request`
 * when they're only a member — installing then files a request to the org's owners.
 */
export interface InstallableTarget {
  account: string;
  accountType: "Organization" | "User";
  installType: "install" | "request";
}

export type AddableReposResult =
  | { groups: AddableGroup[]; installableTargets: InstallableTarget[]; installNewUrl: string }
  | { error: "reauth" };

/**
 * Build one group per installation from its already-fetched repositories. Repos are
 * sorted most-recently-pushed first; groups alphabetically by account. A `selected`
 * installation carries its configure URL as `manageUrl` so the reviewer can widen
 * access; an `all` installation needs none.
 */
export function buildAddableGroups(
  installations: Installation[],
  reposByInstallationId: Map<number, Repository[]>,
): AddableGroup[] {
  const groups: AddableGroup[] = installations.map((installation) => ({
    account: installation.account,
    accountType: installation.accountType,
    manageUrl: installation.repositorySelection === "selected" ? installation.configureUrl : null,
    repos: [...(reposByInstallationId.get(installation.id) ?? [])].sort(
      (a, b) => pushedTime(b.pushedAt) - pushedTime(a.pushedAt),
    ),
  }));
  return groups.sort((a, b) => a.account.localeCompare(b.account));
}

/**
 * Accounts the reviewer can onboard but hasn't yet: their orgs (from memberships)
 * plus their personal account, minus any account that already has an installation
 * (case-insensitive). Org admins get `install`, members get `request`; the personal
 * account is always `install`. Sorted alphabetically. Pure — no I/O.
 */
export function computeInstallableTargets(
  memberships: OrgMembership[],
  personalLogin: string,
  installations: Installation[],
): InstallableTarget[] {
  const installed = new Set(installations.map((i) => i.account.toLowerCase()));
  const candidates: InstallableTarget[] = [
    // Only `active` memberships are real onboarding targets — a `pending` membership
    // is an unaccepted invite, so the user can't yet install or request there.
    ...memberships
      .filter((m) => m.state === "active")
      .map((m) => ({
        account: m.login,
        accountType: "Organization" as const,
        installType: m.role === "admin" ? ("install" as const) : ("request" as const),
      })),
    { account: personalLogin, accountType: "User" as const, installType: "install" as const },
  ];
  return candidates
    .filter((c) => c.account && !installed.has(c.account.toLowerCase()))
    .sort((a, b) => a.account.localeCompare(b.account));
}

function pushedTime(pushedAt: string | null): number {
  if (!pushedAt) {
    return 0;
  }
  const t = Date.parse(pushedAt);
  return Number.isNaN(t) ? 0 : t;
}

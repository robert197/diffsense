"use client";

import { Building2, ExternalLink, Loader2, Plus, RefreshCw, Search, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAddableRepos } from "../../app/repos/actions";
import type { AddableGroup, InstallableTarget } from "../../lib/addableRepos";
import { isOrgAccount } from "../../lib/github";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { RepoRow } from "./RepoRow";

/**
 * "Add repositories" button + modal. Adding a repo to diffsense means installing
 * the GitHub App on it — only GitHub can grant that — so this modal is a browse +
 * route surface: it lists every repo the reviewer can reach (across their user and
 * orgs), marks the ones diffsense is already on, and routes the rest to GitHub's
 * install screen. Repo data loads lazily on first open (the action carries the
 * server-only OAuth token), not on every `/repos` render.
 */

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      groups: AddableGroup[];
      installableTargets: InstallableTarget[];
      installNewUrl: string;
    }
  | { status: "error"; kind: "reauth" | "unknown" };

export function AddRepositoriesModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [filter, setFilter] = useState("");
  // Accounts whose Install/Request link the reviewer just opened on GitHub. Local
  // UI only — it drives the "Opened on GitHub, refresh when done" hint; the real
  // state change arrives via the refresh on return. Cleared on close.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // Guards the async load against itself: `loadingRef` drops a concurrent call
  // (rapid "Try again" clicks); `genRef` invalidates an in-flight load when the
  // dialog closes, so a late response never writes stale state onto a closed modal.
  const loadingRef = useRef(false);
  const genRef = useRef(0);
  // Mirror of `state.status` for the refocus handler — lets it read the current
  // status without re-subscribing the listeners on every state change.
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const load = useCallback(async () => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    const gen = genRef.current;
    setState({ status: "loading" });
    try {
      const result = await loadAddableRepos();
      if (gen !== genRef.current) {
        return; // dialog closed / reset while loading — discard the result
      }
      setState(
        "error" in result
          ? { status: "error", kind: "reauth" }
          : {
              status: "loaded",
              groups: result.groups,
              installableTargets: result.installableTargets,
              installNewUrl: result.installNewUrl,
            },
      );
    } catch {
      if (gen === genRef.current) {
        setState({ status: "error", kind: "unknown" });
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  // Refresh on return-to-tab. Installing/requesting opens GitHub in a new tab; when
  // the reviewer approves and switches back, this re-fetches so a just-synced org
  // and its (private) repos appear without a manual close/reopen. Only while the
  // dialog is open and only for a settled `loaded` view — the loading and error
  // states own their own lifecycle (initial load, manual "Try again"). `load`'s
  // own guard drops the call if one is already in flight, so rapid focus toggles
  // can't start a refresh storm.
  useEffect(() => {
    if (!open) {
      return;
    }
    function refresh() {
      if (document.visibilityState !== "visible" || statusRef.current !== "loaded") {
        return;
      }
      void load();
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [open, load]);

  const markOpened = useCallback((account: string) => {
    setOpened((prev) => new Set(prev).add(account));
  }, []);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Each open re-fetches fresh so a just-completed GitHub install shows as
      // "Added"; the idle guard means an already-running load isn't duplicated.
      if (state.status === "idle") {
        void load();
      }
    } else {
      // Reset on close: invalidate any in-flight load, drop stale results, and
      // clear the filter so the next open starts clean.
      genRef.current += 1;
      loadingRef.current = false;
      setState({ status: "idle" });
      setFilter("");
      setOpened(new Set());
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Add repositories
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add repositories</DialogTitle>
          <DialogDescription>
            Pick a repo from your account or organisations. Choosing one sends you to GitHub to
            grant diffsense access — webhooks only arrive once the app is installed.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          <Body
            state={state}
            filter={filter}
            onFilterChange={setFilter}
            onReload={load}
            opened={opened}
            onOpenTarget={markOpened}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Body({
  state,
  filter,
  onFilterChange,
  onReload,
  opened,
  onOpenTarget,
}: {
  state: LoadState;
  filter: string;
  onFilterChange: (value: string) => void;
  onReload: () => void;
  opened: ReadonlySet<string>;
  onOpenTarget: (account: string) => void;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading your repositories…
      </div>
    );
  }

  if (state.status === "error") {
    return state.kind === "reauth" ? (
      <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm">
        <p className="text-muted-foreground">Your GitHub sign-in expired.</p>
        <a href="/login" className="mt-2 inline-flex font-medium text-primary hover:underline">
          Sign in again
        </a>
      </div>
    ) : (
      <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm">
        <p className="text-muted-foreground">Couldn&apos;t load your repositories just now.</p>
        <button
          type="button"
          onClick={onReload}
          className="mt-2 font-medium text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const query = filter.trim().toLowerCase();
  const groups = query
    ? state.groups
        .map((group) => ({
          ...group,
          repos: group.repos.filter(
            (repo) =>
              repo.name.toLowerCase().includes(query) ||
              repo.fullName.toLowerCase().includes(query),
          ),
        }))
        .filter((group) => group.repos.length > 0)
    : state.groups;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <label className="relative block flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            className="h-10 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        {/* Manual refresh for when focus events don't fire (e.g. the install
            completed in a window the reviewer never left). */}
        <Button type="button" size="sm" variant="outline" onClick={onReload} className="shrink-0">
          <RefreshCw />
          Refresh
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {state.groups.length === 0
            ? "diffsense isn't installed on any of your accounts yet. Add one below to start reviewing its repositories."
            : "No repositories match your filter."}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <AccountGroup key={group.account} group={group} />
          ))}
        </div>
      )}

      {state.installableTargets.length > 0 ? (
        <InstallableTargets
          targets={state.installableTargets}
          installNewUrl={state.installNewUrl}
          opened={opened}
          onOpenTarget={onOpenTarget}
        />
      ) : (
        // Fallback when we can't enumerate installable accounts (e.g. /user/orgs
        // unreadable): the canonical install page still lists them on GitHub.
        <div className="border-t border-border/70 pt-3">
          <a
            href={state.installNewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <ExternalLink className="size-3.5" />
            Install on another account
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Accounts the reviewer can switch diffsense on but hasn't yet — their orgs and
 * personal account without an installation. A GitHub App user token can't list an
 * org's repos until the App is installed there, so this is how org repos (e.g.
 * devs-group/core-gent) become reachable: install on the org, then its repos appear.
 */
function InstallableTargets({
  targets,
  installNewUrl,
  opened,
  onOpenTarget,
}: {
  targets: InstallableTarget[];
  installNewUrl: string;
  opened: ReadonlySet<string>;
  onOpenTarget: (account: string) => void;
}) {
  return (
    <section className="border-t border-border/70 pt-4">
      <h3 className="text-sm font-semibold">Add an organisation or account</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Install diffsense on one of these to review its repositories. Installing on an organisation
        you don&apos;t own sends a request to its owners to approve.
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {targets.map((target) => {
          const isRequest = target.installType === "request";
          const wasOpened = opened.has(target.account);
          return (
            <li key={target.account}>
              <div className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
                {isOrgAccount(target.accountType) ? (
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <User className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {target.account}
                </span>
                <Button size="sm" variant="outline" asChild className="shrink-0">
                  <a
                    href={installNewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => onOpenTarget(target.account)}
                  >
                    <Plus />
                    {isRequest ? "Request access" : "Install"}
                  </a>
                </Button>
              </div>
              {wasOpened && (
                // The new GitHub tab is where the actual grant happens; the modal
                // refreshes on return, so nudge the reviewer back rather than
                // pretending the org is synced already.
                <p className="mt-1 pl-1 text-xs text-muted-foreground">
                  {isRequest
                    ? "Access requested on GitHub — refresh once an owner approves."
                    : "Opened on GitHub — refresh once you've finished installing."}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One installed account and the repos diffsense can review there (private included).
 * Every repo is reviewable — it's listed because the App is installed on it — so each
 * row links straight to its PRs. A `selected`-repos install also offers a link to
 * GitHub's configure page so the reviewer can add more repos to the selection.
 */
function AccountGroup({ group }: { group: AddableGroup }) {
  const isOrg = isOrgAccount(group.accountType);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isOrg ? (
            <Building2 className="size-4 text-muted-foreground" />
          ) : (
            <User className="size-4 text-muted-foreground" />
          )}
          <h3 className="text-sm font-semibold">{group.account}</h3>
        </div>
        {group.manageUrl && (
          <a
            href={group.manageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Manage repositories on GitHub
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {group.repos.map((repo) => (
          <li key={repo.fullName}>
            <RepoRow repo={repo} />
          </li>
        ))}
      </ul>
    </section>
  );
}

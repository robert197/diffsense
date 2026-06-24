"use client";

import {
  ArrowRight,
  Building2,
  ExternalLink,
  FolderGit2,
  Loader2,
  Lock,
  Plus,
  Search,
  User,
} from "lucide-react";
import { useState } from "react";
import { loadAddableRepos } from "../../app/repos/actions";
import type { AddableGroup, AddableReposResult } from "../../lib/addableRepos";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

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
  | { status: "loaded"; groups: AddableGroup[]; installNewUrl: string }
  | { status: "error"; kind: "reauth" | "unknown" };

export function AddRepositoriesModal() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [filter, setFilter] = useState("");

  async function load() {
    setState({ status: "loading" });
    try {
      const result: AddableReposResult = await loadAddableRepos();
      if ("error" in result) {
        setState({ status: "error", kind: "reauth" });
        return;
      }
      setState({ status: "loaded", groups: result.groups, installNewUrl: result.installNewUrl });
    } catch {
      setState({ status: "error", kind: "unknown" });
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Load once on first open; keep the result across reopens (a refresh of the
    // page picks up newly-installed repos, so a stale-on-reopen list is acceptable).
    if (next && state.status === "idle") {
      void load();
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
          <Body state={state} filter={filter} onFilterChange={setFilter} onRetry={load} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Body({
  state,
  filter,
  onFilterChange,
  onRetry,
}: {
  state: LoadState;
  filter: string;
  onFilterChange: (value: string) => void;
  onRetry: () => void;
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
          onClick={onRetry}
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
      <label className="relative block">
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

      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {state.groups.length === 0
            ? "No repositories found for your account."
            : "No repositories match your filter."}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <AccountGroup key={group.account} group={group} />
          ))}
        </div>
      )}

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
    </div>
  );
}

function AccountGroup({ group }: { group: AddableGroup }) {
  const isOrg = group.accountType.toLowerCase() === "organization";
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
        <a
          href={group.installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Configure on GitHub
          <ExternalLink className="size-3" />
        </a>
      </div>
      <ul className="flex flex-col gap-1.5">
        {group.repos.map((repo) => (
          <li key={repo.fullName}>
            <div className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{repo.name}</span>
                  {repo.private && (
                    <Badge variant="outline" className="gap-1">
                      <Lock />
                      Private
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{repo.fullName}</p>
              </div>
              {repo.added ? (
                <a
                  href={`/repos/${repo.owner}/${repo.name}/pulls`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Added
                  <ArrowRight className="size-3" />
                </a>
              ) : (
                <Button size="sm" variant="outline" asChild className="shrink-0">
                  <a href={group.installUrl} target="_blank" rel="noopener noreferrer">
                    <Plus />
                    Add
                  </a>
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

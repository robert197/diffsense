"use client";

import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadOpenPullRequests } from "../../app/repos/[owner]/[repo]/pulls/actions";
import type { PullRequest } from "../../lib/github";
import { relativeTime } from "../../lib/ui";
import { Button } from "../ui/button";
import { PullRow } from "./PullRow";

/**
 * Live open-PR list for one repo. The server page does the first paint (auth + the
 * initial `listOpenPullRequests`); this island keeps that list converged with GitHub
 * while the reviewer has the page open — refetching on tab refocus and on demand,
 * through the `loadOpenPullRequests` action so only the PR array crosses the wire (no
 * full-page reload). It mirrors the Add Repositories modal's sync seam: the same
 * `loadingRef`/`genRef` guards against duplicate loads and stale writes, the same
 * refocus trigger, plus a refocus throttle so rapid tab toggles don't storm GitHub.
 */

/** Refocus refetches no more than once per this window; the manual Refresh bypasses it. */
const MIN_REFOCUS_INTERVAL_MS = 10_000;

type SyncStatus = "idle" | "syncing" | "error";

/**
 * PRs that are new or changed since the previous synced view, keyed by number. A
 * number absent from the prior list is "new"; one whose `updatedAt` advanced is
 * "updated". Recomputed every sync (so last sync's markers clear), empty on first paint.
 */
function diffChanges(prev: PullRequest[], next: PullRequest[]): Map<number, "new" | "updated"> {
  const prevByNumber = new Map(prev.map((p) => [p.number, p.updatedAt]));
  const changes = new Map<number, "new" | "updated">();
  for (const p of next) {
    const before = prevByNumber.get(p.number);
    if (before === undefined) {
      changes.set(p.number, "new");
    } else if (before !== p.updatedAt && Date.parse(p.updatedAt) > Date.parse(before)) {
      changes.set(p.number, "updated");
    }
  }
  return changes;
}

export function PullsList({
  owner,
  repo,
  initialPulls,
}: {
  owner: string;
  repo: string;
  initialPulls: PullRequest[];
}) {
  const router = useRouter();
  const [pulls, setPulls] = useState(initialPulls);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [changed, setChanged] = useState<Map<number, "new" | "updated">>(new Map());
  // The page just server-rendered `initialPulls`, so the list is fresh as of now.
  const [lastSynced, setLastSynced] = useState(() => Date.now());

  // Guards mirroring AddRepositoriesModal: `loadingRef` drops a concurrent load;
  // `genRef` (bumped on unmount) invalidates an in-flight load so a late response
  // never writes onto an unmounted island; `mountedRef` is the same guard for the
  // router redirect. `pullsRef`/`lastSyncedRef` mirror state so the sync callback and
  // the refocus handler read current values without re-subscribing on every render.
  const loadingRef = useRef(false);
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;
  const lastSyncedRef = useRef(lastSynced);
  lastSyncedRef.current = lastSynced;

  const sync = useCallback(async () => {
    if (loadingRef.current) {
      return; // a load is already in flight — don't duplicate it
    }
    loadingRef.current = true;
    const gen = genRef.current;
    setStatus("syncing");
    try {
      const result = await loadOpenPullRequests(owner, repo);
      if (gen !== genRef.current || !mountedRef.current) {
        return; // unmounted while loading — discard the result
      }
      if ("error" in result) {
        // Sign-in expired mid-session — route to re-auth rather than show a broken list.
        router.push("/login");
        return;
      }
      setChanged(diffChanges(pullsRef.current, result.pulls));
      setPulls(result.pulls);
      const now = Date.now();
      lastSyncedRef.current = now;
      setLastSynced(now);
      setStatus("idle");
    } catch {
      if (gen === genRef.current && mountedRef.current) {
        setStatus("error");
      }
    } finally {
      loadingRef.current = false;
    }
  }, [owner, repo, router]);

  // Refresh on return-to-tab: when the reviewer comes back from GitHub (opened a PR,
  // merged, pushed), re-fetch so new PRs appear and merged/closed ones drop out. The
  // throttle skips a refetch within `MIN_REFOCUS_INTERVAL_MS` of the last sync so
  // flipping between tabs doesn't hammer GitHub; `sync`'s own guard absorbs overlaps.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (Date.now() - lastSyncedRef.current < MIN_REFOCUS_INTERVAL_MS) {
        return;
      }
      void sync();
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [sync]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genRef.current += 1; // invalidate any in-flight load on unmount
    };
  }, []);

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {pulls.length === 0
            ? "Open pull requests"
            : `${pulls.length} open pull request${pulls.length === 1 ? "" : "s"}`}
        </p>
        <div className="flex items-center gap-3">
          <SyncStatus status={status} lastSynced={lastSynced} />
          {/* Manual sync for when focus events don't fire; bypasses the refocus throttle. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void sync()}
            disabled={status === "syncing"}
            className="shrink-0"
          >
            <RefreshCw className={status === "syncing" ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {pulls.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
            <GitPullRequest className="size-6" />
          </div>
          <p className="font-medium">No open pull requests</p>
          <p className="mt-1 text-sm text-muted-foreground">
            When a PR opens here, it&apos;ll show up ready to review.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pulls.map((pull) => (
            <li key={pull.number}>
              <PullRow owner={owner} repo={repo} pull={pull} change={changed.get(pull.number)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Legible freshness: a spinner while syncing, an error nudge, else "Synced … ago". */
function SyncStatus({ status, lastSynced }: { status: SyncStatus; lastSynced: number }) {
  if (status === "syncing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Syncing…
      </span>
    );
  }
  if (status === "error") {
    return <span className="text-xs text-destructive">Couldn&apos;t sync — try Refresh</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      Synced {relativeTime(new Date(lastSynced).toISOString())}
    </span>
  );
}

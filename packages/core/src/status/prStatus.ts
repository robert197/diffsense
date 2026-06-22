import type { PrLifecycle, PrStatusValue } from "../schemas/prStatus.js";

/**
 * Pure PR-status logic (issue #31). No I/O, no SDK: GitHub's `{ state, merged }`
 * pair in, the persisted `PrStatusValue` label out, plus the two predicates the
 * worker and dashboard need. Keeping the judgment here — like `derivePrStatus`'s
 * sibling kernels `resumeState` and `rankHunks` — makes background sync
 * deterministic and unit-testable with no adapters.
 */

/**
 * Fold GitHub's live lifecycle into the persisted label. `state` wins: an open PR
 * is `open` regardless of the `merged` flag (GitHub never sets `merged` on an open
 * PR, but we don't depend on that). A closed PR is `merged` when it was merged,
 * else `closed`.
 */
export function derivePrStatus(lifecycle: PrLifecycle): PrStatusValue {
  if (lifecycle.state === "open") {
    return "open";
  }
  return lifecycle.merged ? "merged" : "closed";
}

/** True once the PR has left the active list — the dashboard's done/archived bucket. */
export function isArchivedStatus(status: PrStatusValue): boolean {
  return status === "merged" || status === "closed";
}

/**
 * Reconcile a persisted status against a fresh live read (the poll fallback). Returns
 * the derived label and whether it differs from what we last stored — so the poller
 * can do the cheap `markSynced` when nothing changed and the full `recordStatus` only
 * when a PR actually merged/closed (or reopened) since we last looked.
 */
export function reconcilePrStatus(
  current: PrStatusValue,
  live: PrLifecycle,
): { status: PrStatusValue; changed: boolean } {
  const status = derivePrStatus(live);
  return { status, changed: status !== current };
}

/**
 * A minimal, serializable reference to a pull request — the BullMQ job payload
 * and the input to the `handlePullRequestEvent` seam. Deliberately small and
 * stable (KTD4): the worker reconstructs an installation-scoped Octokit from
 * `installationId` rather than carrying the full webhook blob through the queue.
 */
export interface PrRef {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  action: "opened" | "synchronize";
  deliveryId: string;
}

export const REVIEW_QUEUE_NAME = "review";
export const REVIEW_JOB_NAME = "pr-review";

/**
 * Background PR merge-status sync (issue #31) runs on its own queue so quick status
 * upserts never queue behind minutes-long review jobs, and the two keep separate
 * retention. Two job names: `pr-status-update` (one closed/reopened webhook) and
 * `pr-status-poll` (the repeatable fallback that reconciles still-open PRs).
 */
export const PR_STATUS_QUEUE_NAME = "pr-status";
export const PR_STATUS_UPDATE_JOB = "pr-status-update";
export const PR_STATUS_POLL_JOB = "pr-status-poll";

/**
 * A `closed`/`reopened` webhook turned into a background status write. Carries the
 * raw GitHub lifecycle (`state` + `merged`) so the worker derives the label via
 * core's `derivePrStatus`, plus `installationId` so the poll can re-read the PR
 * later. The delivery id is the job id, so duplicate deliveries collapse to one job.
 */
export interface PrStatusUpdateJob {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  state: "open" | "closed";
  merged: boolean;
  deliveryId: string;
}

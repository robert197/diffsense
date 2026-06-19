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

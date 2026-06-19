import { countHunks } from "@diffsense/core";
import { type GitHubClient, type UpsertResult, upsertReviewComment } from "../adapters/github.js";
import type { PrRef } from "../types.js";

/** The event shape the seam needs — a narrowed `PrRef`. */
export type PullRequestEvent = Pick<PrRef, "owner" | "repo" | "prNumber" | "action">;

/**
 * The single integration seam every later slice plugs into (KTD5). Fetches the
 * PR diff, counts hunks (pure `core` fn), and upserts the placeholder comment.
 * Takes an already-built Octokit so it is testable with a fake — no queue, no
 * network.
 */
export async function handlePullRequestEvent(
  event: PullRequestEvent,
  octokit: GitHubClient,
): Promise<UpsertResult> {
  const { owner, repo, prNumber } = event;

  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  // With `format: "diff"` Octokit returns the raw unified diff as a string.
  // Anything else means the media-type request was not honored — fail loudly
  // (BullMQ retries) rather than silently reporting "0 hunks".
  if (typeof data !== "string") {
    throw new Error(`expected a string diff from pulls.get, got ${typeof data}`);
  }
  const hunks = countHunks(data);

  const body = `diffsense received this PR — ${hunks} hunks detected`;
  return upsertReviewComment(octokit, { owner, repo, prNumber, body });
}

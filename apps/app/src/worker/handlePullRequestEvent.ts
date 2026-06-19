import { type ReactionOptions, rankHunks, renderComment } from "@diffsense/core";
import { type GitHubClient, type UpsertResult, upsertReviewComment } from "../adapters/github.js";
import type { PrRef } from "../types.js";

/** The event shape the seam needs — a narrowed `PrRef`. */
export type PullRequestEvent = Pick<PrRef, "owner" | "repo" | "prNumber" | "action">;

export interface HandleOptions {
  /** Public ingress URL; enables the 👍/👎 reaction links in the comment. */
  reactionBaseUrl?: string;
}

/**
 * The single integration seam every later slice plugs into (KTD5). Fetches the
 * PR diff, ranks the hunks by structural risk (pure `core` fns, no LLM), and
 * upserts the advisory ranked comment. Takes an already-built Octokit so it is
 * testable with a fake — no queue, no network.
 */
export async function handlePullRequestEvent(
  event: PullRequestEvent,
  octokit: GitHubClient,
  opts: HandleOptions = {},
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
  // (BullMQ retries) rather than silently posting an empty ranking.
  if (typeof data !== "string") {
    throw new Error(`expected a string diff from pulls.get, got ${typeof data}`);
  }

  const ranked = rankHunks(data, { owner, repo, prNumber });
  const reactions: ReactionOptions | undefined = opts.reactionBaseUrl
    ? { reactionBaseUrl: opts.reactionBaseUrl, pr: { owner, repo, prNumber } }
    : undefined;
  const body = renderComment(ranked, reactions);
  return upsertReviewComment(octokit, { owner, repo, prNumber, body });
}

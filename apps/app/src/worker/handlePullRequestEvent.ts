import {
  type ReactionOptions,
  cardViewLink,
  rankHunks,
  renderRankedComment,
} from "@diffsense/core";
import { type GitHubClient, type UpsertResult, upsertReviewComment } from "../adapters/github.js";
import type { PrRef } from "../types.js";

/** The event shape the seam needs — a narrowed `PrRef`. */
export type PullRequestEvent = Pick<PrRef, "owner" | "repo" | "prNumber" | "action">;

/** Runs the agentic review pass and persists findings for the card view (#13). */
export type ReviewFindingsRunner = (ctx: {
  owner: string;
  repo: string;
  prNumber: number;
  diff: string;
}) => Promise<unknown>;

export interface HandleOptions {
  /** Public ingress URL; enables the 👍/👎 reaction links in the comment. */
  reactionBaseUrl?: string;
  /** Public base URL of the hosted card view; adds the "view cards" link (#13). */
  cardViewBaseUrl?: string;
  /**
   * When set, runs the LLM review pass and persists per-chunk findings (#13).
   * Optional: a deployment with no LLM configured omits it and the handler just
   * ranks + comments, exactly as before. Best-effort — a failure here is logged
   * and never blocks the deterministic ranked comment.
   */
  reviewFindings?: ReviewFindingsRunner;
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

  // Enrich with the agentic review pass when an LLM is wired (#13). Best-effort:
  // the deterministic ranked comment is the guaranteed deliverable, so a review
  // failure is logged and the comment still ships.
  if (opts.reviewFindings) {
    try {
      await opts.reviewFindings({ owner, repo, prNumber, diff: data });
    } catch (err) {
      console.error(`review findings failed for ${owner}/${repo}#${prNumber}:`, err);
    }
  }

  const reactions: ReactionOptions | undefined = opts.reactionBaseUrl
    ? { reactionBaseUrl: opts.reactionBaseUrl, pr: { owner, repo, prNumber } }
    : undefined;
  const cardViewUrl = opts.cardViewBaseUrl
    ? cardViewLink(opts.cardViewBaseUrl, { owner, repo, prNumber })
    : undefined;
  const body = renderRankedComment(ranked, reactions, cardViewUrl);
  return upsertReviewComment(octokit, { owner, repo, prNumber, body });
}

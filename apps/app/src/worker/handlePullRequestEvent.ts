import {
  type ReactionOptions,
  type ReviewFinding,
  cardViewLink,
  rankHunks,
  renderRankedComment,
} from "@diffsense/core";
import { type GitHubClient, type UpsertResult, upsertReviewComment } from "../adapters/github.js";
import type { PrRef } from "../types.js";

/** The event shape the seam needs — a narrowed `PrRef`. */
export type PullRequestEvent = Pick<PrRef, "owner" | "repo" | "prNumber" | "action">;

/** Context every per-PR producer (review pass, deck builder) is handed. */
export interface ReviewRunContext {
  owner: string;
  repo: string;
  prNumber: number;
  diff: string;
}

/**
 * Runs the agentic review pass and persists findings for the card view (#13).
 * Returns the findings so the deck builder can fold them in without re-running
 * the pass (#26).
 */
export type ReviewFindingsRunner = (ctx: ReviewRunContext) => Promise<readonly ReviewFinding[]>;

/**
 * Builds and persists the ordered Deck of cards from the diff + the review
 * findings (#26). Deterministic and pure-over-ports, so it runs on *every*
 * review — webhook or on-demand, LLM configured or not. When no review pass ran,
 * `findings` is empty and every card carries the structural ranking plus a
 * factual default explanation.
 */
export type DeckPersister = (
  ctx: ReviewRunContext,
  findings: readonly ReviewFinding[],
) => Promise<void>;

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
  /**
   * When set, builds + persists the Deck of cards (#26) after the review pass,
   * folding in whatever findings it produced (or none). Independent of the LLM:
   * the deck is deterministic, so this is wired on every review run. Best-effort
   * — a failure is logged and never blocks the ranked comment.
   */
  persistDeck?: DeckPersister;
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
  let findings: readonly ReviewFinding[] = [];
  if (opts.reviewFindings) {
    try {
      findings = await opts.reviewFindings({ owner, repo, prNumber, diff: data });
    } catch (err) {
      console.error(`review findings failed for ${owner}/${repo}#${prNumber}:`, err);
    }
  }

  // Build + persist the Deck of cards (#26). Deterministic, so it runs whether or
  // not the review pass produced findings — a no-LLM deployment still gets a full
  // ranked deck. Best-effort and isolated: its own try/catch with a deck-specific
  // log so a deck failure never blocks (or gets mislabeled as) the ranked comment.
  if (opts.persistDeck) {
    try {
      await opts.persistDeck({ owner, repo, prNumber, diff: data }, findings);
    } catch (err) {
      console.error(`deck build failed for ${owner}/${repo}#${prNumber}:`, err);
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

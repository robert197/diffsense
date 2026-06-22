import type { PostedComment, PrCommentInput } from "../schemas/prComment.js";

/**
 * Port: post a comment to a GitHub PR (issue #30; docs/ARCHITECTURE.md §1 lists
 * `GitHubGateway` as the post/edit-comment seam).
 *
 * Pure interface — `core` never knows whether the comment goes out via Octokit
 * (the worker's App-auth delivery) or the reviewer's OAuth-bound HTTP client (the
 * `apps/web` card surface, which must post *as the reviewer*, not the App). An
 * adapter on either side implements this same contract; `core` depends only on the
 * shape.
 */

/** The PR a comment targets. */
export interface GitHubPrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface GitHubGateway {
  /**
   * Post one comment. With an anchor the adapter leaves a diff-anchored review
   * comment on the card's file + lines; without one (or when the anchor can't be
   * positioned) it leaves a general PR-conversation comment. Returns the posted
   * comment's id, URL, and which kind actually landed.
   */
  postComment(ref: GitHubPrRef, input: PrCommentInput): Promise<PostedComment>;
}

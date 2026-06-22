import type { PrLifecycle } from "../schemas/prStatus.js";
import type { GitHubPrRef } from "./githubGateway.js";

/**
 * Port: read one PR's live lifecycle from GitHub (issue #31).
 *
 * Pure interface — `core` never knows it is Octokit. The adapter in `apps/app`
 * wraps the App-auth REST client; the background poll calls this to reconcile a PR
 * we still believe is open against its actual state. A PR that no longer exists
 * (404) resolves to `null` so the caller can skip it rather than treat it as an error.
 * Kept off the review-unit `RepoReader` on purpose: this is a background-sync read,
 * not a review-context tool.
 */
export interface PrStatusReader {
  getPullRequestState(ref: GitHubPrRef): Promise<PrLifecycle | null>;
}

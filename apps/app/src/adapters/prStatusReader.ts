import type { GitHubPrRef, PrLifecycle, PrStatusReader } from "@diffsense/core";

/**
 * GitHub adapter implementing the `PrStatusReader` port (issue #31,
 * docs/ARCHITECTURE.md §1). `core` owns the port; this is the only place that knows
 * it is Octokit. The background poll calls this to reconcile a PR we still believe
 * is open against its live state. The seam types against a minimal structural
 * interface so tests supply a fake without the real client (same approach as
 * `adapters/repoReader.ts` and `adapters/github.ts`).
 */

/** The subset of Octokit's REST surface this adapter uses. */
export interface PrStatusReaderClient {
  rest: {
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { state?: string | null; merged?: boolean | null };
      }>;
    };
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

export function createGitHubPrStatusReader(octokit: PrStatusReaderClient): PrStatusReader {
  return {
    async getPullRequestState({ owner, repo, prNumber }: GitHubPrRef): Promise<PrLifecycle | null> {
      let data: { state?: string | null; merged?: boolean | null };
      try {
        ({ data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }));
      } catch (err) {
        // A PR that no longer exists is a normal answer for the poll, not a failure.
        if (isNotFound(err)) {
          return null;
        }
        throw err;
      }
      // GitHub always returns "open" | "closed"; anything else is treated as open
      // so we never falsely archive a PR on an unexpected value.
      return {
        state: data.state === "closed" ? "closed" : "open",
        merged: data.merged === true,
      };
    },
  };
}

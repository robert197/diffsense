import type { LineRange, PrIntent, RepoReader } from "@diffsense/core";

/**
 * GitHub adapter implementing the `RepoReader` port (docs/ARCHITECTURE.md §1, §3).
 * `core` owns the port; this is the only place that knows it is Octokit. The
 * seam types against a minimal structural interface so tests supply a fake
 * without the real client (same approach as `adapters/github.ts`).
 */

/** The subset of Octokit's REST surface this adapter uses. */
export interface RepoReaderClient {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }) => Promise<{ data: unknown }>;
    };
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { title?: string | null; body?: string | null };
      }>;
    };
  };
}

export interface RepoReaderCoords {
  owner: string;
  repo: string;
  prNumber: number;
  /** Commit SHA or ref to read files at (the PR head). Defaults to the repo default. */
  ref?: string;
}

/** GitHub returns file contents base64-encoded inside a `content` object. */
function decodeContent(data: unknown): string | null {
  if (
    typeof data === "object" &&
    data !== null &&
    "content" in data &&
    typeof (data as { content: unknown }).content === "string"
  ) {
    const { content, encoding } = data as { content: string; encoding?: string };
    const buf = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
    return buf.toString("utf8");
  }
  return null;
}

/** Slice a 1-based, inclusive line range, clamped to the file's bounds. */
function sliceRange(text: string, range: LineRange): string {
  const lines = text.split("\n");
  const start = Math.max(1, range.start);
  const end = Math.min(lines.length, range.end);
  if (start > end) {
    return "";
  }
  return lines.slice(start - 1, end).join("\n");
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

export function createGitHubRepoReader(
  octokit: RepoReaderClient,
  coords: RepoReaderCoords,
): RepoReader {
  const { owner, repo, prNumber, ref } = coords;
  return {
    async readFile(path: string, range?: LineRange): Promise<string | null> {
      let data: unknown;
      try {
        ({ data } = await octokit.rest.repos.getContent({ owner, repo, path, ref }));
      } catch (err) {
        // A missing file is a normal answer for the review unit, not a failure.
        if (isNotFound(err)) {
          return null;
        }
        throw err;
      }
      const content = decodeContent(data);
      if (content === null) {
        return null;
      }
      return range ? sliceRange(content, range) : content;
    },
    async getPrIntent(): Promise<PrIntent> {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { title: data.title ?? "", body: data.body ?? "" };
    },
  };
}

import parseDiff from "parse-diff";

/**
 * Count the number of hunks (unified-diff `@@ ... @@` blocks) across all files
 * in a unified diff string.
 *
 * Pure and deterministic — language-agnostic, no I/O. This is `core`'s first
 * domain function; the Octokit fetch that produces the diff lives in `apps/app`
 * (dependency points inward — see docs/ARCHITECTURE.md §1).
 */
export function countHunks(diff: string): number {
  if (!diff.trim()) {
    return 0;
  }
  const files = parseDiff(diff);
  return files.reduce((total, file) => total + (file.chunks?.length ?? 0), 0);
}

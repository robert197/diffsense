import type parseDiff from "parse-diff";

/**
 * Shared diff-hunk primitives used by every stage that walks a unified diff
 * (`rankHunks`, `buildReviewChunks`, `buildDeck`). Pure, no I/O.
 *
 * These two helpers are load-bearing for the card<->finding join: the review
 * pass keys a finding by `fingerprintChunk(file, patch)`, and `buildDeck` must
 * recompute the *byte-identical* `patch` (and resolve the *same* file path) to
 * recover that key. Keeping the construction in one place means the join can no
 * longer drift if one call site is edited in isolation (docs/ARCHITECTURE.md §5).
 */

/**
 * The path GitHub uses for a file: the new path, or the old one if the file was
 * deleted. `/dev/null` (add/delete sentinel) is never a real path.
 */
export function githubPath(file: parseDiff.File): string | null {
  const to = file.to && file.to !== "/dev/null" ? file.to : null;
  const from = file.from && file.from !== "/dev/null" ? file.from : null;
  return to ?? from;
}

/**
 * The unified-diff text of a single hunk: the `@@` header line followed by every
 * change line. This exact string is what `fingerprintChunk` hashes, so it MUST
 * stay identical across `buildReviewChunks` and `buildDeck` or findings stop
 * attaching to their cards.
 */
export function hunkPatch(chunk: parseDiff.Chunk): string {
  return [chunk.content, ...chunk.changes.map((c) => c.content)].join("\n");
}

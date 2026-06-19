import type { RankedChunk } from "../rank/rankHunks.js";

/**
 * Render the advisory PR comment from ranked hunks — pure, no I/O.
 *
 * The comment points the reviewer at the riskiest changes first (High, then
 * Medium), each with a deep link, a one-line reason, and its tier. The Low
 * remainder collapses to a single line. Tone is strictly advisory: it never
 * blocks, approves, or otherwise touches the merge decision (STRATEGY.md — the
 * product stays advisory until trust is earned). The hidden idempotency marker
 * is added by the github adapter, not here.
 */
export function renderComment(rankedChunks: RankedChunk[]): string {
  const header = [
    "### diffsense — review these first",
    "",
    "Ranked by structural risk so you can spend attention where it counts. This is advisory: a suggested reading order, not a verdict on the PR.",
  ];

  if (rankedChunks.length === 0) {
    return [...header, "", "No rankable changes in this PR."].join("\n");
  }

  const high = rankedChunks.filter((c) => c.tier === "High");
  const medium = rankedChunks.filter((c) => c.tier === "Medium");
  const lowCount = rankedChunks.filter((c) => c.tier === "Low").length;

  const lines = [...header];

  if (high.length > 0) {
    lines.push("", "**High**", ...high.map(renderItem));
  }
  if (medium.length > 0) {
    lines.push("", "**Medium**", ...medium.map(renderItem));
  }
  if (lowCount > 0) {
    const plural = lowCount === 1 ? "hunk" : "hunks";
    lines.push("", `Plus ${lowCount} lower-risk ${plural} not listed.`);
  }

  return lines.join("\n");
}

function renderItem(chunk: RankedChunk): string {
  return `- **[${chunk.tier}]** [${chunk.file}:${chunk.line}](${chunk.deepLink}) — ${chunk.reason}`;
}

import type { RankedChunk } from "../rank/rankHunks.js";

/**
 * Optional reaction affordance config. When both fields are present, each
 * flagged (High/Medium) chunk gets a one-click 👍/👎 link pointing at the
 * diffsense ingress, so a reviewer can mark a flag as a real catch or noise
 * without any separate instrumentation (issue #3). Absent → the comment renders
 * exactly as before, so the worker never hard-depends on a public URL.
 */
export interface ReactionOptions {
  /** Public base URL of the diffsense ingress (e.g. https://diffsense.example). */
  reactionBaseUrl: string;
  pr: { owner: string; repo: string; prNumber: number };
}

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
export function renderComment(rankedChunks: RankedChunk[], reactions?: ReactionOptions): string {
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
    lines.push("", "**High**", ...high.map((c) => renderItem(c, reactions)));
  }
  if (medium.length > 0) {
    lines.push("", "**Medium**", ...medium.map((c) => renderItem(c, reactions)));
  }
  if (lowCount > 0) {
    const plural = lowCount === 1 ? "hunk" : "hunks";
    lines.push("", `Plus ${lowCount} lower-risk ${plural} not listed.`);
  }

  return lines.join("\n");
}

function renderItem(chunk: RankedChunk, reactions?: ReactionOptions): string {
  const base = `- **[${chunk.tier}]** [${chunk.file}:${chunk.line}](${chunk.deepLink}) — ${chunk.reason}`;
  return reactions ? `${base} ${reactionAffordance(chunk, reactions)}` : base;
}

/** `[👍](url) / [👎](url)` linking to the reaction endpoint for this chunk. */
function reactionAffordance(chunk: RankedChunk, reactions: ReactionOptions): string {
  const up = reactionUrl(chunk, reactions, "up");
  const down = reactionUrl(chunk, reactions, "down");
  return `[👍](${up}) / [👎](${down})`;
}

function reactionUrl(
  chunk: RankedChunk,
  { reactionBaseUrl, pr }: ReactionOptions,
  sentiment: "up" | "down",
): string {
  const params = new URLSearchParams({
    owner: pr.owner,
    repo: pr.repo,
    pr: String(pr.prNumber),
    fp: chunk.fingerprint,
    tier: chunk.tier,
    s: sentiment,
  });
  return `${reactionBaseUrl.replace(/\/$/, "")}/reactions?${params.toString()}`;
}

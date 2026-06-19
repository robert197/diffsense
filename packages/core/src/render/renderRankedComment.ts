import type { RankedChunk } from "../rank/rankHunks.js";
import { type ReactionOptions, reactionAffordance } from "./reactionLink.js";

export type { ReactionOptions } from "./reactionLink.js";

/**
 * Hard cap on how many flagged (High/Medium) chunks the comment lists, however
 * many the ranking produced. The product's whole premise is *directing finite
 * attention to the few changes that matter* (STRATEGY.md) — on a 150-file PR the
 * percentile tiers can mark dozens "High", and a 80-item comment is just the
 * file-order firehose again. The top slice is the deterministic margin guard.
 */
export const MAX_LISTED = 10;

/**
 * Render the advisory structural-ranking comment from ranked hunks — pure, no I/O.
 *
 * This is the deterministic, no-LLM comment shipped today (issues #2/#3): it
 * points the reviewer at the riskiest changes first (High, then Medium), each
 * with a deep link, a one-line reason, and its tier. The Low remainder collapses
 * to a single line. Tone is strictly advisory: it never blocks, approves, or
 * otherwise touches the merge decision (STRATEGY.md — the product stays advisory
 * until trust is earned). The hidden idempotency marker is added by the github
 * adapter, not here. The enriched portfolio comment (issue #12) is a separate
 * renderer (`renderComment`) used once the agentic pipeline runs.
 *
 * When `cardViewUrl` is given, a link to the hosted card view (issue #13) is
 * appended so the reviewer can open the full per-chunk detail. Absent → the
 * comment renders exactly as before, so a deployment without the web role never
 * advertises a dead link.
 */
export function renderRankedComment(
  rankedChunks: RankedChunk[],
  reactions?: ReactionOptions,
  cardViewUrl?: string,
): string {
  const header = [
    "### diffsense — review these first",
    "",
    "Ranked by structural risk so you can spend attention where it counts. This is advisory: a suggested reading order, not a verdict on the PR.",
  ];

  if (rankedChunks.length === 0) {
    return withCardViewLink([...header, "", "No rankable changes in this PR."], cardViewUrl);
  }

  const high = rankedChunks.filter((c) => c.tier === "High");
  const medium = rankedChunks.filter((c) => c.tier === "Medium");
  const lowCount = rankedChunks.filter((c) => c.tier === "Low").length;

  // `rankedChunks` is globally score-ordered, so [...high, ...medium] is already
  // highest-first; the top MAX_LISTED is the attention budget the reviewer gets.
  const flagged = [...high, ...medium];
  const shown = flagged.slice(0, MAX_LISTED);
  const shownHigh = shown.filter((c) => c.tier === "High");
  const shownMedium = shown.filter((c) => c.tier === "Medium");
  const hiddenFlagged = flagged.length - shown.length;

  const lines = [...header];

  if (shownHigh.length > 0) {
    lines.push("", "**High**", ...shownHigh.map((c) => renderItem(c, reactions)));
  }
  if (shownMedium.length > 0) {
    lines.push("", "**Medium**", ...shownMedium.map((c) => renderItem(c, reactions)));
  }

  if (hiddenFlagged > 0) {
    // Some flagged chunks were over the cap — be explicit that the list is the
    // top slice, not the whole ranking, and fold the Low remainder in.
    const more = hiddenFlagged + lowCount;
    const plural = more === 1 ? "change" : "changes";
    lines.push(
      "",
      `Showing the top ${shown.length} by risk. Plus ${more} more ${plural} ranked lower, not listed.`,
    );
  } else if (lowCount > 0) {
    const plural = lowCount === 1 ? "hunk" : "hunks";
    lines.push("", `Plus ${lowCount} lower-risk ${plural} not listed.`);
  }

  return withCardViewLink(lines, cardViewUrl);
}

/** Append the hosted card-view link when one is configured, then join. */
function withCardViewLink(lines: string[], cardViewUrl?: string): string {
  if (cardViewUrl) {
    lines.push("", `[View the full risk cards →](${cardViewUrl})`);
  }
  return lines.join("\n");
}

function renderItem(chunk: RankedChunk, reactions?: ReactionOptions): string {
  const base = `- **[${chunk.tier}]** [${chunk.file}:${chunk.line}](${chunk.deepLink}) — ${chunk.reason}`;
  return reactions
    ? `${base} ${reactionAffordance(reactions, chunk.fingerprint, chunk.tier)}`
    : base;
}

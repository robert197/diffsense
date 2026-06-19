import type { RiskRating } from "../schemas/chunkReview.js";
import type { Portfolio } from "../schemas/portfolio.js";
import type { VerificationVerdict } from "../schemas/verification.js";
import { type ReactionOptions, type ReactionTier, reactionAffordance } from "./reactionLink.js";
import { MAX_LISTED } from "./renderRankedComment.js";

export type { ReactionOptions } from "./reactionLink.js";

/**
 * The enriched reviewer comment (issue #12, docs/ARCHITECTURE.md §2). Pure, no
 * I/O — `renderComment(portfolio, findings)` turns the PR-level synthesis (#11)
 * and the verified per-chunk findings (#9) into the single advisory comment the
 * worker upserts in place.
 *
 * It leads with the risk portfolio (overview, intent coverage, named risk
 * positions), then the ranked "review these first" findings — each with a deep
 * link to the hunk, an explanation excerpt, and its verification verdict — and a
 * 👍/👎 affordance per finding so the reviewer can mark a catch or noise without
 * leaving GitHub. Tone is strictly advisory: it never blocks, approves, or
 * otherwise touches the merge decision (STRATEGY.md — advisory until trust is
 * earned). The hidden idempotency marker is added by the github adapter.
 */

/** One verified finding as the comment needs it — render concern, not the upstream shape. */
export interface CommentFinding {
  /** File the finding's chunk belongs to. */
  file: string;
  /** Line the deep link points at. */
  line: number;
  /** URL into the PR Files-changed view, anchored at the hunk. */
  deepLink: string;
  /** The finding's risk rating — drives ordering and the reaction link's tier. */
  rating: RiskRating;
  /** Plain-language explanation of the change; excerpted in the comment. */
  explanation: string;
  /** The verification verdict the finding survived with — its proof (#9). */
  verdict: VerificationVerdict;
  /** Structural fingerprint — the reaction link's stable key. */
  fingerprint: string;
}

export interface RenderCommentOptions {
  /** Enables the 👍/👎 reaction links per finding. Absent → no affordance. */
  reactions?: ReactionOptions;
  /** Link to the hosted review view (issue #13). Absent → no link line. */
  reviewUrl?: string;
}

/** Longest an explanation/rationale excerpt runs before it is trimmed to a clause. */
const EXCERPT_MAX = 200;

/** Ordering for the "review first" list — highest risk first, input order within. */
const RATING_ORDER: Record<RiskRating, number> = { high: 0, medium: 1, low: 2 };

export function renderComment(
  portfolio: Portfolio,
  findings: CommentFinding[],
  options: RenderCommentOptions = {},
): string {
  const lines = [
    "### diffsense — risk portfolio",
    "",
    portfolio.overview,
    "",
    `**Intent coverage:** ${portfolio.intentCoverage}`,
  ];

  if (portfolio.positions.length > 0) {
    lines.push("", "**Risk positions**");
    for (const position of portfolio.positions) {
      lines.push(
        `- **[${displayRating(position.severity)}]** ${position.title} — ${position.detail}`,
      );
    }
  }

  lines.push("", "**Review these first**");
  if (findings.length === 0) {
    lines.push("Nothing survived verification. No findings to review first.");
  } else {
    const ordered = [...findings].sort((a, b) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating]);
    const shown = ordered.slice(0, MAX_LISTED);
    shown.forEach((finding, i) => lines.push(...renderFinding(finding, i + 1, options.reactions)));
    const hidden = ordered.length - shown.length;
    if (hidden > 0) {
      const plural = hidden === 1 ? "finding" : "findings";
      lines.push(
        "",
        `Showing the top ${shown.length} by risk. Plus ${hidden} more ${plural}, not listed.`,
      );
    }
  }

  if (options.reviewUrl) {
    lines.push("", `[Open the full review in diffsense →](${options.reviewUrl})`);
  }

  lines.push(
    "",
    "Advisory only: a suggested reading order and risk summary, not a verdict on the PR.",
  );

  return lines.join("\n");
}

function renderFinding(finding: CommentFinding, n: number, reactions?: ReactionOptions): string[] {
  const head = `${n}. **[${displayRating(finding.rating)}]** [${finding.file}:${finding.line}](${finding.deepLink}) — ${excerpt(finding.explanation)}`;
  const verdictLine = `   - Verification: ${verdictSummary(finding.verdict)}`;
  const lines = [head, verdictLine];
  if (reactions) {
    lines.push(
      `   - ${reactionAffordance(reactions, finding.fingerprint, displayRating(finding.rating))}`,
    );
  }
  return lines;
}

/** How a finding's verdict reads in the comment — survivors carry their proof (#9). */
function verdictSummary(verdict: VerificationVerdict): string {
  const status = verdict.refuted
    ? "refuted in the verification pass"
    : "held up under an independent verification challenge";
  return `${status}. ${excerpt(verdict.rationale)}`;
}

/** "high" → "High": display + the capitalized tier the reaction endpoint records. */
function displayRating(rating: RiskRating): ReactionTier {
  return (rating.charAt(0).toUpperCase() + rating.slice(1)) as ReactionTier;
}

/** First line, trimmed to a whole word under EXCERPT_MAX, with an ellipsis when cut. */
function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= EXCERPT_MAX) {
    return oneLine;
  }
  const cut = oneLine.slice(0, EXCERPT_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

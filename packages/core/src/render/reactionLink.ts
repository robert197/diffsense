/**
 * Shared 👍/👎 reaction-link builder for the rendered comments (issue #3, #12).
 *
 * Both the structural ranked comment and the enriched portfolio comment offer a
 * one-click 👍/👎 per flagged item, pointing at the diffsense ingress so a
 * reviewer can mark a flag as a real catch or noise without any separate
 * instrumentation. The endpoint params (`owner`/`repo`/`pr`/`fp`/`tier`/`s`) are
 * exactly what `apps/app`'s `/reactions` route validates, so a single builder
 * keeps the two renderers in lockstep with the ingress.
 */

/** Tier label recorded with a reaction — matches `ChunkReactionSchema.tier`. */
export type ReactionTier = "High" | "Medium" | "Low";

/**
 * Reaction affordance config. When present, each flagged item gets a 👍/👎 link
 * to the ingress. Absent → the comment renders without the affordance, so a
 * renderer never hard-depends on a public URL.
 */
export interface ReactionOptions {
  /** Public base URL of the diffsense ingress (e.g. https://diffsense.example). */
  reactionBaseUrl: string;
  pr: { owner: string; repo: string; prNumber: number };
}

/** `[👍](url) / [👎](url)` linking to the reaction endpoint for this item. */
export function reactionAffordance(
  options: ReactionOptions,
  fingerprint: string,
  tier: ReactionTier,
): string {
  const up = reactionUrl(options, fingerprint, tier, "up");
  const down = reactionUrl(options, fingerprint, tier, "down");
  return `[👍](${up}) / [👎](${down})`;
}

function reactionUrl(
  { reactionBaseUrl, pr }: ReactionOptions,
  fingerprint: string,
  tier: ReactionTier,
  sentiment: "up" | "down",
): string {
  const params = new URLSearchParams({
    owner: pr.owner,
    repo: pr.repo,
    pr: String(pr.prNumber),
    fp: fingerprint,
    tier,
    s: sentiment,
  });
  return `${reactionBaseUrl.replace(/\/$/, "")}/reactions?${params.toString()}`;
}

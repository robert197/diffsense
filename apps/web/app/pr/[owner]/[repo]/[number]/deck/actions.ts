"use server";

import { recordSwipe as persistSwipe } from "../../../../../../lib/deck";

/**
 * Record a swipe decision from the deck UI (issue #27). Validates the form input
 * and appends an advisory 👍/👎 reaction for the card's chunk. Mirrors the #13
 * `refute` action; it writes a signal and never gates merge. No `revalidatePath`
 * — the client component owns advancing the deck and the progress indicator, so a
 * server-driven refresh would fight the swipe animation.
 */

const TIERS = new Set(["High", "Medium", "Low"]);
const SENTIMENTS = new Set(["up", "down"]);

export async function recordSwipe(formData: FormData): Promise<void> {
  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumber = Number(formData.get("prNumber"));
  const fingerprint = String(formData.get("fingerprint") ?? "");
  const tier = String(formData.get("tier") ?? "");
  const sentiment = String(formData.get("sentiment") ?? "");

  if (
    !owner ||
    !repo ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    !fingerprint ||
    !TIERS.has(tier) ||
    !SENTIMENTS.has(sentiment)
  ) {
    return;
  }

  await persistSwipe({ owner, repo, prNumber }, fingerprint, tier, sentiment as "up" | "down");
}

"use server";

import { getSession } from "../../../../../../lib/auth/session";
import { recordSwipe as persistSwipe } from "../../../../../../lib/deck";

/**
 * Record a swipe decision from the deck UI (issue #27). A `"use server"` action is
 * an independently-invokable POST endpoint — the deck page's `requireSession` gates
 * the render, not this write — so it re-checks the session itself: an unauthenticated
 * call is a silent no-op. It then validates the form input and appends an advisory
 * 👍/👎 reaction for the card's chunk. Mirrors the #13 `refute` action; it writes a
 * signal and never gates merge. No `revalidatePath` — the client component owns
 * advancing the deck and the progress indicator, so a server-driven refresh would
 * fight the swipe animation.
 *
 * Authorization (does this session user have access to *this* repo/PR?) is a known
 * gap shared with the #13 `refute` action and tracked as a separate cross-cutting
 * effort: the `reactions` table is append-only and carries no merge/approve/block
 * authority, so the residual impact is precision-signal pollution, not a
 * confidentiality or gate breach.
 */

const TIERS = new Set(["High", "Medium", "Low"]);
const SENTIMENTS = new Set(["up", "down"]);

export async function recordSwipe(formData: FormData): Promise<void> {
  // Authentication gate: a signed-out caller hitting the action directly is dropped.
  if (!(await getSession())) {
    return;
  }

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
    console.warn("[deck] recordSwipe dropped malformed input");
    return;
  }

  try {
    await persistSwipe({ owner, repo, prNumber }, fingerprint, tier, sentiment as "up" | "down");
  } catch (err) {
    // The write is advisory and fired fire-and-forget from the client, so a failure
    // must not surface as an error — but it must not vanish either. Log it so silent
    // signal loss is visible in server logs.
    console.error(`[deck] recordSwipe failed for ${owner}/${repo}#${prNumber}:`, err);
  }
}

"use server";

import { type PostedComment, cardCommentAnchor, isSupportedLanguage } from "@diffsense/core";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getSession } from "../../../../../../lib/auth/session";
import { getLatestDeck, recordSwipe as persistSwipe } from "../../../../../../lib/deck";
import {
  GitHubAuthError,
  GitHubPermissionError,
  GitHubRateLimitError,
} from "../../../../../../lib/github";
import { LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE } from "../../../../../../lib/language";
import { recordPostedComment } from "../../../../../../lib/prComments";
import { recordDecision } from "../../../../../../lib/reviewProgress";

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
  const session = await getSession();
  if (!session) {
    return;
  }

  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumber = Number(formData.get("prNumber"));
  const headSha = String(formData.get("headSha") ?? "");
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

  const decision = sentiment as "up" | "down";

  try {
    await persistSwipe({ owner, repo, prNumber }, fingerprint, tier, decision);
  } catch (err) {
    // The write is advisory and fired fire-and-forget from the client, so a failure
    // must not surface as an error — but it must not vanish either. Log it so silent
    // signal loss is visible in server logs.
    console.error(`[deck] recordSwipe failed for ${owner}/${repo}#${prNumber}:`, err);
  }

  // Persist the per-reviewer resume state (issue #29): one decision per card, keyed by
  // the signed-in user + PR + head SHA, so a reload/logout/device-switch picks up at the
  // next unreviewed card. A missing head SHA (older client) skips this write but still
  // records the reaction above. Failures are logged, never thrown — the swipe is advisory
  // and fired fire-and-forget from the client.
  if (headSha) {
    try {
      await recordDecision(
        { githubUserId: session.userId, owner, repo, prNumber, headSha },
        fingerprint,
        decision,
      );
    } catch (err) {
      console.error(`[deck] recordDecision failed for ${owner}/${repo}#${prNumber}:`, err);
    }
  }
}

/**
 * Set the reviewer's spoken language for card prose (issue #28). The deck's
 * `<LanguagePicker>` form posts here; we re-check the session (this is an
 * independently-invokable endpoint), validate the chosen code against the supported
 * set, store it in the `df_lang` cookie, and revalidate the deck route so the server
 * re-renders the cards in the new language. An unsupported/empty value is dropped —
 * the deck then falls back to English. Purely a display preference: it never gates a
 * merge and carries no authority.
 */
export async function setLanguage(formData: FormData): Promise<void> {
  if (!(await getSession())) {
    return;
  }

  const lang = String(formData.get("lang") ?? "");
  if (!isSupportedLanguage(lang)) {
    console.warn("[deck] setLanguage dropped unsupported language");
    return;
  }

  const store = await cookies();
  store.set(LANGUAGE_COOKIE, lang, {
    maxAge: LANGUAGE_COOKIE_MAX_AGE,
    sameSite: "lax",
    httpOnly: true,
    // Match the app's cookie convention (sessionCookieOptions): Secure in
    // production so the preference isn't sent over plaintext. Computed the same way
    // as AuthConfig.secureCookies without pulling in the OAuth-secret validation.
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumber = String(formData.get("prNumber") ?? "");
  if (owner && repo && prNumber) {
    revalidatePath(`/pr/${owner}/${repo}/${prNumber}/deck`);
  }
}

// GitHub's comment ceiling, mirrored from the core `PrCommentInputSchema` bound so
// an over-long body is rejected with a clear message rather than a 422 at post time.
const MAX_COMMENT_LENGTH = 65_536;

/**
 * The result the comment composer renders via `useActionState`. Unlike `recordSwipe`
 * (a fire-and-forget signal that returns `void`), posting a PR comment must report
 * success (a link to the posted comment) or failure (a clear message) to the reviewer
 * — issue #30 AC: failures (permissions, rate limits) are surfaced clearly.
 */
export interface PostCommentState {
  ok: boolean;
  error?: string;
  comment?: { htmlUrl: string; kind: "review" | "issue" };
}

/**
 * Post a reviewer's comment to the PR from a deck card (issue #30). Reviewer-initiated
 * (the card's Post button drives it; nothing auto-posts — the product stays advisory
 * and low-noise) and attributed to the reviewer via their OAuth-bound client. The
 * comment goes out through the `GitHubGateway` port (`session.github.postComment`),
 * anchored to the card's file + lines when the card points at added code and falling
 * back to a PR-conversation comment otherwise. The posted comment is recorded so the
 * card reflects it on the next read. Re-checks the session itself (this is an
 * independently-invokable endpoint) and returns a `PostCommentState` the composer shows.
 */
export async function postCardComment(
  _prev: PostCommentState,
  formData: FormData,
): Promise<PostCommentState> {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "Sign in to comment on this PR." };
  }

  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumber = Number(formData.get("prNumber"));
  const fingerprint = String(formData.get("fingerprint") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0 || !fingerprint) {
    console.warn("[deck] postCardComment dropped malformed input");
    return { ok: false, error: "Something went wrong — couldn't identify the card to comment on." };
  }
  if (!body) {
    return { ok: false, error: "Write a comment before posting." };
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    return { ok: false, error: `Comment is too long (max ${MAX_COMMENT_LENGTH} characters).` };
  }

  // Recompute the anchor from the persisted card — never trust a client-sent anchor —
  // so it always matches a real card and is anchored to the deck's head commit.
  const deck = await getLatestDeck({ owner, repo, prNumber }).catch((err) => {
    console.error(`[deck] postCardComment deck read failed for ${owner}/${repo}#${prNumber}:`, err);
    return null;
  });
  const card = deck?.cards.find((c) => c.fingerprint === fingerprint) ?? null;
  if (!deck || !card) {
    return { ok: false, error: "This card is no longer part of the current deck." };
  }
  const anchor = cardCommentAnchor(card, deck.headSha) ?? undefined;

  let posted: PostedComment;
  try {
    posted = await session.github.postComment({ owner, repo, prNumber }, { body, anchor });
  } catch (err) {
    return { ok: false, error: postCommentError(err) };
  }

  // The comment is already on GitHub — a persistence failure must not report failure
  // to the reviewer. Log it and still return success; the reflection is best-effort.
  try {
    await recordPostedComment(
      { githubUserId: session.userId, owner, repo, prNumber, headSha: deck.headSha },
      {
        fingerprint,
        body,
        githubCommentId: posted.id,
        htmlUrl: posted.htmlUrl,
        kind: posted.kind,
      },
    );
  } catch (err) {
    console.error(`[deck] recordPostedComment failed for ${owner}/${repo}#${prNumber}:`, err);
  }

  // No `revalidatePath` here: the composer shows the posted link inline (its
  // `useActionState` result), and a server-driven refresh would re-render the whole
  // deck — re-fetching every card's file content and fighting the client deck state,
  // the same reason `recordSwipe` avoids it. The persisted comment is reflected onto
  // the card on the next natural deck load.
  return { ok: true, comment: { htmlUrl: posted.htmlUrl, kind: posted.kind } };
}

/** Map a post failure to a clear, reviewer-facing message (issue #30 AC#5). */
function postCommentError(err: unknown): string {
  if (err instanceof GitHubAuthError) {
    return "Your GitHub session expired — sign in again to comment.";
  }
  if (err instanceof GitHubPermissionError) {
    return "You don't have permission to comment on this PR.";
  }
  if (err instanceof GitHubRateLimitError) {
    return "GitHub rate limit hit — try again shortly.";
  }
  console.error("[deck] postCardComment failed:", err);
  return "Couldn't post the comment — please try again.";
}

import { requireSession } from "../../lib/auth/session";
import { deckProgress } from "../../lib/codeWindow";
import { type InProgressReview, listInProgress } from "../../lib/reviewProgress";
import {
  badge,
  list,
  muted,
  page,
  progressFill,
  progressTrack,
  relativeTime,
  row,
} from "../../lib/ui";

/**
 * The "Continue reviewing" dashboard (issue #29). Lists the signed-in reviewer's
 * in-progress decks with how far through each they are (e.g. 7 / 19 cards) and a
 * resume link straight back into the deck — where they pick up at the next unreviewed
 * card. A read-model over `review_progress` joined with `decks`: it never triggers a
 * review or gates a merge. Decks built against an older PR head than the latest
 * processed one are badged stale (the re-process path).
 */

export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const session = await requireSession();
  const reviews = await listInProgress(session.userId);

  return (
    <main style={page}>
      <header style={{ marginBottom: "1.25rem" }}>
        <a href="/repos" style={{ ...muted, textDecoration: "none" }}>
          ← Repositories
        </a>
        <h1 style={{ fontSize: "1.4rem", margin: "0.4rem 0 0" }}>Continue reviewing</h1>
        <p style={{ ...muted, margin: "0.3rem 0 0", lineHeight: 1.5 }}>
          Decks you&apos;ve started but not finished. Your place is saved on every swipe — pick up
          right where you left off, on any device.
        </p>
      </header>

      {reviews.length === 0 ? (
        <p style={{ opacity: 0.7, lineHeight: 1.5 }}>
          No reviews in progress. Swipe through a PR&apos;s deck and your place is saved here.
        </p>
      ) : (
        <ul style={list}>
          {reviews.map((review) => (
            <li key={`${review.owner}/${review.repo}#${review.prNumber}@${review.headSha}`}>
              <ReviewRow review={review} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ReviewRow({ review }: { review: InProgressReview }) {
  const { percent } = deckProgress(review.reviewed, review.total);
  return (
    <a href={`/pr/${review.owner}/${review.repo}/${review.prNumber}/deck`} style={row}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ fontWeight: 600 }}>
          {review.owner}/{review.repo} #{review.prNumber}
        </span>
        {review.stale && <span style={badge}>Stale</span>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.5rem" }}>
        {/* Stretch the shared track across the row with flex; the fill is the brand bar. */}
        <div style={{ ...progressTrack, flex: 1 }} aria-hidden="true">
          <div style={{ ...progressFill, width: `${percent}%` }} />
        </div>
        <span style={{ ...muted, whiteSpace: "nowrap" }}>
          {review.reviewed} / {review.total} cards
        </span>
      </div>

      <span style={{ ...muted, display: "block", marginTop: "0.35rem" }}>
        Updated {relativeTime(review.updatedAt.toISOString())}
        {review.stale ? " · new commits since — a fresh deck will appear once reprocessed" : ""}
      </span>
    </a>
  );
}

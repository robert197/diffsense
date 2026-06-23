import { CheckCircle2, GitMerge, Layers, PlayCircle, XCircle } from "lucide-react";
import { AppHeader } from "../../components/site/AppHeader";
import { Badge } from "../../components/ui/badge";
import { Progress } from "../../components/ui/progress";
import { requireSession } from "../../lib/auth/session";
import { deckProgress } from "../../lib/codeWindow";
import {
  type ArchivedReview,
  type InProgressReview,
  listReviewSessions,
} from "../../lib/reviewProgress";
import { relativeTime } from "../../lib/ui";

/**
 * The reviewer dashboard (issue #29 + #31). "Continue reviewing" lists the signed-in
 * reviewer's in-progress decks with how far through each they are and a resume link
 * back into the deck. "Done" lists sessions whose PR has merged or closed in the
 * background — badged and moved out of the active list so finished work stops drawing
 * attention. A read-model over `review_progress` joined with `decks` and `pr_status`:
 * it never triggers a review or gates a merge. Decks built against an older PR head
 * than the latest processed one are badged stale (the re-process path).
 */

export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const session = await requireSession();
  const { active, archived } = await listReviewSessions(session.userId);

  return (
    <>
      <AppHeader login={session.login} crumbs={[{ label: "Reviews" }]} />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Continue reviewing</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Decks you&apos;ve started but not finished. Your place is saved on every swipe — pick up
            right where you left off, on any device.
          </p>
        </div>

        {active.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
              <Layers className="size-6" />
            </div>
            <p className="font-medium">No reviews in progress</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Swipe through a PR&apos;s deck and your place is saved here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {active.map((review) => (
              <li key={`${review.owner}/${review.repo}#${review.prNumber}@${review.headSha}`}>
                <ReviewRow review={review} />
              </li>
            ))}
          </ul>
        )}

        {archived.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Done</h2>
            <p className="mt-1 mb-3 text-sm text-muted-foreground">
              Reviews whose pull request has since merged or closed — moved here automatically.
            </p>
            <ul className="flex flex-col gap-2">
              {archived.map((review) => (
                <li key={`${review.owner}/${review.repo}#${review.prNumber}@${review.headSha}`}>
                  <ArchivedRow review={review} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

function ReviewRow({ review }: { review: InProgressReview }) {
  const { percent } = deckProgress(review.reviewed, review.total);
  return (
    <a
      href={`/pr/${review.owner}/${review.repo}/${review.prNumber}/deck`}
      className="group block rounded-xl border border-border bg-card p-4 transition-colors hover:border-ring/40 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center gap-2">
        <PlayCircle className="size-4 shrink-0 text-primary" />
        <span className="truncate font-medium">
          {review.owner}/{review.repo} #{review.prNumber}
        </span>
        {review.stale && <Badge variant="warning">Stale</Badge>}
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {review.reviewed} / {review.total}
        </span>
      </div>

      <Progress value={percent} className="mt-3" />

      <p className="mt-2 text-xs text-muted-foreground">
        Updated {relativeTime(review.updatedAt.toISOString())}
        {review.stale ? " · new commits since — a fresh deck will appear once reprocessed" : ""}
      </p>
    </a>
  );
}

/**
 * A finished session — its PR has merged or closed. Rendered as a non-interactive row
 * (no resume link): the work is done, the badge says how the PR ended.
 */
function ArchivedRow({ review }: { review: ArchivedReview }) {
  const merged = review.status === "merged";
  const label = merged ? "Merged" : "Closed";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 opacity-80">
      <div className="flex items-center gap-2">
        {merged ? (
          <GitMerge className="size-4 shrink-0 text-[#a78bfa]" />
        ) : (
          <XCircle className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-medium">
          {review.owner}/{review.repo} #{review.prNumber}
        </span>
        <Badge variant={merged ? "primary" : "outline"} className="ml-auto gap-1">
          <CheckCircle2 />
          {label}
        </Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {review.reviewed} / {review.total} cards · {label.toLowerCase()}{" "}
        {relativeTime(review.updatedAt.toISOString())}
      </p>
    </div>
  );
}

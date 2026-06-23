import type { Card, CardDecision } from "@diffsense/core";
import { Clock3, Layers, ListTree } from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "../../../../../../components/site/AppHeader";
import {
  type ActiveSession,
  clearSessionRow,
  requireSession,
} from "../../../../../../lib/auth/session";
import { type CardView, toCardView } from "../../../../../../lib/codeWindow";
import { getLatestDeck, resolveCardFileTexts } from "../../../../../../lib/deck";
import { GitHubAuthError } from "../../../../../../lib/github";
import { LANGUAGE_COOKIE, resolveLanguageCookie } from "../../../../../../lib/language";
import { localizeDeckCards } from "../../../../../../lib/localize";
import {
  type PostedCardComment,
  groupPostedComments,
  listPostedComments,
} from "../../../../../../lib/prComments";
import { computeResume, getDecidedFingerprints } from "../../../../../../lib/reviewProgress";
import { LanguagePicker } from "./LanguagePicker";
import { SwipeDeck } from "./SwipeDeck";
import { postCardComment, recordSwipe } from "./actions";

/**
 * The swipe deck review surface (issue #27) — the heart of the product. A
 * read-model over the `decks` table (#26): a PR's deck renders as swipeable cards,
 * riskiest first, so swiping the whole deck means every changed hunk has been seen.
 * This server component owns all I/O — auth, the deck read, and a bounded GitHub
 * content read to show the highlighted code — then hands plain, serializable card
 * data plus the `recordSwipe` action to the client `SwipeDeck`. Strictly advisory:
 * no merge/approve/block control anywhere on this surface.
 */

export const dynamic = "force-dynamic";

// Bound the per-deck GitHub content reads so a large PR cannot fan out unbounded
// calls. Files beyond the cap (or that fail to fetch) degrade to a descriptive
// highlight label rather than breaking the deck.
const MAX_CODE_FETCHES = 30;

type Params = { owner: string; repo: string; number: string };

export default async function DeckPage({ params }: { params: Promise<Params> }) {
  const { owner, repo, number } = await params;
  const prNumber = Number(number);
  const session = await requireSession();

  const language = resolveLanguageCookie((await cookies()).get(LANGUAGE_COOKIE)?.value);
  const deck = Number.isInteger(prNumber) ? await getLatestDeck({ owner, repo, prNumber }) : null;

  // Everything below hangs off the loaded deck and is mutually independent, so run it
  // concurrently rather than chaining the awaits:
  //  - the cards' prose translated into the reviewer's language (DB + maybe LLM; a
  //    no-op for English, graceful English fallback on failure — only prose changes),
  //  - this reviewer's persisted decisions for the deck's head SHA (issue #29),
  //  - the live-head staleness check (one GitHub round-trip — AC#5).
  // Keeping the GitHub call off the critical path means it overlaps the translation
  // rather than adding to it.
  const [cards, decisions, stale, postedComments] = deck
    ? await Promise.all([
        localizeDeckCards(deck.cards, language, { owner, repo }),
        // Resume is advisory: a transient failure on the decisions read must not
        // 500 the whole deck. Degrade to "no decisions" (start at card 0) and log,
        // matching the graceful fallback `localizeDeckCards` uses for its prose.
        getDecidedFingerprints({
          githubUserId: session.userId,
          owner,
          repo,
          prNumber,
          headSha: deck.headSha,
        }).catch((err): CardDecision[] => {
          console.error(
            `[deck] getDecidedFingerprints failed for ${owner}/${repo}#${prNumber}; resuming from the start:`,
            err,
          );
          return [];
        }),
        resolveStaleDeck(session, owner, repo, prNumber, deck.headSha),
        // The reviewer's already-posted comments for this deck (issue #30), reflected
        // back onto each card. Best-effort like the decisions read: a transient
        // failure degrades to "none posted" rather than 500-ing the deck.
        listPostedComments({
          githubUserId: session.userId,
          owner,
          repo,
          prNumber,
          headSha: deck.headSha,
        }).catch((err): PostedCardComment[] => {
          console.error(
            `[deck] listPostedComments failed for ${owner}/${repo}#${prNumber}; showing none:`,
            err,
          );
          return [];
        }),
      ])
    : ([[], [], false, []] as [Card[], CardDecision[], boolean, PostedCardComment[]]);

  // A divergent live head SHA means the deck was built against an earlier commit (the
  // re-process path); the resume index + prior tally come from the decisions above.
  const resume = deck
    ? computeResume(deck.cards, decisions)
    : { index: 0, counts: { up: 0, down: 0 } };

  return (
    <>
      <AppHeader
        login={session.login}
        crumbs={[
          { label: "Repositories", href: "/repos" },
          { label: `${owner}/${repo}`, href: `/repos/${owner}/${repo}/pulls` },
          { label: `#${prNumber}` },
        ]}
      />
      <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-primary">
                <Layers className="size-4.5" />
              </span>
              <div>
                <h1 className="text-lg font-semibold leading-tight tracking-tight">
                  {owner}/{repo} #{prNumber}
                </h1>
                <a
                  href={`/pr/${owner}/${repo}/${prNumber}`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ListTree className="size-3" />
                  View findings list
                </a>
              </div>
            </div>
            <LanguagePicker current={language} owner={owner} repo={repo} prNumber={prNumber} />
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Riskiest changes first. Swipe <span className="font-medium text-success">right</span> if
            it looks good, <span className="font-medium text-destructive">left</span> to flag.
            Advisory only — your swipes are signal, not a verdict.
          </p>
        </div>

        {stale && <StaleNotice href={`/pr/${owner}/${repo}/${prNumber}/deck`} />}

        {deck === null ? (
          <EmptyDeck />
        ) : (
          <SwipeDeck
            cards={
              await buildCardViews(
                session.github,
                owner,
                repo,
                deck.headSha,
                cards,
                groupPostedComments(postedComments),
              )
            }
            owner={owner}
            repo={repo}
            prNumber={prNumber}
            headSha={deck.headSha}
            initialIndex={resume.index}
            initialCounts={resume.counts}
            recordSwipe={recordSwipe}
            postComment={postCardComment}
          />
        )}
      </main>
    </>
  );
}

function EmptyDeck() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
        <Clock3 className="size-6" />
      </div>
      <p className="font-medium">This deck isn&apos;t ready yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Once the engine has processed the PR, its cards appear here to swipe through.
      </p>
    </div>
  );
}

/**
 * Is the deck stale (issue #29, AC#5)? Compare the deck's head SHA against the PR's
 * live head from GitHub. A `401` clears the session and redirects (consistent with
 * the rest of the entry path); a rate-limit/transient failure can't decide staleness,
 * so the deck renders normally rather than blocking on a banner that may be wrong.
 */
async function resolveStaleDeck(
  session: ActiveSession,
  owner: string,
  repo: string,
  prNumber: number,
  deckHeadSha: string,
): Promise<boolean> {
  try {
    const live = await session.github.getPullRequestHead(owner, repo, prNumber);
    return !!live && live.headSha !== deckHeadSha;
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      await clearSessionRow();
      redirect("/login");
    }
    // A rate-limit/transient failure can't decide staleness, so the deck renders
    // normally rather than blocking on a banner that may be wrong. Log it so the
    // swallowed failure stays observable (e.g. a rate-limit surge on this check).
    console.warn(
      `[deck] stale-deck check failed for ${owner}/${repo}#${prNumber}; rendering without the stale banner:`,
      err,
    );
    return false;
  }
}

/** Advisory banner: the deck predates the PR's current commit (the re-process path). */
function StaleNotice({ href }: { href: string }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-tier-medium/40 bg-tier-medium-fill px-4 py-3 text-sm leading-relaxed text-tier-medium">
      <Clock3 className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-semibold">This deck is out of date.</span> The pull request has new
        commits since this deck was built, so it reviews older code. Your place is saved — a fresh
        deck appears once the engine reprocesses the new commit.{" "}
        <a href={href} className="font-semibold underline underline-offset-2">
          Refresh
        </a>
      </p>
    </div>
  );
}

/**
 * Resolve each card's highlighted code from the file content at the deck's head SHA,
 * deduped per file and capped (via `resolveCardFileTexts`). A per-file fetch failure
 * (rate-limit, 404, binary, transient) degrades that card to its highlight label; a
 * GitHub 401 clears the session and redirects to login, matching the rest of the
 * entry path. A card whose file was not fetched (beyond the cap) degrades too.
 */
async function buildCardViews(
  github: Awaited<ReturnType<typeof requireSession>>["github"],
  owner: string,
  repo: string,
  headSha: string,
  cards: Card[],
  postedByFingerprint: Map<string, PostedCardComment[]>,
): Promise<CardView[]> {
  let fileText: Map<string, string | null>;
  try {
    fileText = await resolveCardFileTexts(
      github,
      owner,
      repo,
      headSha,
      cards.map((c) => c.file),
      MAX_CODE_FETCHES,
    );
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      await clearSessionRow();
      redirect("/login");
    }
    throw err;
  }

  return cards.map((card) =>
    toCardView(
      card,
      fileText.get(card.file) ?? null,
      postedByFingerprint.get(card.fingerprint) ?? [],
    ),
  );
}

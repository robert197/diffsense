import { type Card, type CardDecision, resumeState } from "@diffsense/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
import { getDecidedFingerprints } from "../../../../../../lib/reviewProgress";
import { page } from "../../../../../../lib/ui";
import { LanguagePicker } from "./LanguagePicker";
import { SwipeDeck } from "./SwipeDeck";
import { recordSwipe } from "./actions";

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

  // Translate the cards' prose into the reviewer's language (a no-op for English,
  // graceful English fallback on any failure). Only explanation + suggestions change.
  const cards = deck ? await localizeDeckCards(deck.cards, language, { owner, repo }) : [];

  // Resume state (issue #29): read this reviewer's persisted decisions for the deck's
  // head SHA and resolve where to pick up + the prior tally. A divergent live head SHA
  // means the deck was built against an earlier commit (the re-process path).
  const decisions = deck
    ? await getDecidedFingerprints({
        githubUserId: session.userId,
        owner,
        repo,
        prNumber,
        headSha: deck.headSha,
      })
    : [];
  const resume = deck
    ? computeResume(deck.cards, decisions)
    : { index: 0, counts: { up: 0, down: 0 } };
  const stale = deck ? await resolveStaleDeck(session, owner, repo, prNumber, deck.headSha) : false;

  return (
    <main style={page}>
      <header style={{ marginBottom: "1.25rem" }}>
        <a
          href={`/pr/${owner}/${repo}/${prNumber}`}
          style={{ opacity: 0.6, textDecoration: "none" }}
        >
          ← Findings list
        </a>
        <h1 style={{ fontSize: "1.4rem", margin: "0.4rem 0 0" }}>
          {owner}/{repo} #{prNumber}
        </h1>
        <p style={{ opacity: 0.65, margin: "0.35rem 0 0", lineHeight: 1.5 }}>
          Swipe through the deck — riskiest changes first. Right if it looks good, left to flag.
          Advisory only: your swipes are signal, not a verdict.
        </p>
        <LanguagePicker current={language} owner={owner} repo={repo} prNumber={prNumber} />
      </header>

      {stale && <StaleNotice href={`/pr/${owner}/${repo}/${prNumber}/deck`} />}

      {deck === null ? (
        <p style={{ opacity: 0.6, lineHeight: 1.5 }}>
          This PR's deck isn't ready yet. Once the engine has processed the PR, its cards will
          appear here to swipe through.
        </p>
      ) : (
        <SwipeDeck
          cards={await buildCardViews(session.github, owner, repo, deck.headSha, cards)}
          owner={owner}
          repo={repo}
          prNumber={prNumber}
          headSha={deck.headSha}
          initialIndex={resume.index}
          initialCounts={resume.counts}
          recordSwipe={recordSwipe}
        />
      )}
    </main>
  );
}

/**
 * Resume point + prior tally from the reviewer's persisted decisions (issue #29).
 * The next card is the first undecided one (`resumeState`); the up/down tally counts
 * only decisions whose card is still in this deck, so the progress reflects the
 * resumed work without inflating from decisions on a different head.
 */
function computeResume(
  cards: Card[],
  decisions: CardDecision[],
): { index: number; counts: { up: number; down: number } } {
  const deckFingerprints = new Set(cards.map((c) => c.fingerprint));
  const counts = decisions.reduce(
    (acc, d) => {
      if (deckFingerprints.has(d.fingerprint)) {
        acc[d.decision] += 1;
      }
      return acc;
    },
    { up: 0, down: 0 },
  );
  const { nextIndex } = resumeState(
    cards,
    decisions.map((d) => d.fingerprint),
  );
  return { index: nextIndex, counts };
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
    return false;
  }
}

/** Advisory banner: the deck predates the PR's current commit (the re-process path). */
function StaleNotice({ href }: { href: string }) {
  return (
    <div
      style={{
        marginBottom: "1.1rem",
        padding: "0.7rem 0.9rem",
        borderRadius: 10,
        border: "1px solid #b45309",
        background: "rgba(180, 83, 9, 0.12)",
        color: "#fbbf24",
        lineHeight: 1.5,
        fontSize: "0.88rem",
      }}
    >
      <strong>This deck is out of date.</strong> The pull request has new commits since this deck
      was built, so it reviews older code. Your place is saved — a fresh deck appears here once the
      engine reprocesses the new commit.{" "}
      <a href={href} style={{ color: "#fbbf24", fontWeight: 600 }}>
        Refresh
      </a>
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

  return cards.map((card) => toCardView(card, fileText.get(card.file) ?? null));
}

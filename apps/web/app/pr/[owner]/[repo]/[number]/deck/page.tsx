import type { Card } from "@diffsense/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clearSessionRow, requireSession } from "../../../../../../lib/auth/session";
import { type CardView, toCardView } from "../../../../../../lib/codeWindow";
import { getLatestDeck, resolveCardFileTexts } from "../../../../../../lib/deck";
import { GitHubAuthError } from "../../../../../../lib/github";
import { LANGUAGE_COOKIE, resolveLanguageCookie } from "../../../../../../lib/language";
import { localizeDeckCards } from "../../../../../../lib/localize";
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
          recordSwipe={recordSwipe}
        />
      )}
    </main>
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

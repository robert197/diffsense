import type { LLMProvider } from "../ports/llmProvider.js";
import type { LocalizationStore } from "../ports/localizationStore.js";
import type { Card } from "../schemas/card.js";
import { DEFAULT_LANGUAGE, type LanguageCode } from "../schemas/localization.js";

/**
 * The card-localization pass (issue #28, docs/ARCHITECTURE.md §2–§3). Pure
 * orchestration over injected ports — deterministic and fully unit-testable with
 * fakes (no network, no DB). It turns English cards into cards whose prose is in
 * the reviewer's chosen language, touching *only* `explanation` + `suggestions`:
 * `fingerprint`, `file`, `tier`, `rank`, `riskScore`, and `highlights` are carried
 * through untouched, so code, identifiers, and risk signals are never altered.
 *
 * Determinism the deterministic shell demands lives here; the judgment (the actual
 * translation) stays inside `LLMProvider.localizeCard`. The pass is cache-first so
 * re-opening a deck never re-spends inference, and it degrades to English per card
 * so one failed translation never breaks the deck.
 */

export interface LocalizePorts {
  /** Only the localize seam is needed — keeps fakes minimal. */
  llm: Pick<LLMProvider, "localizeCard">;
  store: LocalizationStore;
}

/** Repo coordinates for the cache key (the per-card fingerprint comes from the card). */
export interface LocalizeRef {
  owner: string;
  repo: string;
}

/**
 * Translate every card's prose into `language`, in input order.
 *
 * English is the source language: when `language` is English the cards are returned
 * unchanged with zero provider/store I/O — the common path spends no inference and
 * trivially cannot alter any field. For any other language each card is localized
 * independently (concurrently); a per-card failure degrades that one card to its
 * English prose.
 */
export async function localizeCards(
  cards: readonly Card[],
  language: LanguageCode,
  ref: LocalizeRef,
  ports: LocalizePorts,
): Promise<Card[]> {
  if (language === DEFAULT_LANGUAGE) {
    return [...cards];
  }
  return Promise.all(cards.map((card) => localizeOneCard(card, language, ref, ports)));
}

/**
 * Localize one card: cache hit → reuse; miss → translate via the provider and cache
 * the result; any error (cache read, translation) → return the original English
 * card. The localized fields are spread *onto* the original card, so every non-prose
 * field is structurally identical to the input.
 */
async function localizeOneCard(
  card: Card,
  language: LanguageCode,
  ref: LocalizeRef,
  ports: LocalizePorts,
): Promise<Card> {
  const key = {
    owner: ref.owner,
    repo: ref.repo,
    fingerprint: card.fingerprint,
    language,
  };

  try {
    const cached = await ports.store.get(key);
    if (cached) {
      return { ...card, explanation: cached.explanation, suggestions: cached.suggestions };
    }

    const localized = await ports.llm.localizeCard({
      explanation: card.explanation,
      suggestions: card.suggestions,
      language,
    });

    // Best-effort cache write: a save failure must not lose the freshly translated
    // prose, so it is swallowed (logged) and the localized card is still returned.
    try {
      await ports.store.save(key, localized);
    } catch (saveErr) {
      console.error(
        `[localize] cache save failed for ${ref.owner}/${ref.repo} ${card.fingerprint} (${language}):`,
        saveErr,
      );
    }

    return { ...card, explanation: localized.explanation, suggestions: localized.suggestions };
  } catch (err) {
    // Graceful English fallback — the card keeps its original prose. Logged so a
    // localization outage is visible rather than silently serving English.
    console.error(
      `[localize] falling back to English for ${ref.owner}/${ref.repo} ${card.fingerprint} (${language}):`,
      err,
    );
    return card;
  }
}

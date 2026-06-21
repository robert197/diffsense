import type { LLMProvider } from "../ports/llmProvider.js";
import type { LocalizationStore } from "../ports/localizationStore.js";
import type { Card } from "../schemas/card.js";
import {
  DEFAULT_LANGUAGE,
  type LanguageCode,
  type LocalizedCard,
} from "../schemas/localization.js";

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
 * Max provider/cache calls in flight during one localization pass. Bounds the
 * cold-cache fan-out so a large deck cannot fire one LLM call per card at once
 * (the plan's "bounded concurrency" mitigation, mirroring how `resolveCardFileTexts`
 * caps its GitHub reads). Without this a first open of an N-card deck in a new
 * language would burst N simultaneous inference calls into the server render —
 * rate-limit storm, render stall, and uncontrolled cost.
 */
export const LOCALIZE_CONCURRENCY = 6;

/**
 * Translate every card's prose into `language`, in input order.
 *
 * English is the source language: when `language` is English the cards are returned
 * unchanged with zero provider/store I/O — the common path spends no inference and
 * trivially cannot alter any field. For any other language each card is localized
 * independently, with at most `concurrency` calls in flight; a per-card failure
 * degrades that one card to its English prose.
 */
export async function localizeCards(
  cards: readonly Card[],
  language: LanguageCode,
  ref: LocalizeRef,
  ports: LocalizePorts,
  concurrency: number = LOCALIZE_CONCURRENCY,
): Promise<Card[]> {
  if (language === DEFAULT_LANGUAGE) {
    return [...cards];
  }
  return mapWithConcurrency(cards, Math.max(1, concurrency), (card) =>
    localizeOneCard(card, language, ref, ports),
  );
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input
 * order in the result. A bounded worker pool: `limit` workers each pull the next
 * index until the list is drained, so the pass never has more than `limit`
 * provider/cache calls outstanding regardless of deck size.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    let index = cursor++;
    while (index < items.length) {
      // index is bounded by items.length, so the element is defined.
      results[index] = await fn(items[index] as T, index);
      index = cursor++;
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * True when a localized payload keeps the source card's suggestion count. The deck
 * renders `suggestions` as a flat, position-stable list of "what could be wrong"
 * prompts, so a translation that drops, adds, or merges an item cannot be paired
 * 1:1 with the source. Rather than silently lose a risk prompt, such a card is
 * degraded to English (same per-card fallback used for errors) — code, identifiers,
 * and risk signals are already protected by `LocalizedCardSchema`'s prose-only shape.
 */
function preservesSuggestionCount(card: Card, localized: LocalizedCard): boolean {
  return localized.suggestions.length === card.suggestions.length;
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
      // A stored translation whose suggestion count no longer matches the card
      // (cached before this guard, or the source prompts changed for the same
      // fingerprint) cannot be paired 1:1 — degrade to English rather than render
      // a mismatched list.
      if (!preservesSuggestionCount(card, cached)) {
        return card;
      }
      return { ...card, explanation: cached.explanation, suggestions: cached.suggestions };
    }

    const localized = await ports.llm.localizeCard({
      explanation: card.explanation,
      suggestions: card.suggestions,
      language,
    });

    // The provider may drop, add, or merge a "what could be wrong" prompt despite
    // the instruction to preserve count. We cannot trust the mapping then, so fall
    // this card back to English instead of silently losing a risk prompt — and we
    // do NOT cache the bad translation, so it is never reused.
    if (!preservesSuggestionCount(card, localized)) {
      console.error(
        `[localize] suggestion count drift (${card.suggestions.length} -> ${localized.suggestions.length}) for ${ref.owner}/${ref.repo} ${card.fingerprint} (${language}); serving English`,
      );
      return card;
    }

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

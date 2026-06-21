import {
  type Card,
  DEFAULT_LANGUAGE,
  type LanguageCode,
  type LocalizationKey,
  type LocalizationStore,
  type LocalizePorts,
  type LocalizeRef,
  type LocalizedCard,
  LocalizedCardSchema,
  localizeCards,
} from "@diffsense/core";
import { createReviewProvider } from "@diffsense/llm";
import { and, eq } from "drizzle-orm";
import { cardLocalizations, getDb } from "./db";

/**
 * The deck read path's localization glue (issue #28). When a reviewer picks a
 * non-English language, each card's prose (explanation + suggestions) is translated
 * via the `LLMProvider` port and cached in `card_localizations`. This module wires
 * the pure `localizeCards` orchestration (from `@diffsense/core`) to the web's
 * Postgres cache and the `@diffsense/llm` provider adapter, and guarantees a graceful
 * English fallback: any failure — no provider key, a provider error, a bad cache row
 * — degrades to the original English cards rather than breaking the deck render.
 *
 * Mirrors `lib/deck.ts` / `lib/findings.ts`: `apps/web` does its own direct DB I/O
 * and re-validates stored JSON before trusting it.
 */

/** A `LocalizationStore` over the shared `card_localizations` table. */
export function webLocalizationStore(): LocalizationStore {
  return {
    async get(key: LocalizationKey): Promise<LocalizedCard | null> {
      const rows = await getDb()
        .select({ localized: cardLocalizations.localized })
        .from(cardLocalizations)
        .where(
          and(
            eq(cardLocalizations.owner, key.owner),
            eq(cardLocalizations.repo, key.repo),
            eq(cardLocalizations.fingerprint, key.fingerprint),
            eq(cardLocalizations.language, key.language),
          ),
        )
        .limit(1);

      const stored = rows[0]?.localized;
      if (stored === undefined) {
        return null;
      }
      // Re-validate: a malformed cached row degrades to a miss (re-translate) rather
      // than feeding the deck broken prose.
      const parsed = LocalizedCardSchema.safeParse(stored);
      if (!parsed.success) {
        console.error(
          `[localize] discarding malformed cache row for ${key.owner}/${key.repo} ${key.fingerprint} (${key.language})`,
        );
        return null;
      }
      return parsed.data;
    },

    async save(key: LocalizationKey, value: LocalizedCard): Promise<void> {
      await getDb()
        .insert(cardLocalizations)
        .values({
          owner: key.owner,
          repo: key.repo,
          fingerprint: key.fingerprint,
          language: key.language,
          localized: value,
        })
        .onConflictDoUpdate({
          target: [
            cardLocalizations.owner,
            cardLocalizations.repo,
            cardLocalizations.fingerprint,
            cardLocalizations.language,
          ],
          set: { localized: value, updatedAt: new Date() },
        });
    },
  };
}

let cachedProvider: ReturnType<typeof createReviewProvider> | null = null;

/**
 * Lazily construct the provider-agnostic `LLMProvider` from env (the same
 * `LLM_PROVIDER` / `REVIEW_MODEL` / API-key config `apps/app` uses). Lazy so a build
 * never constructs it; a construction error (e.g. an unsupported `LLM_PROVIDER`)
 * propagates to `localizeDeckCards`, which treats it as "localization unavailable".
 */
function getReviewProvider() {
  if (!cachedProvider) {
    cachedProvider = createReviewProvider();
  }
  return cachedProvider;
}

/** The production ports: the env-configured provider + the Postgres cache. */
function defaultLocalizePorts(): LocalizePorts {
  return { llm: getReviewProvider(), store: webLocalizationStore() };
}

/**
 * Localize a deck's cards into `language`, degrading the whole deck to English on
 * any top-level failure (provider unavailable, DB down). English is a pure
 * passthrough that never constructs the provider or touches the DB. `ports` is
 * injectable so this is unit-testable without a database or network.
 */
export async function localizeDeckCards(
  cards: readonly Card[],
  language: LanguageCode,
  ref: LocalizeRef,
  ports?: LocalizePorts,
): Promise<Card[]> {
  if (language === DEFAULT_LANGUAGE) {
    return [...cards];
  }
  try {
    return await localizeCards(cards, language, ref, ports ?? defaultLocalizePorts());
  } catch (err) {
    console.error(
      `[localize] deck localization unavailable for ${ref.owner}/${ref.repo} (${language}); serving English:`,
      err,
    );
    return [...cards];
  }
}

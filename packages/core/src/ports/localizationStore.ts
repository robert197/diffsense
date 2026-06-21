import type { LanguageCode, LocalizedCard } from "../schemas/localization.js";

/**
 * The cache key for one card's prose in one language (issue #28). Keyed the same
 * way the review `FingerprintCache` is — `(owner, repo, fingerprint)` — plus the
 * target `language`. A card's prose derives from the finding keyed by its
 * structural fingerprint, so this key dedupes translations across PRs and re-runs:
 * a recurring chunk is translated once per language and reused everywhere.
 */
export interface LocalizationKey {
  owner: string;
  repo: string;
  /** Structural fingerprint of the card's hunk — shared with the review cache. */
  fingerprint: string;
  language: LanguageCode;
}

/**
 * Port: persist a card's translated prose and read it back (issue #28,
 * docs/ARCHITECTURE.md §5). Pure interface — `core` never knows it is Postgres.
 * The cache is what makes localization affordable: re-opening a deck in a language
 * already translated reuses the stored prose instead of re-spending inference.
 * `save` is an upsert on the `LocalizationKey`. `get` returns `null` on a miss (or
 * a malformed stored row, which the adapter discards rather than surfacing), so the
 * orchestration can fall through to a fresh translation or to English.
 */
export interface LocalizationStore {
  get(key: LocalizationKey): Promise<LocalizedCard | null>;
  save(key: LocalizationKey, value: LocalizedCard): Promise<void>;
}

import { type LanguageCode, resolveLanguage } from "@diffsense/core";

/**
 * The reviewer's spoken-language choice (issue #28), carried as a per-session
 * cookie. Kept here so the cookie name and the untrusted-value resolution have one
 * tested home shared by the picker, the server action that sets it, and the deck
 * read path that reads it. The actual language set + fallback rule live in
 * `@diffsense/core` (`resolveLanguage`); this is just the cookie binding.
 */

/** Cookie name holding the selected language code. */
export const LANGUAGE_COOKIE = "df_lang";

/** A year, in seconds — the language preference persists across sessions. */
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Resolve a raw cookie value to a supported `LanguageCode`, defaulting to English
 * when the cookie is absent, empty, or holds an unsupported value.
 */
export function resolveLanguageCookie(value: string | undefined | null): LanguageCode {
  return resolveLanguage(value);
}

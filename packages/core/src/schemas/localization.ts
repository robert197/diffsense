import { z } from "zod";

/**
 * Spoken-language localization of card prose (issue #28). The swipe deck's cards
 * (#26/#27) carry two natural-language fields — a plain-language `explanation` and
 * "what could be wrong" `suggestions`. A reviewer who is not proficient in English
 * abandons AI-tool output at a markedly higher rate (FSE 2025: 25% vs 17.9%), so
 * letting them read the prose in their own language widens who can review
 * effectively (STRATEGY.md: own the reviewer's attention allocation).
 *
 * This module is the pure domain vocabulary for that: the supported language set
 * and the localizable-prose shape. No I/O, no vendor import — translation itself
 * goes through the `LLMProvider` port (`packages/core/src/ports/llmProvider.ts`),
 * and `localizeCards` (`packages/core/src/localize/localizeCards.ts`) orchestrates
 * cache + provider + English fallback. English is the source language: cards are
 * authored in it, so it is a pure passthrough that never spends inference.
 */

/**
 * The bounded set of languages a reviewer can pick. English first — it is the
 * source language the cards are authored in. Kept deliberately small and curated;
 * adding a language is a one-line change here plus a label below.
 */
export const LANGUAGE_CODES = ["en", "es", "fr", "de", "pt", "zh", "ja", "hi", "ar", "ru"] as const;

export const LanguageCodeSchema = z.enum(LANGUAGE_CODES);
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

/** The default + source language. Cards are authored in it; it never translates. */
export const DEFAULT_LANGUAGE: LanguageCode = "en";

/** A pickable language with its native-name label for the selector UI. */
export interface SupportedLanguage {
  code: LanguageCode;
  /** Native name, shown in the picker (e.g. "Español", "中文"). */
  label: string;
  /** English name, used to instruct the translation provider (e.g. "Spanish"). */
  englishName: string;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: "en", label: "English", englishName: "English" },
  { code: "es", label: "Español", englishName: "Spanish" },
  { code: "fr", label: "Français", englishName: "French" },
  { code: "de", label: "Deutsch", englishName: "German" },
  { code: "pt", label: "Português", englishName: "Portuguese" },
  { code: "zh", label: "中文", englishName: "Chinese" },
  { code: "ja", label: "日本語", englishName: "Japanese" },
  { code: "hi", label: "हिन्दी", englishName: "Hindi" },
  { code: "ar", label: "العربية", englishName: "Arabic" },
  { code: "ru", label: "Русский", englishName: "Russian" },
];

/** True when `value` is one of the supported language codes. */
export function isSupportedLanguage(value: unknown): value is LanguageCode {
  return typeof value === "string" && (LANGUAGE_CODES as readonly string[]).includes(value);
}

/**
 * Resolve an untrusted language input (a cookie, a form field, a profile value) to
 * a supported `LanguageCode`, falling back to English. This is the single place the
 * fallback rule lives so the picker, the server action, and the read path all agree:
 * an unknown, empty, or missing value is English, never an error.
 */
export function resolveLanguage(value: string | undefined | null): LanguageCode {
  return isSupportedLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** The English name of a language code, for prompting the translation provider. */
export function languageName(code: LanguageCode): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.englishName ?? code;
}

/**
 * The localizable slice of a `Card` — deliberately only the two prose fields, so a
 * localization can never alter `fingerprint`, `file`, `tier`, `rank`, `riskScore`,
 * or `highlights`. Both the `LLMProvider.localizeCard` result and the
 * `LocalizationStore` payload are this shape.
 */
export const LocalizedCardSchema = z.object({
  /** Plain-language summary of what the change does, in the target language. */
  explanation: z.string().min(1),
  /** "What could be wrong" prompts, in the target language; order is preserved. */
  suggestions: z.array(z.string().min(1)),
});
export type LocalizedCard = z.infer<typeof LocalizedCardSchema>;

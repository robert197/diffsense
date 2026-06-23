import { type LanguageCode, SUPPORTED_LANGUAGES } from "@diffsense/core";
import { Languages } from "lucide-react";
import { Button } from "../../../../../../components/ui/button";
import { setLanguage } from "./actions";

/**
 * The spoken-language selector for the swipe deck (issue #28). A plain
 * `<form action={setLanguage}>` with a native `<select>` + Apply button — no client
 * JS, fully accessible, and mobile-first (one tap). Submitting sets the `df_lang`
 * cookie and revalidates the deck route, so the server re-renders the cards' prose
 * in the chosen language. Only the natural-language prose changes; code, file paths,
 * tiers, and risk scores are untouched.
 */
export function LanguagePicker({
  current,
  owner,
  repo,
  prNumber,
}: {
  current: LanguageCode;
  owner: string;
  repo: string;
  prNumber: number;
}) {
  return (
    <form action={setLanguage} className="flex items-center gap-2">
      <input type="hidden" name="owner" value={owner} />
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="prNumber" value={prNumber} />
      <label
        htmlFor="df-lang"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <Languages className="size-3.5" />
        <span className="sr-only sm:not-sr-only">Language</span>
      </label>
      <select
        id="df-lang"
        name="lang"
        defaultValue={current}
        className="h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground transition-colors hover:border-ring/40 focus-visible:border-ring focus-visible:outline-none"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" size="sm">
        Apply
      </Button>
    </form>
  );
}

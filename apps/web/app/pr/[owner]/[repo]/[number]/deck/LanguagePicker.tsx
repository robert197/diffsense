import { type LanguageCode, SUPPORTED_LANGUAGES } from "@diffsense/core";
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
    <form action={setLanguage} style={form}>
      <input type="hidden" name="owner" value={owner} />
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="prNumber" value={prNumber} />
      <label htmlFor="df-lang" style={label}>
        Language
      </label>
      <select id="df-lang" name="lang" defaultValue={current} style={select}>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
      <button type="submit" style={button}>
        Apply
      </button>
    </form>
  );
}

const form: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginTop: "0.75rem",
};

const label: React.CSSProperties = {
  fontSize: "0.78rem",
  opacity: 0.6,
};

const select: React.CSSProperties = {
  minHeight: 36,
  padding: "0.3rem 0.5rem",
  borderRadius: 8,
  background: "#11151a",
  color: "inherit",
  border: "1px solid #1f2933",
  fontSize: "0.85rem",
};

const button: React.CSSProperties = {
  minHeight: 36,
  padding: "0.3rem 0.75rem",
  borderRadius: 8,
  background: "transparent",
  color: "inherit",
  border: "1px solid #374151",
  fontSize: "0.85rem",
  cursor: "pointer",
};

import { UsageError } from "./errors.js";

/** The PR a `diffsense review` invocation targets, parsed from `<pr-ref>`. */
export interface ParsedPrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

// owner/repo segments: GitHub allows letters, digits, `-`, `_`, `.`. Keep it
// permissive but anchored so `owner/repo` (no PR) or stray slashes are rejected.
const SEGMENT = "[A-Za-z0-9._-]+";
const SHORT = new RegExp(`^(${SEGMENT})/(${SEGMENT})(?:#|/)(\\d+)$`);
// Anchor the host to github.com (optionally `www.`) so a look-alike like
// `notgithub.com` or an unrelated subdomain (`gist.github.com`) is rejected up
// front rather than resolved against a real repo of that path.
const URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${SEGMENT})/(${SEGMENT})/pull/(\\d+)(?:[/?#].*)?$`,
);

/**
 * Parse the forms an agent is likely to paste into `diffsense review <pr-ref>`:
 *
 *   - `owner/repo#123`
 *   - `owner/repo/123`
 *   - `https://github.com/owner/repo/pull/123` (with optional `/files`, query, hash)
 *
 * Pure, no I/O. Anything else throws a `UsageError` (→ exit code 2) carrying a
 * message that shows the accepted forms, so the failure is actionable.
 */
export function parsePrRef(input: string): ParsedPrRef {
  const trimmed = input?.trim() ?? "";
  const match = SHORT.exec(trimmed) ?? URL.exec(trimmed);
  if (!match) {
    throw new UsageError(
      `Could not parse PR reference "${input}". Expected owner/repo#123, owner/repo/123, or a github.com pull URL.`,
    );
  }
  const [, owner, repo, num] = match;
  const prNumber = Number(num);
  // `owner`/`repo` are non-empty by the regex (narrows the match groups for TS);
  // `0` and out-of-safe-range numbers (e.g. a 21-digit paste) are not valid PRs.
  if (!owner || !repo || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new UsageError(`Could not parse PR reference "${input}".`);
  }
  return { owner, repo, prNumber };
}

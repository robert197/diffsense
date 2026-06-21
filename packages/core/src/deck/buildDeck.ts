import parseDiff from "parse-diff";
import type { DeckRef } from "../ports/deckStore.js";
import { rankHunks } from "../rank/rankHunks.js";
import { fingerprintChunk } from "../review/fingerprint.js";
import type { Card, Deck, HighlightRange } from "../schemas/card.js";
import type { ReviewFinding } from "../schemas/finding.js";

/**
 * Turn a PR diff into an ordered Deck of cards (issue #26, docs/ARCHITECTURE.md
 * §2–§3). Pure and deterministic — no LLM, no I/O. The agentic judgment already
 * happened upstream (the review pass produced the `ReviewFinding[]`); this folds
 * that judgment together with the deterministic structural ranking into one card
 * per changed hunk.
 *
 * One card per hunk means swiping the whole deck covers all changed code; the
 * `rankHunks` order means the riskiest changes come first (STRATEGY.md: direct
 * finite reviewer attention to risk). For each hunk the card carries:
 * - the structural risk score + tier (from `rankHunks`),
 * - the exact changed-line ranges to scrutinize (from the diff),
 * - "what could be wrong" suggestions + a plain-language explanation (from the
 *   matching review finding, when the hunk was reviewed).
 *
 * Reviewed hunks are the top-risk subset the review pass selected, so most cards
 * carry only the deterministic fields plus a factual default explanation — that
 * is by design: the deck covers everything, the review deepens the risky parts.
 */
export function buildDeck(diff: string, meta: DeckRef, findings: readonly ReviewFinding[]): Deck {
  const cards = buildCards(diff, meta, findings);
  return {
    owner: meta.owner,
    repo: meta.repo,
    prNumber: meta.prNumber,
    headSha: meta.headSha,
    cards,
  };
}

/** Per-hunk data recovered from the diff, keyed by the ranking's positional id. */
interface HunkInfo {
  patch: string;
  highlights: HighlightRange[];
}

function buildCards(diff: string, meta: DeckRef, findings: readonly ReviewFinding[]): Card[] {
  if (!diff.trim()) {
    return [];
  }

  // Recover each hunk's patch + highlights, keyed exactly the way `rankHunks`
  // derives its positional id, so the ranked order joins back to the diff detail.
  const hunkByPos = new Map<string, HunkInfo>();
  for (const file of parseDiff(diff)) {
    const path = githubPath(file);
    if (!path) {
      continue;
    }
    for (const chunk of file.chunks ?? []) {
      let added = 0;
      for (const change of chunk.changes) {
        if (change.type === "add") added++;
      }
      const side: "R" | "L" = added > 0 ? "R" : "L";
      const line = added > 0 ? chunk.newStart : chunk.oldStart;
      // Patch string must match `buildReviewChunks` byte-for-byte so the
      // structural fingerprint equals the one the review findings were keyed by.
      const patch = [chunk.content, ...chunk.changes.map((c) => c.content)].join("\n");
      hunkByPos.set(`${path}\n${side}\n${line}`, { patch, highlights: highlightsOf(chunk) });
    }
  }

  const findingByFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));

  // `rankHunks` walks the same hunks and returns them ordered by risk; that order
  // is the deck order.
  return rankHunks(diff, meta).map((ranked, index) => {
    const hunk = hunkByPos.get(`${ranked.file}\n${ranked.side}\n${ranked.line}`);
    const patch = hunk?.patch ?? "";
    const fingerprint = fingerprintChunk(ranked.file, patch);
    const finding = findingByFingerprint.get(fingerprint);
    return {
      fingerprint,
      file: ranked.file,
      tier: ranked.tier,
      rank: index,
      riskScore: ranked.score,
      highlights: hunk?.highlights ?? [],
      suggestions: finding ? finding.claims.map((claim) => claim.claim) : [],
      explanation: finding ? finding.explanation : defaultExplanation(ranked),
    };
  });
}

/**
 * Contiguous ranges of the hunk's changed lines. Added lines (right side) are the
 * thing to scrutinize; a pure-deletion hunk highlights the removed lines instead,
 * matching the side `rankHunks` deep-links to.
 */
function highlightsOf(chunk: parseDiff.Chunk): HighlightRange[] {
  const added: number[] = [];
  const deleted: number[] = [];
  for (const change of chunk.changes) {
    if (change.type === "add") {
      added.push(change.ln);
    } else if (change.type === "del") {
      deleted.push(change.ln);
    }
  }
  return added.length > 0 ? coalesce(added, "R") : coalesce(deleted, "L");
}

/** Group a sorted-on-insert list of line numbers into inclusive ranges. */
function coalesce(lines: number[], side: "L" | "R"): HighlightRange[] {
  if (lines.length === 0) {
    return [];
  }
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: HighlightRange[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const line of sorted.slice(1)) {
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push({ side, start, end: prev });
    start = line;
    prev = line;
  }
  ranges.push({ side, start, end: prev });
  return ranges;
}

/**
 * Plain-language explanation for a hunk the review pass did not deepen. Factual,
 * no AI tells — it states what changed so the card still reads as a complete unit.
 */
function defaultExplanation(ranked: { file: string; added: number; deleted: number }): string {
  const parts: string[] = [];
  if (ranked.added > 0) parts.push(`${ranked.added} line${ranked.added === 1 ? "" : "s"} added`);
  if (ranked.deleted > 0)
    parts.push(`${ranked.deleted} line${ranked.deleted === 1 ? "" : "s"} removed`);
  const change = parts.length > 0 ? parts.join(", ") : "no line changes";
  return `Changes in ${ranked.file} (${change}).`;
}

/** The path GitHub uses for the file: the new path, or the old one if deleted. */
function githubPath(file: parseDiff.File): string | null {
  const to = file.to && file.to !== "/dev/null" ? file.to : null;
  const from = file.from && file.from !== "/dev/null" ? file.from : null;
  return to ?? from;
}

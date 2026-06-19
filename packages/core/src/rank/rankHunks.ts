import { createHash } from "node:crypto";
import parseDiff from "parse-diff";

/**
 * Structural risk ranking for PR hunks — pure, deterministic, no LLM.
 *
 * `rankHunks` scores every hunk in a unified diff with a transparent linear
 * model over four structural signals and buckets them by within-PR percentile.
 * This is the deterministic ranking stage from docs/ARCHITECTURE.md §2: it
 * decides *where reviewer attention goes first*, so it is hardcoded on purpose
 * (cost/attention control, not domain judgment). The Octokit fetch that
 * produces the diff lives in `apps/app` — `core` stays pure (no vendor SDK).
 */

export type Tier = "High" | "Medium" | "Low";

/** Repo coordinates needed to build a Files-changed deep link. */
export interface PrMeta {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface RankedSignals {
  /** log2(1 + added + deleted) — change size, log-scaled. */
  sizeScore: number;
  riskPath: boolean;
  /** Which risk category the path matched, or null. */
  riskPathLabel: RiskCategory | null;
  /** A changed line adds or removes an exported/public symbol. */
  apiBoundary: boolean;
  /** Source-code file changed with no corresponding test file in the PR. */
  missingTestDelta: boolean;
}

export interface RankedChunk {
  /** GitHub file path the hunk belongs to. */
  file: string;
  /** Line the deep link points at (new-side line, or old-side for deletions). */
  line: number;
  /** "R" = right/new side, "L" = left/old side. */
  side: "R" | "L";
  added: number;
  deleted: number;
  score: number;
  tier: Tier;
  /** One-line, human-readable explanation of the dominant signals. */
  reason: string;
  /** URL into the PR Files-changed view, anchored at this hunk. */
  deepLink: string;
  signals: RankedSignals;
}

// --- Transparent, hand-set weights (cold-start, not learned) -----------------
// Exported so the ranking stays inspectable and tunable in one place.
export const W_SIZE = 1;
export const W_RISK_PATH = 3;
export const W_API = 2;
export const W_MISSING_TEST = 1.5;

// --- Bucketing cutoffs: top 20% High, next 30% Medium, rest Low --------------
export const HIGH_PCTL = 0.2;
export const MED_PCTL = 0.3;

export type RiskCategory =
  | "auth"
  | "payment"
  | "security"
  | "migration"
  | "infra"
  | "deploy"
  | "config";

// First match wins, so order matters: specific/high-signal categories first,
// the broad "config" catch-all last.
const RISK_PATTERNS: ReadonlyArray<readonly [RiskCategory, RegExp]> = [
  ["auth", /(auth|login|logout|session|oauth|jwt|password|credential)/i],
  ["payment", /(payment|billing|invoice|charge|stripe|paypal|checkout|subscription)/i],
  ["security", /(security|crypto|secret|sanitize|csrf|cors|encrypt|decrypt|sso)/i],
  ["migration", /(migration|migrate|schema|\.sql$)/i],
  ["infra", /(infra|terraform|\.tf$|k8s|kubernetes|helm|ansible|dockerfile|docker-compose)/i],
  ["deploy", /(deploy|\.github\/workflows\/|pipeline)/i],
  ["config", /(config|\.env|settings|\.ya?ml$|\.toml$|\.ini$)/i],
];

// A changed line touches the public surface: exports or public members.
const API_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /\bexport\b/,
  /\bmodule\.exports\b/,
  /\bexports\.\w+/,
  /^\s*public\s+/,
];

const SOURCE_CODE_EXT = /\.([cm]?[jt]sx?|py|go|rb|java|rs|php|kt|swift|scala|c|cc|cpp|h|hpp|cs)$/i;
const TEST_MARKER = /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR = /(^|\/)(__tests__|tests?)\//i;

interface RawHunk {
  file: string;
  added: number;
  deleted: number;
  newStart: number;
  oldStart: number;
  apiBoundary: boolean;
  /** Original encounter order, used as a deterministic tiebreak. */
  order: number;
}

/**
 * Score and rank every hunk in a unified diff. Returns the chunks ordered by
 * risk (highest first), each tagged with a tier, score, one-line reason, and a
 * deep link into the PR's Files-changed view.
 */
export function rankHunks(diff: string, meta: PrMeta): RankedChunk[] {
  if (!diff.trim()) {
    return [];
  }

  const files = parseDiff(diff);

  // Collect every file path so test-delta is a PR-wide lookup, not per-file.
  const testBases = new Set<string>();
  for (const file of files) {
    const path = githubPath(file);
    if (path && isTestFile(path)) {
      testBases.add(testBase(path));
    }
  }

  const raw: RawHunk[] = [];
  let order = 0;
  for (const file of files) {
    const path = githubPath(file);
    if (!path) {
      continue;
    }
    for (const chunk of file.chunks ?? []) {
      let added = 0;
      let deleted = 0;
      let apiBoundary = false;
      for (const change of chunk.changes) {
        if (change.type === "add") {
          added++;
        } else if (change.type === "del") {
          deleted++;
        }
        if (change.type !== "normal" && touchesApiBoundary(change.content)) {
          apiBoundary = true;
        }
      }
      raw.push({
        file: path,
        added,
        deleted,
        newStart: chunk.newStart,
        oldStart: chunk.oldStart,
        apiBoundary,
        order: order++,
      });
    }
  }

  // Rank by score desc; deterministic tiebreak by path, then encounter order.
  const scored = raw
    .map((hunk) => ({ order: hunk.order, chunk: buildRankedChunk(hunk, testBases, meta) }))
    .sort(
      (a, b) =>
        b.chunk.score - a.chunk.score ||
        a.chunk.file.localeCompare(b.chunk.file) ||
        a.order - b.order,
    )
    .map((entry) => entry.chunk);

  assignTiers(scored);
  return scored;
}

function buildRankedChunk(hunk: RawHunk, testBases: Set<string>, meta: PrMeta): RankedChunk {
  const sizeScore = Math.log2(1 + hunk.added + hunk.deleted);
  const risk = riskCategory(hunk.file);
  const missingTestDelta = isMissingTestDelta(hunk.file, testBases);

  const signals: RankedSignals = {
    sizeScore,
    riskPath: risk !== null,
    riskPathLabel: risk,
    apiBoundary: hunk.apiBoundary,
    missingTestDelta,
  };

  const score =
    W_SIZE * sizeScore +
    W_RISK_PATH * (signals.riskPath ? 1 : 0) +
    W_API * (signals.apiBoundary ? 1 : 0) +
    W_MISSING_TEST * (signals.missingTestDelta ? 1 : 0);

  const side: "R" | "L" = hunk.added > 0 ? "R" : "L";
  const line = hunk.added > 0 ? hunk.newStart : hunk.oldStart;

  return {
    file: hunk.file,
    line,
    side,
    added: hunk.added,
    deleted: hunk.deleted,
    score,
    tier: "Low", // re-assigned by assignTiers once the whole set is ranked
    reason: buildReason(hunk, signals),
    deepLink: deepLink(meta, hunk.file, side, line),
    signals,
  };
}

/** Assign High/Medium/Low by count-based percentile; always ≥1 High. */
function assignTiers(chunks: RankedChunk[]): void {
  const n = chunks.length;
  if (n === 0) {
    return;
  }
  const highCount = Math.max(1, Math.round(HIGH_PCTL * n));
  const medCount = Math.round(MED_PCTL * n);
  chunks.forEach((chunk, i) => {
    if (i < highCount) {
      chunk.tier = "High";
    } else if (i < highCount + medCount) {
      chunk.tier = "Medium";
    } else {
      chunk.tier = "Low";
    }
  });
}

function buildReason(hunk: RawHunk, signals: RankedSignals): string {
  const total = hunk.added + hunk.deleted;
  const band = total >= 50 ? "Large" : total >= 10 ? "Medium" : "Small";
  const parts = [`${band} change (${total} lines)`];
  if (signals.riskPathLabel) {
    parts.push(`in a ${signals.riskPathLabel} path`);
  }
  if (signals.apiBoundary) {
    parts.push("touches exported API");
  }
  if (signals.missingTestDelta) {
    parts.push("no accompanying tests");
  }
  return parts.join(", ");
}

function deepLink(meta: PrMeta, path: string, side: "R" | "L", line: number): string {
  const anchor = createHash("sha256").update(path).digest("hex");
  return `https://github.com/${meta.owner}/${meta.repo}/pull/${meta.prNumber}/files#diff-${anchor}${side}${line}`;
}

/** The path GitHub uses for the file: the new path, or the old one if deleted. */
function githubPath(file: parseDiff.File): string | null {
  const to = file.to && file.to !== "/dev/null" ? file.to : null;
  const from = file.from && file.from !== "/dev/null" ? file.from : null;
  return to ?? from;
}

function riskCategory(path: string): RiskCategory | null {
  for (const [category, pattern] of RISK_PATTERNS) {
    if (pattern.test(path)) {
      return category;
    }
  }
  return null;
}

function touchesApiBoundary(rawLine: string): boolean {
  // Strip the leading diff marker (+/-/space) before matching code content.
  const content = rawLine.replace(/^[+-]/, "");
  return API_BOUNDARY_PATTERNS.some((pattern) => pattern.test(content));
}

function isTestFile(path: string): boolean {
  return TEST_MARKER.test(path) || TEST_DIR.test(path);
}

function isSourceCode(path: string): boolean {
  return SOURCE_CODE_EXT.test(path);
}

/** Base name used to pair a source file with its test (extension/markers off). */
function testBase(path: string): string {
  const seg = path.split("/").pop() ?? path;
  return seg.replace(TEST_MARKER, "").replace(SOURCE_CODE_EXT, "");
}

function sourceBase(path: string): string {
  const seg = path.split("/").pop() ?? path;
  return seg.replace(SOURCE_CODE_EXT, "");
}

function isMissingTestDelta(path: string, testBases: Set<string>): boolean {
  if (isTestFile(path) || !isSourceCode(path)) {
    return false;
  }
  return !testBases.has(sourceBase(path));
}

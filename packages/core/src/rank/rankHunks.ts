import { createHash } from "node:crypto";
import parseDiff from "parse-diff";
import { type DemotionReason, classifyDemotion } from "../diff/demote.js";

/**
 * Structural risk ranking for PR hunks — pure, deterministic, no LLM.
 *
 * `rankHunks` scores every hunk in a unified diff with a transparent linear
 * model over four structural signals and buckets them by within-PR percentile.
 * This is the deterministic ranking stage from docs/ARCHITECTURE.md §2: it
 * decides *where reviewer attention goes first*, so it is hardcoded on purpose
 * (cost/attention control, not domain judgment). The Octokit fetch that
 * produces the diff lives in `apps/app` — `core` stays pure (no vendor SDK).
 *
 * Two robustness properties matter (issue #3):
 * - Generated/binary/lockfile hunks are demoted to Low and kept out of the
 *   "review first" set even when large, so machine-written noise never crowds
 *   out the real change.
 * - It degrades gracefully on unrecognized languages: every signal contributes
 *   zero when it does not match, so the score falls back to size + risk-path and
 *   a valid ordering is always produced (it never throws on a parseable diff).
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
  /** Machine-written noise (generated/binary/lockfile): forced to Low. */
  demoted: boolean;
  /** Which demotion category the path matched, or null. */
  demotionReason: DemotionReason | null;
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
  /** Stable per-chunk id used to key reviewer reactions (positional for now). */
  fingerprint: string;
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
  // DB migrations / schema definitions — NOT a bare "schema" substring, which
  // false-matches a frontend `src/schemas/` (Zod) dir. Anchor on real artifacts.
  ["migration", /(migration|migrate|\.sql$|schema\.(sql|prisma|rb))/i],
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

// A file is a test if its directory or its name marks it. Cross-language on
// purpose: JS (`x.test.ts`), Python (`test_x.py`, `x_test.py`), Go (`x_test.go`),
// Ruby (`x_spec.rb`), JVM (`XTest.java`). Without this a Python/Go backend's
// tests are scored as untested production code, and their sources look untested.
const TEST_DIR = /(^|\/)(__tests__|tests?|specs?)\//i;
// Name markers, matched against the basename (the `^test_` prefix needs it):
//   `test_x.<ext>` · `x.test.<ext>` / `x-spec.<ext>` / `x_test.<ext>`.
const TEST_NAME = /(^test_|[._-](test|spec)s?\.)/i;
// JVM CamelCase suffix (`UserServiceTest.java`) — case-sensitive so `latest.js`
// and `manifest.ts` do not match.
const TEST_NAME_JVM = /[a-z](Test|Spec)s?\.[a-z]+$/;

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
  // Use a byte comparison (not localeCompare) so the order is identical across
  // OS/ICU builds — the ranking's determinism is a hard guarantee (CLAUDE.md).
  const scored = raw
    .map((hunk) => ({ order: hunk.order, chunk: buildRankedChunk(hunk, testBases, meta) }))
    .sort(
      (a, b) =>
        b.chunk.score - a.chunk.score ||
        byteCompare(a.chunk.file, b.chunk.file) ||
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
  const demotionReason = classifyDemotion(hunk.file);

  const signals: RankedSignals = {
    sizeScore,
    riskPath: risk !== null,
    riskPathLabel: risk,
    apiBoundary: hunk.apiBoundary,
    missingTestDelta,
    demoted: demotionReason !== null,
    demotionReason,
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
    fingerprint: fingerprint(hunk.file, side, line),
    signals,
  };
}

/**
 * Assign High/Medium/Low by count-based percentile; always ≥1 High.
 *
 * Demoted hunks (generated/binary/lockfile) are forced to Low and excluded from
 * the percentile base, so machine-written noise never lands in the review-first
 * set and never displaces a real change from it (issue #3, R1).
 */
function assignTiers(chunks: RankedChunk[]): void {
  const candidates = chunks.filter((c) => !c.signals.demoted);
  const n = candidates.length;
  for (const chunk of chunks) {
    if (chunk.signals.demoted) {
      chunk.tier = "Low";
    }
  }
  if (n === 0) {
    return;
  }
  const highCount = Math.max(1, Math.round(HIGH_PCTL * n));
  const medCount = Math.round(MED_PCTL * n);
  candidates.forEach((chunk, i) => {
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
  if (signals.demotionReason) {
    return `${capitalize(signals.demotionReason)} file, demoted`;
  }
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

/**
 * Stable per-chunk id used to key reviewer reactions. Positional for now
 * (`file:side:line`); the structural/AST fingerprint is issue #8.
 */
function fingerprint(path: string, side: "R" | "L", line: number): string {
  return createHash("sha256").update(`${path}:${side}:${line}`).digest("hex").slice(0, 16);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Locale-independent string order, so the tiebreak is byte-deterministic. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  if (TEST_DIR.test(path)) {
    return true;
  }
  const name = basename(path);
  return TEST_NAME.test(name) || TEST_NAME_JVM.test(name);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function isSourceCode(path: string): boolean {
  return SOURCE_CODE_EXT.test(path);
}

/** Base name used to pair a source file with its test (extension/markers off). */
function testBase(path: string): string {
  const seg = basename(path).replace(SOURCE_CODE_EXT, "");
  return seg
    .replace(/^test_/i, "") // python prefix: test_identity → identity
    .replace(/[._-](test|spec)s?$/i, "") // js/go/ruby suffix: widget.test, x_spec → x
    .replace(/(Test|Spec)s?$/, ""); // jvm: UserServiceTest → UserService
}

function sourceBase(path: string): string {
  return basename(path).replace(SOURCE_CODE_EXT, "");
}

function isMissingTestDelta(path: string, testBases: Set<string>): boolean {
  if (isTestFile(path) || !isSourceCode(path)) {
    return false;
  }
  return !testBases.has(sourceBase(path));
}

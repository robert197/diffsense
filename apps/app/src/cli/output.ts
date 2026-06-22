import type { Deck, ReviewFinding } from "@diffsense/core";
import type { UpsertResult } from "../adapters/github.js";
import { CliConfigError, UsageError } from "./errors.js";
import type { ParsedPrRef } from "./prRef.js";

/**
 * The machine-readable result of a `diffsense review` run (issue #32, AC2/KTD6).
 * It embeds the existing store shapes verbatim — the `Deck` (whose cards carry
 * the risk scores, highlighted ranges, suggestions, and plain-language
 * explanations the issue names) and the per-chunk `ReviewFinding[]` — so the CLI
 * is a thin transport over the read-model with no new public schema to maintain.
 */
export interface ReviewOutput {
  pr: { owner: string; repo: string; prNumber: number };
  /** PR head commit the deck/findings are keyed to, or `null` if it could not resolve. */
  headSha: string | null;
  /** The idempotent ranked-comment delivery result. */
  comment: { action: UpsertResult["action"]; commentId: number };
  /** The ordered deck of cards, or `null` when the head was unresolved / no deck stored. */
  deck: Deck | null;
  /** Per-chunk agentic findings this run produced (empty when no LLM ran). */
  findings: readonly ReviewFinding[];
  /** Whether an LLM provider was configured (the agentic pass was attempted). */
  llm: boolean;
}

export interface BuildReviewOutputInput {
  pr: ParsedPrRef;
  headSha: string | undefined;
  upsert: UpsertResult;
  deck: Deck | null;
  findings: readonly ReviewFinding[];
  llm: boolean;
}

/**
 * Assemble the JSON output object. Pure: it only reshapes already-fetched data,
 * normalizing an unresolved `headSha` to `null` so the emitted JSON has no
 * `undefined` holes.
 */
export function buildReviewOutput(input: BuildReviewOutputInput): ReviewOutput {
  return {
    pr: { owner: input.pr.owner, repo: input.pr.repo, prNumber: input.pr.prNumber },
    headSha: input.headSha ?? null,
    comment: { action: input.upsert.action, commentId: input.upsert.commentId },
    deck: input.deck,
    findings: input.findings,
    llm: input.llm,
  };
}

/** Read a numeric HTTP status off an Octokit-style error, if present. */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const direct = (err as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const nested = (err as { response?: { status?: unknown } }).response?.status;
  return typeof nested === "number" ? nested : undefined;
}

/**
 * Map a thrown error to the CLI's exit code (issue #32, KTD4):
 *   2 — usage error (bad args / unparseable ref)
 *   3 — config/auth configuration error (missing/invalid creds), incl. a GitHub
 *       401 from a structurally-valid-but-wrong App key/installation
 *   4 — GitHub access: PR/repo not found or forbidden (404/403)
 *   1 — any other runtime error
 */
export function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return 2;
  if (err instanceof CliConfigError) return 3;
  const status = httpStatusOf(err);
  // 401 = bad credentials (wrong private key / installation) — a config problem,
  // not a per-repo access one. Keep it in the same bucket as missing creds.
  if (status === 401) return 3;
  if (status === 404 || status === 403) return 4;
  return 1;
}

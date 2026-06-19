import type { LLMProvider, SynthesisFinding } from "../ports/llmProvider.js";
import type { PrIntent } from "../ports/repoReader.js";
import type { Portfolio, RiskPosition } from "../schemas/portfolio.js";
import type { VerifiedFinding } from "../verify/verifyFinding.js";

/**
 * PR-level risk portfolio synthesis (issue #11, docs/ARCHITECTURE.md §2–§3).
 * Pure orchestration: it filters to the verified survivors, hands the synthesis
 * model their content plus the scope-creep assessment and the PR intent, and
 * enforces the link-back invariant on the result — the judgment (naming the
 * positions, writing the overview) stays inside `LLMProvider.synthesize`.
 *
 * Synthesis is a single structured call, not a tool loop: its inputs are already
 * in hand (the verified findings; the scope assessment; the intent), so there is
 * nothing to explore (§3). Deterministic and fully unit-testable with a fake
 * `LLMProvider` (no network).
 */

/** One change that falls outside the PR's stated intent (produced by #10). */
export interface ScopeFinding {
  /** What the out-of-intent change is, e.g. "adds a new DB column". */
  description: string;
  /** The files the undeclared change touches — link targets for a position. */
  files: string[];
}

/**
 * The scope-creep assessment of the whole diff against its stated intent. This
 * is the minimal contract synthesis consumes from `detectScopeCreep` (issue #10,
 * `core/scope`); that unit owns the full shape.
 */
export interface ScopeAssessment {
  /** True when the diff stays within what the author said the change is for. */
  withinIntent: boolean;
  /** The out-of-intent changes, empty when the diff stays on scope. */
  findings: ScopeFinding[];
}

export interface SynthesisPorts {
  llm: LLMProvider;
}

/**
 * Roll the verified findings and the scope assessment up into a PR-level
 * `Portfolio`.
 *
 * Synthesis consumes only survivors — refuted findings are already gone from the
 * verify pass (#9), and this filter makes that contract explicit even if a caller
 * passes the raw verified set. When nothing survived and the diff stayed on
 * scope, it returns an empty portfolio without an LLM call.
 *
 * Every position the model returns is held to the link-back invariant: each
 * chunk reference must point at a real chunk (a surviving finding's file or a
 * scope finding's file). Unknown references are dropped, and a position left with
 * no real chunk is removed — a portfolio position always links to its evidence.
 */
export async function synthesizePortfolio(
  findings: readonly VerifiedFinding[],
  scope: ScopeAssessment,
  intent: PrIntent,
  ports: SynthesisPorts,
): Promise<Portfolio> {
  const survivors = findings.filter((finding) => finding.survives);

  const synthesisFindings: SynthesisFinding[] = survivors.map((finding) => ({
    chunkRef: finding.chunk.file,
    file: finding.chunk.file,
    rating: finding.review.rating,
    review: finding.review,
  }));

  // Nothing to synthesize: no surviving risk and no scope creep. Answer
  // deterministically rather than spend a synthesis call on an empty PR.
  if (synthesisFindings.length === 0 && scope.findings.length === 0) {
    return {
      positions: [],
      intentCoverage: "The change stays within its stated intent.",
      overview: "No risks survived verification. Nothing flagged for review.",
    };
  }

  const validRefs = new Set<string>([
    ...synthesisFindings.map((finding) => finding.chunkRef),
    ...scope.findings.flatMap((finding) => finding.files),
  ]);

  const portfolio = await ports.llm.synthesize({ findings: synthesisFindings, scope, intent });

  // Enforce the link-back invariant deterministically, regardless of what the
  // model returned: keep only references to real chunks, and drop a position
  // that ends up linking to none.
  const positions = portfolio.positions
    .map(
      (position): RiskPosition => ({
        ...position,
        chunks: position.chunks.filter((ref) => validRefs.has(ref)),
      }),
    )
    .filter((position) => position.chunks.length > 0);

  return { ...portfolio, positions };
}

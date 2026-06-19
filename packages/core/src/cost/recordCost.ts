import type { CostStore, PrCostRecord } from "../ports/costStore.js";
import type { ModelUsage } from "../schemas/cost.js";

/**
 * Inference-cost logging (issue #12, docs/ARCHITECTURE.md §2). Pure orchestration
 * over injected ports: it sums the per-pass token usage into a USD figure, flags
 * a PR over the configured threshold in the logs, and persists the record through
 * `CostStore` — the judgment-free observability stage at the tail of the pipeline.
 *
 * Deterministic and fully unit-testable with a fake `CostStore` (no DB).
 */

/** Per-1M-token USD rates for one model. */
export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
}

/** Rate table keyed by model id (from config in `apps/app`). */
export type RateTable = Record<string, ModelRate>;

/** Identifies the PR a cost record belongs to. */
export interface CostPrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface RecordCostPorts {
  store: CostStore;
  /** Per-model USD rates. A model with no entry contributes 0 and is logged. */
  rates: RateTable;
  /** USD ceiling; a PR over it is flagged in the logs and on the record. */
  thresholdUsd: number;
  /** Sink for the threshold flag and unpriced-model warnings. Defaults to console. */
  logger?: Pick<Console, "warn">;
}

export interface CostComputation {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Models seen in usage that had no rate-table entry — their cost is unpriced (0). */
  unpricedModels: string[];
}

const PER_MILLION = 1_000_000;

/**
 * Sum token usage into a USD cost. A model with no rate entry contributes 0 and
 * is reported in `unpricedModels` — silently under-counting cost would defeat the
 * observability this stage exists for.
 */
export function computeCost(usage: readonly ModelUsage[], rates: RateTable): CostComputation {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const unpriced = new Set<string>();

  for (const pass of usage) {
    inputTokens += pass.inputTokens;
    outputTokens += pass.outputTokens;
    const rate = rates[pass.model];
    if (!rate) {
      unpriced.add(pass.model);
      continue;
    }
    costUsd +=
      (pass.inputTokens * rate.inputPer1M + pass.outputTokens * rate.outputPer1M) / PER_MILLION;
  }

  return { inputTokens, outputTokens, costUsd, unpricedModels: [...unpriced] };
}

/**
 * Compute and persist the inference cost of one PR review run. Returns the stored
 * record so the caller can surface it. A PR over `thresholdUsd` is flagged both
 * on the record (`overThreshold`) and in the logs.
 */
export async function recordCost(
  pr: CostPrRef,
  usage: readonly ModelUsage[],
  ports: RecordCostPorts,
): Promise<PrCostRecord> {
  const { store, rates, thresholdUsd, logger = console } = ports;
  const { inputTokens, outputTokens, costUsd, unpricedModels } = computeCost(usage, rates);
  const overThreshold = costUsd > thresholdUsd;

  const record: PrCostRecord = {
    owner: pr.owner,
    repo: pr.repo,
    prNumber: pr.prNumber,
    inputTokens,
    outputTokens,
    costUsd,
    overThreshold,
  };

  await store.record(record);

  if (unpricedModels.length > 0) {
    logger.warn(
      `[diffsense] PR ${prLabel(pr)} inference cost is understated: no rate for ${unpricedModels.join(", ")}`,
    );
  }
  if (overThreshold) {
    logger.warn(
      `[diffsense] PR ${prLabel(pr)} inference cost $${costUsd.toFixed(4)} exceeds threshold $${thresholdUsd.toFixed(4)}`,
    );
  }

  return record;
}

function prLabel(pr: CostPrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.prNumber}`;
}

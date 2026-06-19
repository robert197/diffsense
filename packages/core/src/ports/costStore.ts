/**
 * Port: persist the inference cost of one PR review run (issue #12).
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` implements it (docs/ARCHITECTURE.md §1, ports & adapters). Records
 * are append-only: each review run logs its own cost, so cost-per-PR stays
 * observable across the PR-size distribution and across re-reviews on new pushes.
 */
export interface PrCostRecord {
  owner: string;
  repo: string;
  prNumber: number;
  /** Total input tokens summed across the review + verification passes. */
  inputTokens: number;
  /** Total output tokens summed across the passes. */
  outputTokens: number;
  /** Total inference cost in USD (token usage × per-model rate). */
  costUsd: number;
  /** True when `costUsd` exceeded the configured per-PR threshold. */
  overThreshold: boolean;
}

export interface CostStore {
  record(record: PrCostRecord): Promise<void>;
}

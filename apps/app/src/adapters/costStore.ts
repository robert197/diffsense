import type { CostStore, PrCostRecord } from "@diffsense/core";
import type { Database } from "../db/client.js";
import { costs } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `CostStore` port (issue #12,
 * docs/ARCHITECTURE.md §1). `core` owns the port and the `PrCostRecord` shape;
 * this is the only place that knows it is Postgres. Each review run is an
 * append-only row. `costUsd` is written as a string so the exact `numeric(12,6)`
 * value round-trips without a lossy float.
 */
export function createDrizzleCostStore(db: Database): CostStore {
  return {
    async record(record: PrCostRecord): Promise<void> {
      await db.insert(costs).values({
        owner: record.owner,
        repo: record.repo,
        prNumber: record.prNumber,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUsd: record.costUsd.toString(),
        overThreshold: record.overThreshold,
      });
    },
  };
}

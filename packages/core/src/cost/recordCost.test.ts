import { describe, expect, it, vi } from "vitest";
import type { CostStore, PrCostRecord } from "../ports/costStore.js";
import type { ModelUsage } from "../schemas/cost.js";
import { type RateTable, computeCost, recordCost } from "./recordCost.js";

const PR = { owner: "octo-org", repo: "demo", prNumber: 42 };

const RATES: RateTable = {
  "claude-opus-4-8": { inputPer1M: 15, outputPer1M: 75 },
  "claude-fable-5": { inputPer1M: 1, outputPer1M: 5 },
};

// One review pass (opus) + one verify pass (opus) + synthesis (fable).
const USAGE: ModelUsage[] = [
  { model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 100_000 },
  { model: "claude-opus-4-8", inputTokens: 500_000, outputTokens: 50_000 },
  { model: "claude-fable-5", inputTokens: 2_000_000, outputTokens: 200_000 },
];

function fakeStore() {
  const records: PrCostRecord[] = [];
  const store: CostStore = {
    record: vi.fn(async (r: PrCostRecord) => {
      records.push(r);
    }),
  };
  return { store, records };
}

describe("computeCost", () => {
  it("sums token usage and prices it per model across the passes", () => {
    const out = computeCost(USAGE, RATES);
    // opus: (1.5M in * 15 + 150k out * 75)/1e6 = 22.5 + 11.25 = 33.75
    // fable: (2M in * 1 + 200k out * 5)/1e6 = 2 + 1 = 3
    expect(out.costUsd).toBeCloseTo(36.75, 6);
    expect(out.inputTokens).toBe(3_500_000);
    expect(out.outputTokens).toBe(350_000);
    expect(out.unpricedModels).toEqual([]);
  });

  it("counts tokens but reports models with no rate as unpriced", () => {
    const out = computeCost(
      [{ model: "mystery-model", inputTokens: 1000, outputTokens: 1000 }],
      RATES,
    );
    expect(out.costUsd).toBe(0);
    expect(out.inputTokens).toBe(1000);
    expect(out.unpricedModels).toEqual(["mystery-model"]);
  });

  it("returns zero for empty usage", () => {
    expect(computeCost([], RATES)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      unpricedModels: [],
    });
  });
});

describe("recordCost", () => {
  it("persists the computed cost and does not flag a PR under threshold", async () => {
    const { store, records } = fakeStore();
    const warn = vi.fn();

    const record = await recordCost(PR, USAGE, {
      store,
      rates: RATES,
      thresholdUsd: 50,
      logger: { warn },
    });

    expect(record.costUsd).toBeCloseTo(36.75, 6);
    expect(record.overThreshold).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags a PR over the threshold in the logs and on the record", async () => {
    const { store } = fakeStore();
    const warn = vi.fn();

    const record = await recordCost(PR, USAGE, {
      store,
      rates: RATES,
      thresholdUsd: 10,
      logger: { warn },
    });

    expect(record.overThreshold).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("exceeds threshold");
    expect(warn.mock.calls[0]?.[0]).toContain("octo-org/demo#42");
  });

  it("warns when a model is unpriced so the logged cost is not silently understated", async () => {
    const { store } = fakeStore();
    const warn = vi.fn();

    await recordCost(PR, [{ model: "mystery-model", inputTokens: 10, outputTokens: 10 }], {
      store,
      rates: RATES,
      thresholdUsd: 1,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("no rate for mystery-model");
  });
});

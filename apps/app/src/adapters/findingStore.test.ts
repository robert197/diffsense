import type { ReviewFinding } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { createDrizzleFindingStore } from "./findingStore.js";

const finding: ReviewFinding = {
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  fingerprint: "fp-a",
  file: "src/a.ts",
  tier: "High",
  rank: 0,
  explanation: "Adds a y constant.",
  claims: [{ claim: "y is unused", evidence: "src/a.ts:2" }],
  reasons: ["touches exported API"],
  blastRadius: ["src/b.ts:10 call a()"],
};

/** Drizzle row shape: jsonb columns come back already parsed. */
function rowFrom(f: ReviewFinding) {
  return { ...f, id: 1, createdAt: new Date() };
}

/** Minimal transaction stub: captures the delete + insert the swap issues. */
function txStub() {
  const deleteWhere = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));
  const insertValues = vi.fn(async (_rows: Record<string, unknown>[]) => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const tx = { delete: del, insert };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
  return { transaction, del, deleteWhere, insert, insertValues };
}

describe("createDrizzleFindingStore (#13)", () => {
  it("replaceForPr deletes the PR's rows then inserts the new run in one transaction", async () => {
    const t = txStub();
    const db = { transaction: t.transaction } as unknown as Database;

    await createDrizzleFindingStore(db).replaceForPr({ owner: "octo", repo: "demo", prNumber: 7 }, [
      finding,
    ]);

    expect(t.transaction).toHaveBeenCalledOnce();
    expect(t.del).toHaveBeenCalledOnce();
    expect(t.insertValues).toHaveBeenCalledOnce();
    expect(t.insertValues.mock.calls[0]?.[0]).toHaveLength(1);
    expect(t.insertValues.mock.calls[0]?.[0]?.[0]).toMatchObject({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      fingerprint: "fp-a",
      file: "src/a.ts",
      tier: "High",
      rank: 0,
      claims: finding.claims,
      reasons: finding.reasons,
      blastRadius: finding.blastRadius,
    });
  });

  it("replaceForPr deletes but skips the insert when the new run is empty", async () => {
    const t = txStub();
    const db = { transaction: t.transaction } as unknown as Database;

    await createDrizzleFindingStore(db).replaceForPr(
      { owner: "octo", repo: "demo", prNumber: 7 },
      [],
    );

    expect(t.del).toHaveBeenCalledOnce();
    expect(t.insert).not.toHaveBeenCalled();
  });

  it("listByPr maps rows back to validated findings", async () => {
    const orderBy = vi.fn(async () => [rowFrom(finding)]);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Database;

    const out = await createDrizzleFindingStore(db).listByPr({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
    });

    expect(out).toEqual([finding]);
  });

  it("listByPr surfaces a row whose JSON fails the schema (no silent drop)", async () => {
    const bad = { ...rowFrom(finding), reasons: [] }; // violates min(1)
    const orderBy = vi.fn(async () => [bad]);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Database;

    await expect(
      createDrizzleFindingStore(db).listByPr({ owner: "octo", repo: "demo", prNumber: 7 }),
    ).rejects.toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { createDrizzlePrStatusStore } from "./prStatusStore.js";

/** Minimal insert chain stub: captures the upsert values + options. */
function insertStub() {
  const onConflictDoUpdate = vi.fn(async (_opts: { setWhere?: unknown }) => undefined);
  const values = vi.fn((_row: Record<string, unknown>) => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoUpdate };
}

/** Minimal update chain stub: update().set().where(). */
function updateStub() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { update, set, where };
}

/** Minimal select chain stub: select().from().where().orderBy().limit(). */
function selectStub(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, limit, orderBy, where, from };
}

describe("createDrizzlePrStatusStore (#31)", () => {
  it("recordStatus upserts the derived label on the per-PR key", async () => {
    const s = insertStub();
    const db = { insert: s.insert } as unknown as Database;

    await createDrizzlePrStatusStore(db).recordStatus({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      installationId: 12,
      status: "merged",
    });

    expect(s.values.mock.calls[0]?.[0]).toMatchObject({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      status: "merged",
      installationId: 12,
    });
    expect(s.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("seedOpen inserts open and guards the conflict update behind status='open'", async () => {
    const s = insertStub();
    const db = { insert: s.insert } as unknown as Database;

    await createDrizzlePrStatusStore(db).seedOpen({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      installationId: 12,
    });

    expect(s.values.mock.calls[0]?.[0]).toMatchObject({ status: "open", installationId: 12 });
    const opts = s.onConflictDoUpdate.mock.calls[0]?.[0];
    // The setWhere guard is what stops a late open-PR event clobbering a terminal status.
    expect(opts?.setWhere).toBeDefined();
  });

  it("markSynced is a no-op for an empty batch", async () => {
    const s = updateStub();
    const db = { update: s.update } as unknown as Database;

    await createDrizzlePrStatusStore(db).markSynced([]);

    expect(s.update).not.toHaveBeenCalled();
  });

  it("markSynced bumps synced_at for the given PRs", async () => {
    const s = updateStub();
    const db = { update: s.update } as unknown as Database;

    await createDrizzlePrStatusStore(db).markSynced([{ owner: "octo", repo: "demo", prNumber: 7 }]);

    expect(s.update).toHaveBeenCalledOnce();
    expect(s.set).toHaveBeenCalledOnce();
    expect(s.where).toHaveBeenCalledOnce();
  });

  it("listOpenForPoll returns mapped open rows", async () => {
    const s = selectStub([
      { owner: "octo", repo: "demo", prNumber: 7, installationId: 12, status: "open" },
    ]);
    const db = { select: s.select } as unknown as Database;

    const rows = await createDrizzlePrStatusStore(db).listOpenForPoll(50);

    expect(s.limit).toHaveBeenCalledWith(50);
    expect(rows).toEqual([
      { owner: "octo", repo: "demo", prNumber: 7, installationId: 12, status: "open" },
    ]);
  });
});

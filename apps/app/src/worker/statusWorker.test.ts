import type { PrLifecycle, PrStatusPollRow, PrStatusReader, PrStatusStore } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import type { PrStatusUpdateJob } from "../types.js";
import { handleStatusUpdate, runStatusPoll } from "./statusWorker.js";

function fakeStore(rows: PrStatusPollRow[] = []): PrStatusStore & {
  recordStatus: ReturnType<typeof vi.fn>;
  markSynced: ReturnType<typeof vi.fn>;
  listOpenForPoll: ReturnType<typeof vi.fn>;
} {
  return {
    recordStatus: vi.fn(async () => {}),
    seedOpen: vi.fn(async () => {}),
    markSynced: vi.fn(async () => {}),
    listOpenForPoll: vi.fn(async () => rows),
  };
}

function reader(byKey: Record<string, PrLifecycle | null>): PrStatusReader {
  return {
    getPullRequestState: vi.fn(async ({ owner, repo, prNumber }) => {
      const key = `${owner}/${repo}#${prNumber}`;
      if (!(key in byKey)) {
        throw new Error(`no fixture for ${key}`);
      }
      return byKey[key] ?? null;
    }),
  };
}

const job = (over: Partial<PrStatusUpdateJob>): PrStatusUpdateJob => ({
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  installationId: 12,
  state: "closed",
  merged: true,
  deliveryId: "d1",
  ...over,
});

const row = (over: Partial<PrStatusPollRow>): PrStatusPollRow => ({
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  installationId: 12,
  status: "open",
  ...over,
});

describe("handleStatusUpdate (#31)", () => {
  it("records merged when a closed+merged webhook arrives", async () => {
    const store = fakeStore();
    await handleStatusUpdate(job({ state: "closed", merged: true }), store);
    expect(store.recordStatus).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      installationId: 12,
      status: "merged",
    });
  });

  it("records closed for a closed-not-merged webhook", async () => {
    const store = fakeStore();
    await handleStatusUpdate(job({ state: "closed", merged: false }), store);
    expect(store.recordStatus.mock.calls[0]?.[0]).toMatchObject({ status: "closed" });
  });

  it("records open for a reopened webhook", async () => {
    const store = fakeStore();
    await handleStatusUpdate(job({ state: "open", merged: false }), store);
    expect(store.recordStatus.mock.calls[0]?.[0]).toMatchObject({ status: "open" });
  });
});

describe("runStatusPoll (#31)", () => {
  it("does nothing when no open PRs are tracked", async () => {
    const store = fakeStore([]);
    const readerFor = vi.fn(async () => reader({}));
    const out = await runStatusPoll({ store, readerFor, batch: 50 });
    expect(out).toEqual({ checked: 0, changed: 0 });
    expect(readerFor).not.toHaveBeenCalled();
    expect(store.markSynced).not.toHaveBeenCalled();
  });

  it("reconciles a PR that merged while we were offline (R4)", async () => {
    const store = fakeStore([row({})]);
    const readerFor = vi.fn(async () =>
      reader({ "octo/demo#7": { state: "closed", merged: true } }),
    );

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    expect(out).toEqual({ checked: 1, changed: 1 });
    expect(store.recordStatus).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      installationId: 12,
      status: "merged",
    });
    // Changed rows are written, not markSynced.
    expect(store.markSynced).toHaveBeenCalledWith([]);
  });

  it("only bumps synced_at when the PR is still open", async () => {
    const store = fakeStore([row({})]);
    const readerFor = vi.fn(async () =>
      reader({ "octo/demo#7": { state: "open", merged: false } }),
    );

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    expect(out).toEqual({ checked: 1, changed: 0 });
    expect(store.recordStatus).not.toHaveBeenCalled();
    expect(store.markSynced).toHaveBeenCalledWith([{ owner: "octo", repo: "demo", prNumber: 7 }]);
  });

  it("skips a PR that no longer exists (404 → null) without recording", async () => {
    const store = fakeStore([row({})]);
    const readerFor = vi.fn(async () => reader({ "octo/demo#7": null }));

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    expect(out).toEqual({ checked: 1, changed: 0 });
    expect(store.recordStatus).not.toHaveBeenCalled();
    expect(store.markSynced).toHaveBeenCalledWith([{ owner: "octo", repo: "demo", prNumber: 7 }]);
  });

  it("mints one reader per installation, not per PR (R5)", async () => {
    const store = fakeStore([row({ prNumber: 1 }), row({ prNumber: 2 })]);
    const readerFor = vi.fn(async () =>
      reader({
        "octo/demo#1": { state: "open", merged: false },
        "octo/demo#2": { state: "open", merged: false },
      }),
    );

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    expect(out.checked).toBe(2);
    expect(readerFor).toHaveBeenCalledOnce();
  });

  it("passes the batch cap through to the store query (R5)", async () => {
    const store = fakeStore([]);
    const readerFor = vi.fn(async () => reader({}));
    await runStatusPoll({ store, readerFor, batch: 10 });
    expect(store.listOpenForPoll).toHaveBeenCalledWith(10);
  });

  it("does not abort the batch when one PR's read throws", async () => {
    const store = fakeStore([row({ prNumber: 1 }), row({ prNumber: 2 })]);
    const failing: PrStatusReader = {
      getPullRequestState: vi.fn(async ({ prNumber }): Promise<PrLifecycle | null> => {
        if (prNumber === 1) {
          throw new Error("boom");
        }
        return { state: "closed", merged: true };
      }),
    };
    const readerFor = vi.fn(async () => failing);

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    // PR 1 threw (left for next tick); PR 2 still reconciled to merged.
    expect(out).toEqual({ checked: 2, changed: 1 });
    expect(store.recordStatus).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      prNumber: 2,
      installationId: 12,
      status: "merged",
    });
  });
});

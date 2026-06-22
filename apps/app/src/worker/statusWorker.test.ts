import type {
  GitHubPrRef,
  PrLifecycle,
  PrStatusPollRow,
  PrStatusReader,
  PrStatusStore,
} from "@diffsense/core";
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

    // PR 1 threw; PR 2 still reconciled to merged.
    expect(out).toEqual({ checked: 2, changed: 1 });
    expect(store.recordStatus).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      prNumber: 2,
      installationId: 12,
      status: "merged",
    });
  });

  it("advances synced_at for a PR whose live read fails, so it rotates instead of pinning the head (R4/R5)", async () => {
    // The batch is the oldest-synced open PRs; a read failure that does NOT bump synced_at
    // would re-anchor the batch head every tick and starve healthy PRs behind it. Assert
    // the failed read still rotates (synced_at bumped), alongside the unchanged one.
    const store = fakeStore([row({ prNumber: 1 }), row({ prNumber: 2 })]);
    const failing: PrStatusReader = {
      getPullRequestState: vi.fn(async ({ prNumber }): Promise<PrLifecycle | null> => {
        if (prNumber === 1) {
          throw new Error("GitHub 502");
        }
        return { state: "open", merged: false };
      }),
    };
    const readerFor = vi.fn(async () => failing);

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    expect(out).toEqual({ checked: 2, changed: 0 });
    expect(store.recordStatus).not.toHaveBeenCalled();
    const synced = store.markSynced.mock.calls[0]?.[0] as GitHubPrRef[];
    expect(synced.map((r) => r.prNumber).sort()).toEqual([1, 2]);
  });

  it("rotates an entire unreadable installation's rows and still processes other installations (R4/R5)", async () => {
    // Installation 12 can't mint a reader (suspended/uninstalled); installation 13 is fine.
    // The dead installation's rows must still advance synced_at so they can't permanently
    // occupy the batch head — the whole point of the bounded oldest-synced rotation.
    const store = fakeStore([
      row({ prNumber: 1, installationId: 12 }),
      row({ prNumber: 2, installationId: 13 }),
    ]);
    const readerFor = vi.fn(async (installationId: number) => {
      if (installationId === 12) {
        throw new Error("installation suspended");
      }
      return reader({ "octo/demo#2": { state: "open", merged: false } });
    });

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    // Only the healthy installation's PR was actually read.
    expect(out).toEqual({ checked: 1, changed: 0 });
    expect(store.recordStatus).not.toHaveBeenCalled();
    // ...but both rows advance synced_at so the dead installation can't pin the head.
    const synced = store.markSynced.mock.calls[0]?.[0] as GitHubPrRef[];
    expect(synced.map((r) => r.prNumber).sort()).toEqual([1, 2]);
  });

  it("leaves synced_at untouched when a changed PR's status write fails, so the next tick retries it", async () => {
    // A genuine change whose recordStatus write fails has pending work — unlike a read
    // failure, it should be retried promptly (not rotated to the back of the batch).
    const store = fakeStore([row({ prNumber: 1 }), row({ prNumber: 2 })]);
    store.recordStatus.mockImplementation(async ({ prNumber }: { prNumber: number }) => {
      if (prNumber === 1) {
        throw new Error("db write failed");
      }
    });
    const readerFor = vi.fn(async () =>
      reader({
        "octo/demo#1": { state: "closed", merged: true },
        "octo/demo#2": { state: "closed", merged: true },
      }),
    );

    const out = await runStatusPoll({ store, readerFor, batch: 50 });

    // Both detected as changed; PR 2's write landed (counted), PR 1's failed.
    expect(out).toEqual({ checked: 2, changed: 1 });
    // Neither merged PR is in the synced set (changed rows get a full write, not a bump),
    // so PR 1's failed write is left un-synced and re-attempted on the next tick.
    expect(store.markSynced).toHaveBeenCalledWith([]);
  });
});

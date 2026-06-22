import { describe, expect, it, vi } from "vitest";
import { type PrStatusReaderClient, createGitHubPrStatusReader } from "./prStatusReader.js";

const ref = { owner: "octo", repo: "demo", prNumber: 7 };

function fakeClient(get: PrStatusReaderClient["rest"]["pulls"]["get"]): PrStatusReaderClient {
  return { rest: { pulls: { get } } };
}

describe("createGitHubPrStatusReader (#31)", () => {
  it("maps a merged PR through", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(vi.fn(async () => ({ data: { state: "closed", merged: true } }))),
    );
    await expect(reader.getPullRequestState(ref)).resolves.toEqual({
      state: "closed",
      merged: true,
    });
  });

  it("maps a closed-not-merged PR through", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(vi.fn(async () => ({ data: { state: "closed", merged: false } }))),
    );
    await expect(reader.getPullRequestState(ref)).resolves.toEqual({
      state: "closed",
      merged: false,
    });
  });

  it("maps an open PR through", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(vi.fn(async () => ({ data: { state: "open", merged: false } }))),
    );
    await expect(reader.getPullRequestState(ref)).resolves.toEqual({
      state: "open",
      merged: false,
    });
  });

  it("coerces an unexpected state to open and a missing merged flag to false", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(vi.fn(async () => ({ data: { state: "weird" } }))),
    );
    await expect(reader.getPullRequestState(ref)).resolves.toEqual({
      state: "open",
      merged: false,
    });
  });

  it("returns null when the PR no longer exists (404)", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(
        vi.fn(async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }),
      ),
    );
    await expect(reader.getPullRequestState(ref)).resolves.toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const reader = createGitHubPrStatusReader(
      fakeClient(
        vi.fn(async () => {
          throw Object.assign(new Error("rate limited"), { status: 403 });
        }),
      ),
    );
    await expect(reader.getPullRequestState(ref)).rejects.toThrow("rate limited");
  });
});

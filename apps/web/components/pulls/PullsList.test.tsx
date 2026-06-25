// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadPullsResult } from "../../app/repos/[owner]/[repo]/pulls/actions";
import type { PullRequest } from "../../lib/github";

// The list syncs through the server action; mock it so we drive results deterministically.
const loadOpenPullRequests = vi.fn<[string, string], Promise<LoadPullsResult>>();
vi.mock("../../app/repos/[owner]/[repo]/pulls/actions", () => ({
  loadOpenPullRequests: (owner: string, repo: string) => loadOpenPullRequests(owner, repo),
}));

// Reauth routes via the router; capture push.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { PullsList } from "./PullsList";

function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: "Add widget",
    author: "octocat",
    updatedAt: "2026-06-24T10:00:00Z",
    draft: false,
    url: "https://github.com/acme/web/pull/1",
    ...over,
  };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  loadOpenPullRequests.mockReset();
  push.mockReset();
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

function renderList(initial: PullRequest[]) {
  return render(<PullsList owner="acme" repo="web" initialPulls={initial} />);
}

function fireFocus() {
  fireEvent(document, new Event("visibilitychange"));
  fireEvent(window, new Event("focus"));
}

describe("PullsList", () => {
  it("renders initialPulls immediately with the count and no sync call", () => {
    renderList([pull({ number: 1, title: "First" }), pull({ number: 2, title: "Second" })]);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.getByText("2 open pull requests")).toBeTruthy();
    expect(loadOpenPullRequests).not.toHaveBeenCalled();
  });

  it("renders the empty state when there are no PRs", () => {
    renderList([]);
    expect(screen.getByText("No open pull requests")).toBeTruthy();
    expect(screen.getByText("Open pull requests")).toBeTruthy();
  });

  it("refetches on tab refocus once outside the throttle window", async () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [pull({ number: 9, title: "Fresh" })] });
    renderList([pull({ number: 1, title: "Old" })]);

    now += 11_000; // past MIN_REFOCUS_INTERVAL_MS
    fireFocus();

    await waitFor(() => expect(loadOpenPullRequests).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Fresh")).toBeTruthy());
    expect(screen.queryByText("Old")).toBeNull();
  });

  it("does not refetch on refocus within the throttle window", () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [] });
    renderList([pull()]);
    now += 2_000; // still inside the throttle window
    fireFocus();
    expect(loadOpenPullRequests).not.toHaveBeenCalled();
  });

  it("pins the throttle boundary: blocked just under, allowed at the interval (strict <)", async () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [] });
    renderList([pull()]);

    now += 9_999; // one ms under MIN_REFOCUS_INTERVAL_MS — still blocked (diff < interval)
    fireFocus();
    expect(loadOpenPullRequests).not.toHaveBeenCalled();

    now += 1; // exactly at the interval — the guard's `< interval` is now false → allowed
    fireFocus();
    await waitFor(() => expect(loadOpenPullRequests).toHaveBeenCalledTimes(1));
  });

  it("does not refetch on refocus while the tab is hidden", () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [] });
    renderList([pull()]);
    now += 11_000; // past the throttle, so only the visibility guard can block it
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(loadOpenPullRequests).not.toHaveBeenCalled();
  });

  it("drops a merged/closed PR that is no longer in the synced list", async () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [pull({ number: 1, title: "Stays open" })] });
    renderList([
      pull({ number: 1, title: "Stays open" }),
      pull({ number: 2, title: "Got merged" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.queryByText("Got merged")).toBeNull());
    expect(screen.getByText("Stays open")).toBeTruthy();
    expect(screen.getByText("1 open pull request")).toBeTruthy();
  });

  it("shows the error status (and keeps the list) when a sync throws", async () => {
    loadOpenPullRequests.mockRejectedValue(new Error("transient 500"));
    renderList([pull({ number: 1, title: "Still here" })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.getByText(/couldn't sync/i)).toBeTruthy());
    expect(screen.getByText("Still here")).toBeTruthy(); // list preserved
    expect(push).not.toHaveBeenCalled(); // a thrown error is not a reauth redirect
  });

  it("always syncs on a manual Refresh click, bypassing the throttle", async () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [pull({ number: 5, title: "Synced" })] });
    renderList([pull({ number: 1, title: "Before" })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(loadOpenPullRequests).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Synced")).toBeTruthy());
  });

  it("does not duplicate an in-flight load", async () => {
    let resolve!: (r: LoadPullsResult) => void;
    loadOpenPullRequests.mockReturnValue(
      new Promise<LoadPullsResult>((r) => {
        resolve = r;
      }),
    );
    renderList([pull()]);

    const button = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(loadOpenPullRequests).toHaveBeenCalledTimes(1);

    resolve({ pulls: [] });
    await waitFor(() => expect(screen.getByText("No open pull requests")).toBeTruthy());
  });

  it("routes to /login when the action reports reauth", async () => {
    loadOpenPullRequests.mockResolvedValue({ error: "reauth" });
    renderList([pull({ number: 1, title: "Stays" })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    // The list is not replaced on reauth.
    expect(screen.getByText("Stays")).toBeTruthy();
  });

  it("does not update state when a load resolves after unmount", async () => {
    let resolve!: (r: LoadPullsResult) => void;
    loadOpenPullRequests.mockReturnValue(
      new Promise<LoadPullsResult>((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderList([pull()]);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    unmount();
    // Resolving after unmount must not throw or route.
    resolve({ pulls: [pull({ number: 2 })] });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  // U3 — changed / new-PR markers
  it("shows no markers on first paint", () => {
    renderList([pull({ number: 1 }), pull({ number: 2 })]);
    expect(screen.queryByText("New")).toBeNull();
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("marks a newly-appeared PR as New", async () => {
    loadOpenPullRequests.mockResolvedValue({
      pulls: [pull({ number: 1, title: "Existing" }), pull({ number: 2, title: "Brand new" })],
    });
    renderList([pull({ number: 1, title: "Existing" })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.getByText("Brand new")).toBeTruthy());
    expect(screen.getByText("New")).toBeTruthy();
    // The pre-existing PR is not marked.
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("marks a PR whose updatedAt advanced as Updated", async () => {
    loadOpenPullRequests.mockResolvedValue({
      pulls: [pull({ number: 1, updatedAt: "2026-06-24T12:00:00Z" })],
    });
    renderList([pull({ number: 1, updatedAt: "2026-06-24T10:00:00Z" })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.getByText("Updated")).toBeTruthy());
    expect(screen.queryByText("New")).toBeNull();
  });

  it("does not mark a PR whose updatedAt is unchanged", async () => {
    loadOpenPullRequests.mockResolvedValue({ pulls: [pull({ number: 1 })] });
    renderList([pull({ number: 1 })]);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(loadOpenPullRequests).toHaveBeenCalled());
    expect(screen.queryByText("New")).toBeNull();
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("clears markers on the next sync", async () => {
    loadOpenPullRequests
      .mockResolvedValueOnce({
        pulls: [pull({ number: 1, title: "A" }), pull({ number: 2, title: "B" })],
      })
      .mockResolvedValueOnce({
        pulls: [pull({ number: 1, title: "A" }), pull({ number: 2, title: "B" })],
      });
    renderList([pull({ number: 1, title: "A" })]);

    const button = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("New")).toBeTruthy());

    fireEvent.click(button);
    await waitFor(() => expect(loadOpenPullRequests).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("New")).toBeNull());
  });
});

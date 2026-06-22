import { describe, expect, it } from "vitest";
import { derivePrStatus, isArchivedStatus, reconcilePrStatus } from "./prStatus.js";

describe("derivePrStatus", () => {
  it("maps an open PR to open", () => {
    expect(derivePrStatus({ state: "open", merged: false })).toBe("open");
  });

  it("maps a closed-and-merged PR to merged", () => {
    expect(derivePrStatus({ state: "closed", merged: true })).toBe("merged");
  });

  it("maps a closed-not-merged PR to closed", () => {
    expect(derivePrStatus({ state: "closed", merged: false })).toBe("closed");
  });

  it("lets state win for the anomalous open+merged pair", () => {
    // GitHub never sets merged on an open PR; we don't depend on that and keep open.
    expect(derivePrStatus({ state: "open", merged: true })).toBe("open");
  });
});

describe("isArchivedStatus", () => {
  it("treats merged and closed as archived", () => {
    expect(isArchivedStatus("merged")).toBe(true);
    expect(isArchivedStatus("closed")).toBe(true);
  });

  it("treats open as active", () => {
    expect(isArchivedStatus("open")).toBe(false);
  });
});

describe("reconcilePrStatus", () => {
  it("flags a change when an open PR has merged since (offline reconcile)", () => {
    expect(reconcilePrStatus("open", { state: "closed", merged: true })).toEqual({
      status: "merged",
      changed: true,
    });
  });

  it("flags a change when an open PR was closed without merge", () => {
    expect(reconcilePrStatus("open", { state: "closed", merged: false })).toEqual({
      status: "closed",
      changed: true,
    });
  });

  it("reports no change when the live state still matches", () => {
    expect(reconcilePrStatus("merged", { state: "closed", merged: true })).toEqual({
      status: "merged",
      changed: false,
    });
    expect(reconcilePrStatus("open", { state: "open", merged: false })).toEqual({
      status: "open",
      changed: false,
    });
  });

  it("flags a change when a closed PR was reopened", () => {
    expect(reconcilePrStatus("closed", { state: "open", merged: false })).toEqual({
      status: "open",
      changed: true,
    });
  });
});

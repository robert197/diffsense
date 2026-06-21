import { beforeEach, describe, expect, it, vi } from "vitest";

// The action delegates the DB write to lib/deck; mock it to capture the call.
const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  // The action gates on getSession; default to a signed-in reviewer, override per test.
  session: { current: { login: "octocat" } as unknown },
}));
vi.mock("../../../../../../lib/deck", () => ({
  recordSwipe: (...args: unknown[]) => {
    h.calls.push(args);
    return Promise.resolve();
  },
}));
vi.mock("../../../../../../lib/auth/session", () => ({
  getSession: () => Promise.resolve(h.session.current),
}));

import { recordSwipe } from "./actions";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    f.set(k, v);
  }
  return f;
}

const valid = {
  owner: "acme",
  repo: "web",
  prNumber: "7",
  fingerprint: "fp",
  tier: "High",
  sentiment: "up",
};

describe("recordSwipe action", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.session.current = { login: "octocat" };
  });

  it("persists a valid swipe with the parsed ref", async () => {
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual([{ owner: "acme", repo: "web", prNumber: 7 }, "fp", "High", "up"]);
  });

  it("drops the write when there is no authenticated session", async () => {
    h.session.current = null;
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a missing owner", async () => {
    const f = form(valid);
    f.delete("owner");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a missing repo", async () => {
    const f = form(valid);
    f.delete("repo");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a non-positive prNumber", async () => {
    await recordSwipe(form({ ...valid, prNumber: "0" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an out-of-enum tier", async () => {
    await recordSwipe(form({ ...valid, tier: "Critical" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an out-of-enum sentiment", async () => {
    await recordSwipe(form({ ...valid, sentiment: "meh" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a missing fingerprint", async () => {
    const f = form(valid);
    f.delete("fingerprint");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });
});

import type { Card } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";

// Capture inserts without a real database. `recordSwipe` calls `getDb().insert(table).values(...)`;
// the fake records the payload so the write contract is unit-testable.
const h = vi.hoisted(() => ({ inserts: [] as Array<{ values: Record<string, unknown> }> }));

vi.mock("./db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ values });
        return Promise.resolve();
      },
    }),
  }),
  decks: {},
  reactions: {},
}));

import { type DeckRow, latestDeckFromRows, recordSwipe, resolveCardFileTexts } from "./deck";
import { GitHubAuthError, GitHubRateLimitError } from "./github";

const ref = { owner: "acme", repo: "web", prNumber: 7 };

function card(fingerprint: string): Card {
  return {
    fingerprint,
    file: "src/a.ts",
    tier: "High",
    rank: 0,
    riskScore: 1.2,
    highlights: [],
    suggestions: [],
    explanation: "does a thing",
  };
}

function row(headSha: string, cards: unknown, createdAtMs: number, id: number): DeckRow {
  return { headSha, cards, createdAt: new Date(createdAtMs), id };
}

describe("latestDeckFromRows", () => {
  it("validates a stored row into a Deck, preserving card order", () => {
    const cards = [card("a"), card("b")];
    const deck = latestDeckFromRows([row("sha1", cards, 1000, 1)], ref);
    expect(deck).not.toBeNull();
    expect(deck?.headSha).toBe("sha1");
    expect(deck?.cards.map((c) => c.fingerprint)).toEqual(["a", "b"]);
  });

  it("returns null when the PR has no deck", () => {
    expect(latestDeckFromRows([], ref)).toBeNull();
  });

  it("picks the newest row by createdAt, breaking ties by id", () => {
    const older = row("old", [card("a")], 1000, 1);
    const newer = row("new", [card("b")], 2000, 2);
    expect(latestDeckFromRows([older, newer], ref)?.headSha).toBe("new");
    expect(latestDeckFromRows([newer, older], ref)?.headSha).toBe("new");

    const tieLow = row("low", [card("a")], 3000, 5);
    const tieHigh = row("high", [card("b")], 3000, 9);
    expect(latestDeckFromRows([tieLow, tieHigh], ref)?.headSha).toBe("high");
  });

  it("degrades a malformed cards payload to null (logged) instead of crashing the page", () => {
    // Missing `highlights`/`suggestions`/`explanation` — a schema-drift / corrupt row.
    const bad = [{ fingerprint: "x", file: "a.ts", tier: "High", rank: 0, riskScore: 1 }];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(latestDeckFromRows([row("sha", bad, 1000, 1)], ref)).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("degrades a non-array cards payload to null rather than throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(latestDeckFromRows([row("sha", "not-an-array", 1000, 1)], ref)).toBeNull();
    expect(latestDeckFromRows([row("sha", null, 1000, 1)], ref)).toBeNull();
    spy.mockRestore();
  });
});

describe("resolveCardFileTexts", () => {
  const headSha = "abc123";

  it("reads each unique file once and degrades a per-file failure to null", async () => {
    const getFileAtRef = vi.fn(async (_o: string, _r: string, path: string) => {
      if (path === "src/a.ts") return "a\nb\nc";
      throw new GitHubRateLimitError(); // src/b.ts is rate-limited this render
    });
    const map = await resolveCardFileTexts(
      { getFileAtRef },
      "acme",
      "web",
      headSha,
      ["src/a.ts", "src/b.ts", "src/a.ts"], // a.ts appears twice
      30,
    );
    expect(getFileAtRef).toHaveBeenCalledTimes(2); // deduped
    expect(map.get("src/a.ts")).toBe("a\nb\nc");
    expect(map.get("src/b.ts")).toBeNull(); // degraded, not thrown
  });

  it("caps the number of files fetched so a huge PR cannot fan out unbounded", async () => {
    const getFileAtRef = vi.fn(async (_o: string, _r: string, path: string) => path);
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const map = await resolveCardFileTexts({ getFileAtRef }, "acme", "web", headSha, files, 30);
    expect(getFileAtRef).toHaveBeenCalledTimes(30);
    expect(map.size).toBe(30);
    expect(map.has("f29.ts")).toBe(true);
    expect(map.has("f30.ts")).toBe(false); // beyond the cap — card degrades to a label
  });

  it("propagates a GitHubAuthError so the page can clear the session and redirect", async () => {
    const getFileAtRef = vi.fn(async () => {
      throw new GitHubAuthError();
    });
    await expect(
      resolveCardFileTexts({ getFileAtRef }, "acme", "web", headSha, ["src/a.ts"], 30),
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("fetches at the deck's head SHA", async () => {
    const getFileAtRef = vi.fn(async () => "x");
    await resolveCardFileTexts({ getFileAtRef }, "acme", "web", headSha, ["src/a.ts"], 30);
    expect(getFileAtRef).toHaveBeenCalledWith("acme", "web", "src/a.ts", headSha);
  });
});

describe("recordSwipe", () => {
  it("appends an up reaction keyed by fingerprint + tier", async () => {
    h.inserts.length = 0;
    await recordSwipe(ref, "fp-up", "High", "up");
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].values).toMatchObject({
      owner: "acme",
      repo: "web",
      prNumber: 7,
      fingerprint: "fp-up",
      tier: "High",
      sentiment: "up",
    });
  });

  it("records a down reaction for a flag swipe", async () => {
    h.inserts.length = 0;
    await recordSwipe(ref, "fp-down", "Medium", "down");
    expect(h.inserts[0].values).toMatchObject({ fingerprint: "fp-down", sentiment: "down" });
  });
});

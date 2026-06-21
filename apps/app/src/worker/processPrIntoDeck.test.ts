import type { Deck, DeckStore, ReviewFinding } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import { processPrIntoDeck } from "./processPrIntoDeck.js";

const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function login() {
+  return checkToken();
 }
`;

const ctx = { owner: "octo", repo: "demo", prNumber: 7, headSha: "abc123", diff };

/** A DeckStore that captures what was saved. */
function fakeDeckStore(): DeckStore & { saved: Deck[] } {
  const saved: Deck[] = [];
  return {
    saved,
    async save(deck) {
      saved.push(deck);
    },
    async get() {
      return saved.at(-1) ?? null;
    },
  };
}

describe("processPrIntoDeck (#26)", () => {
  it("builds a deck keyed to the PR + head SHA and persists it", async () => {
    const store = fakeDeckStore();

    const deck = await processPrIntoDeck(ctx, [], store);

    expect(deck.owner).toBe("octo");
    expect(deck.repo).toBe("demo");
    expect(deck.prNumber).toBe(7);
    expect(deck.headSha).toBe("abc123");
    expect(deck.cards).toHaveLength(1);
    expect(store.saved).toEqual([deck]);
  });

  it("folds review findings into the matching card", async () => {
    const store = fakeDeckStore();
    // Discover the structural fingerprint the deck assigns this hunk.
    const fingerprint = (await processPrIntoDeck(ctx, [], fakeDeckStore())).cards[0]
      ?.fingerprint as string;

    const finding: ReviewFinding = {
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      fingerprint,
      file: "src/auth.ts",
      tier: "High",
      rank: 0,
      explanation: "Delegates the login decision to checkToken().",
      claims: [{ claim: "checkToken() result is returned unawaited", evidence: "src/auth.ts:2" }],
      reasons: ["auth path"],
      blastRadius: [],
    };

    const deck = await processPrIntoDeck(ctx, [finding], store);

    expect(deck.cards[0]?.explanation).toBe("Delegates the login decision to checkToken().");
    expect(deck.cards[0]?.suggestions).toEqual(["checkToken() result is returned unawaited"]);
  });

  it("persists an empty deck for an empty diff", async () => {
    const store = fakeDeckStore();
    const save = vi.spyOn(store, "save");

    const deck = await processPrIntoDeck({ ...ctx, diff: "" }, [], store);

    expect(deck.cards).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
  });
});

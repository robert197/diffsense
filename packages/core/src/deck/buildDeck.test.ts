import { describe, expect, it } from "vitest";
import type { DeckRef } from "../ports/deckStore.js";
import { fingerprintChunk } from "../review/fingerprint.js";
import { buildReviewChunks } from "../review/reviewFindings.js";
import { DeckSchema } from "../schemas/card.js";
import type { ReviewFinding } from "../schemas/finding.js";
import { buildDeck } from "./buildDeck.js";

const meta: DeckRef = { owner: "octo", repo: "demo", prNumber: 7, headSha: "abc123" };

// Two changed hunks: an auth-path change (high structural risk, exported symbol)
// and a small utility tweak. The deck must carry a card for both.
const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,4 @@
 export function login() {
-  return false;
+  const ok = checkToken();
+  if (!ok) return false;
+  return true;
 }
diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -10,2 +10,3 @@
 function noop() {
+  log("x");
 }
`;

/** Build a finding keyed to a card's structural fingerprint (the join key). */
function findingFor(fingerprint: string, over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    owner: meta.owner,
    repo: meta.repo,
    prNumber: meta.prNumber,
    fingerprint,
    file: "src/auth.ts",
    tier: "High",
    rank: 0,
    explanation: "Replaces the always-false stub with a real token check.",
    claims: [
      { claim: "checkToken() is never awaited", evidence: "src/auth.ts:2" },
      { claim: "the failure path returns before logging", evidence: "src/auth.ts:3" },
    ],
    reasons: ["auth path"],
    blastRadius: [],
    ...over,
  };
}

describe("buildDeck (#26)", () => {
  it("emits one card per changed hunk so the deck covers all changed code", () => {
    const deck = buildDeck(diff, meta, []);
    expect(deck.cards).toHaveLength(2);
    expect(deck.cards.map((c) => c.file).sort()).toEqual(["src/auth.ts", "src/util.ts"]);
  });

  it("orders cards by risk, highest first (rank 0 = the auth change)", () => {
    const deck = buildDeck(diff, meta, []);
    expect(deck.cards[0]?.file).toBe("src/auth.ts");
    expect(deck.cards[0]?.rank).toBe(0);
    expect(deck.cards[1]?.rank).toBe(1);
    // Risk score is monotonic non-increasing across the deck order.
    expect(deck.cards[0]?.riskScore).toBeGreaterThanOrEqual(deck.cards[1]?.riskScore as number);
  });

  it("highlights the exact changed line ranges", () => {
    const deck = buildDeck(diff, meta, []);
    const auth = deck.cards.find((c) => c.file === "src/auth.ts");
    const util = deck.cards.find((c) => c.file === "src/util.ts");
    expect(auth?.highlights).toEqual([{ side: "R", start: 2, end: 4 }]);
    expect(util?.highlights).toEqual([{ side: "R", start: 11, end: 11 }]);
  });

  it("folds a reviewed hunk's finding into explanation + suggestions", () => {
    // First pass with no findings reveals the structural fingerprint to key on.
    const authFingerprint = buildDeck(diff, meta, []).cards.find((c) => c.file === "src/auth.ts")
      ?.fingerprint as string;

    const deck = buildDeck(diff, meta, [findingFor(authFingerprint)]);
    const auth = deck.cards.find((c) => c.file === "src/auth.ts");

    expect(auth?.explanation).toBe("Replaces the always-false stub with a real token check.");
    expect(auth?.suggestions).toEqual([
      "checkToken() is never awaited",
      "the failure path returns before logging",
    ]);
  });

  it("gives a non-reviewed hunk a factual default explanation and no suggestions", () => {
    const deck = buildDeck(diff, meta, []);
    const util = deck.cards.find((c) => c.file === "src/util.ts");
    expect(util?.suggestions).toEqual([]);
    expect(util?.explanation).toContain("src/util.ts");
    expect(util?.explanation).toContain("1 line added");
  });

  it("highlights removed lines on the left side for a pure-deletion hunk", () => {
    const deletion = `diff --git a/src/old.ts b/src/old.ts
--- a/src/old.ts
+++ b/src/old.ts
@@ -4,4 +4,1 @@
 keep();
-drop1();
-drop2();
-drop3();
`;
    const card = buildDeck(deletion, meta, []).cards[0];
    expect(card?.highlights).toEqual([{ side: "L", start: 5, end: 7 }]);
  });

  it("splits non-contiguous added lines into separate ranges", () => {
    const gapped = `diff --git a/src/gap.ts b/src/gap.ts
--- a/src/gap.ts
+++ b/src/gap.ts
@@ -1,3 +1,5 @@
+top();
 a();
 b();
+bottom();
 c();
`;
    const card = buildDeck(gapped, meta, []).cards[0];
    expect(card?.highlights).toEqual([
      { side: "R", start: 1, end: 1 },
      { side: "R", start: 4, end: 4 },
    ]);
  });

  it("keys cards by the same structural fingerprint the review pass produces", () => {
    // Lock the coupling: a finding the review pass would emit must attach to its
    // card. `buildReviewChunks` builds the patch the review pass fingerprints, so
    // the card's fingerprint must equal `fingerprintChunk(file, that patch)`.
    const chunks = buildReviewChunks(diff, meta);
    const authChunk = chunks.find((c) => c.file === "src/auth.ts");
    const reviewFingerprint = fingerprintChunk(
      authChunk?.file as string,
      authChunk?.patch as string,
    );

    const card = buildDeck(diff, meta, []).cards.find((c) => c.file === "src/auth.ts");
    expect(card?.fingerprint).toBe(reviewFingerprint);
  });

  it("returns an empty deck for an empty diff", () => {
    expect(buildDeck("", meta, []).cards).toEqual([]);
    expect(buildDeck("   ", meta, []).cards).toEqual([]);
  });

  it("produces a deck that validates against DeckSchema", () => {
    const deck = buildDeck(diff, meta, []);
    expect(() => DeckSchema.parse(deck)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { RankedChunk, Tier } from "../rank/rankHunks.js";
import { renderComment } from "./renderComment.js";

function chunk(file: string, tier: Tier, reason = "Small change (1 lines)"): RankedChunk {
  return {
    file,
    line: 10,
    side: "R",
    added: 1,
    deleted: 0,
    score: 1,
    tier,
    reason,
    deepLink: "https://github.com/o/r/pull/1/files#diff-abcR10",
    signals: {
      sizeScore: 1,
      riskPath: false,
      riskPathLabel: null,
      apiBoundary: false,
      missingTestDelta: false,
    },
  };
}

const NO_MERGE_WORDS = /\b(block|approve|approved|lgtm|request changes|merge)\b/i;

describe("renderComment (R3, R4)", () => {
  it("lists High and Medium items with link, reason, and tier; collapses Low to one line", () => {
    const out = renderComment([
      chunk("src/auth/login.ts", "High", "Large change (60 lines), in a auth path"),
      chunk("src/api/users.ts", "Medium", "Medium change (20 lines), touches exported API"),
      chunk("src/lib/a.ts", "Low"),
      chunk("src/lib/b.ts", "Low"),
    ]);

    expect(out).toContain("**[High]**");
    expect(out).toContain("**[Medium]**");
    expect(out).toContain(
      "[src/auth/login.ts:10](https://github.com/o/r/pull/1/files#diff-abcR10)",
    );
    expect(out).toContain("in a auth path");
    expect(out).toContain("touches exported API");
    // Low remainder collapses to exactly one summary line naming the count.
    expect(out).toContain("Plus 2 lower-risk hunks not listed.");
    expect(out).not.toContain("**[Low]**");
  });

  it("uses the singular for a single Low hunk", () => {
    const out = renderComment([chunk("a.ts", "High"), chunk("b.ts", "Low")]);
    expect(out).toContain("Plus 1 lower-risk hunk not listed.");
  });

  it("renders header and items even with no Low remainder", () => {
    const out = renderComment([chunk("a.ts", "High")]);
    expect(out).toContain("diffsense");
    expect(out).toContain("**[High]**");
    expect(out).not.toContain("lower-risk");
  });

  it("handles a tier mix with no High without throwing", () => {
    const out = renderComment([chunk("a.ts", "Medium"), chunk("b.ts", "Low")]);
    expect(out).toContain("**[Medium]**");
    expect(out).toContain("Plus 1 lower-risk hunk not listed.");
  });

  it("renders an advisory message for an empty ranking", () => {
    const out = renderComment([]);
    expect(out).toContain("No rankable changes");
    expect(out).not.toContain("**[");
  });

  it("orders High before Medium", () => {
    const out = renderComment([chunk("med.ts", "Medium"), chunk("high.ts", "High")]);
    expect(out.indexOf("high.ts")).toBeLessThan(out.indexOf("med.ts"));
  });

  it("never uses merge-gating language (advisory only)", () => {
    const out = renderComment([
      chunk("src/auth/login.ts", "High", "Large change (60 lines), in a auth path"),
      chunk("src/lib/a.ts", "Low"),
    ]);
    expect(out).not.toMatch(NO_MERGE_WORDS);
    expect(renderComment([])).not.toMatch(NO_MERGE_WORDS);
  });
});

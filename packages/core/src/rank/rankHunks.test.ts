import { describe, expect, it } from "vitest";
import { type PrMeta, type RiskCategory, rankHunks } from "./rankHunks.js";

const META: PrMeta = { owner: "octo-org", repo: "demo", prNumber: 42 };

/** Build a single-file, single-hunk diff with `added` adds and `deleted` dels. */
function fileDiff(path: string, added: number, deleted: number, exported = false): string {
  const addLines: string[] = [];
  for (let i = 0; i < added; i++) {
    addLines.push(exported && i === 0 ? `+export const v${i} = ${i};` : `+const v${i} = ${i};`);
  }
  const delLines: string[] = [];
  for (let i = 0; i < deleted; i++) {
    delLines.push(`-const old${i} = ${i};`);
  }
  const newLines = Math.max(1, added + 1);
  const oldLines = Math.max(1, deleted + 1);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines} +1,${newLines} @@`,
    " const anchor = true;",
    ...addLines,
    ...delLines,
    "",
  ].join("\n");
}

describe("rankHunks — scoring (R1)", () => {
  it("returns [] for an empty or whitespace-only diff", () => {
    expect(rankHunks("", META)).toEqual([]);
    expect(rankHunks("   \n  ", META)).toEqual([]);
  });

  it("scores size from added+deleted and orders larger hunks first", () => {
    const diff = fileDiff("src/lib/small.ts", 1, 0) + fileDiff("src/lib/large.ts", 30, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.file).toBe("src/lib/large.ts");
    expect(ranked[1]?.file).toBe("src/lib/small.ts");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(ranked[0]?.added).toBe(30);
  });

  it("counts added and deleted lines per hunk", () => {
    const ranked = rankHunks(fileDiff("src/lib/edit.ts", 2, 3), META);
    expect(ranked[0]?.added).toBe(2);
    expect(ranked[0]?.deleted).toBe(3);
  });
});

describe("rankHunks — risk-path signal (R1)", () => {
  it("ranks a risk-path change above an equal-size non-risk change", () => {
    const diff = fileDiff("src/auth/login.ts", 2, 0) + fileDiff("src/util/format.ts", 2, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked[0]?.file).toBe("src/auth/login.ts");
    expect(ranked[0]?.signals.riskPath).toBe(true);
    expect(ranked[0]?.signals.riskPathLabel).toBe("auth");
    expect(ranked[1]?.signals.riskPath).toBe(false);
    expect(ranked[1]?.signals.riskPathLabel).toBeNull();
  });

  it.each<[string, RiskCategory]>([
    ["src/auth/session.ts", "auth"],
    ["server/payments/charge.ts", "payment"],
    ["lib/security/crypto.ts", "security"],
    ["db/migrations/0001_init.sql", "migration"],
    ["infra/terraform/main.tf", "infra"],
    [".github/workflows/ci.yml", "deploy"],
    ["app/config/settings.ts", "config"],
  ])("labels %s as %s", (path, label) => {
    const ranked = rankHunks(fileDiff(path, 1, 0), META);
    expect(ranked[0]?.signals.riskPathLabel).toBe(label);
  });
});

describe("rankHunks — API-boundary signal (R1)", () => {
  it("flags a hunk that adds an exported symbol", () => {
    const ranked = rankHunks(fileDiff("src/lib/api.ts", 2, 0, true), META);
    expect(ranked[0]?.signals.apiBoundary).toBe(true);
  });

  it("does not flag a hunk with only internal edits", () => {
    const ranked = rankHunks(fileDiff("src/lib/internal.ts", 2, 0, false), META);
    expect(ranked[0]?.signals.apiBoundary).toBe(false);
  });

  it("flags removal of an exported symbol", () => {
    const diff = [
      "diff --git a/src/lib/api.ts b/src/lib/api.ts",
      "--- a/src/lib/api.ts",
      "+++ b/src/lib/api.ts",
      "@@ -1,2 +1,1 @@",
      " const keep = 1;",
      "-export const removed = 2;",
      "",
    ].join("\n");
    expect(rankHunks(diff, META)[0]?.signals.apiBoundary).toBe(true);
  });
});

describe("rankHunks — missing-test-delta signal (R1)", () => {
  it("flags a source file changed without a sibling test", () => {
    const ranked = rankHunks(fileDiff("src/lib/widget.ts", 2, 0), META);
    expect(ranked[0]?.signals.missingTestDelta).toBe(true);
  });

  it("does not flag a source file changed alongside its test", () => {
    const diff = fileDiff("src/lib/widget.ts", 2, 0) + fileDiff("src/lib/widget.test.ts", 2, 0);
    const ranked = rankHunks(diff, META);
    const source = ranked.find((c) => c.file === "src/lib/widget.ts");
    expect(source?.signals.missingTestDelta).toBe(false);
  });

  it("never flags the test file itself", () => {
    const ranked = rankHunks(fileDiff("src/lib/widget.test.ts", 2, 0), META);
    expect(ranked[0]?.signals.missingTestDelta).toBe(false);
  });

  it("never flags a non-code file", () => {
    const ranked = rankHunks(fileDiff("docs/readme.md", 2, 0), META);
    expect(ranked[0]?.signals.missingTestDelta).toBe(false);
  });
});

describe("rankHunks — bucketing by within-PR percentile (R2)", () => {
  it("puts the single hunk of a tiny PR in High", () => {
    const ranked = rankHunks(fileDiff("src/lib/only.ts", 1, 0), META);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.tier).toBe("High");
  });

  it("splits a 10-hunk PR into ~20% High, ~30% Medium, rest Low", () => {
    let diff = "";
    for (let i = 0; i < 10; i++) {
      // Vary size so scores are distinct and ordering is deterministic.
      diff += fileDiff(`src/lib/f${i}.ts`, i + 1, 0);
    }
    const ranked = rankHunks(diff, META);
    expect(ranked).toHaveLength(10);
    expect(ranked.filter((c) => c.tier === "High")).toHaveLength(2);
    expect(ranked.filter((c) => c.tier === "Medium")).toHaveLength(3);
    expect(ranked.filter((c) => c.tier === "Low")).toHaveLength(5);
    // High chunks are the highest-scoring ones.
    const scores = ranked.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("rankHunks — determinism and deep links (R1)", () => {
  it("orders equal-score hunks stably by path", () => {
    const diff = fileDiff("src/b.ts", 2, 0) + fileDiff("src/a.ts", 2, 0);
    const ranked = rankHunks(diff, META);
    // Equal score (same size, both missing tests, no risk path) → path order.
    expect(ranked.map((c) => c.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("builds a Files-changed deep link with an R anchor for additions", () => {
    const ranked = rankHunks(fileDiff("src/lib/add.ts", 2, 0), META);
    expect(ranked[0]?.side).toBe("R");
    expect(ranked[0]?.deepLink).toMatch(/\/octo-org\/demo\/pull\/42\/files#diff-[0-9a-f]{64}R\d+$/);
  });

  it("uses an L anchor for a deletion-only hunk", () => {
    const diff = [
      "diff --git a/src/lib/del.ts b/src/lib/del.ts",
      "--- a/src/lib/del.ts",
      "+++ b/src/lib/del.ts",
      "@@ -1,2 +1,1 @@",
      " const keep = 1;",
      "-const removed = 2;",
      "",
    ].join("\n");
    const ranked = rankHunks(diff, META);
    expect(ranked[0]?.side).toBe("L");
    expect(ranked[0]?.deepLink).toMatch(/#diff-[0-9a-f]{64}L\d+$/);
  });

  it("produces a non-empty one-line reason naming the dominant signals", () => {
    const ranked = rankHunks(fileDiff("src/auth/login.ts", 60, 0, true), META);
    const reason = ranked[0]?.reason ?? "";
    expect(reason).toContain("Large change");
    expect(reason).toContain("auth");
    expect(reason).toContain("exported API");
    expect(reason).not.toContain("\n");
  });
});

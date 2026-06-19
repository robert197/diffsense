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

describe("rankHunks — demotion of machine-written noise (R1)", () => {
  it("demotes a large lockfile to Low while a small source change stays High", () => {
    const diff = fileDiff("pnpm-lock.yaml", 400, 0) + fileDiff("src/auth/login.ts", 3, 0);
    const ranked = rankHunks(diff, META);
    const lock = ranked.find((c) => c.file === "pnpm-lock.yaml");
    const auth = ranked.find((c) => c.file === "src/auth/login.ts");
    expect(lock?.tier).toBe("Low");
    expect(lock?.signals.demoted).toBe(true);
    expect(lock?.signals.demotionReason).toBe("lockfile");
    expect(auth?.tier).toBe("High");
    expect(auth?.signals.demoted).toBe(false);
  });

  it("never places a demoted hunk in High or Medium even when largest", () => {
    const diff =
      fileDiff("dist/bundle.min.js", 500, 0) +
      fileDiff("assets/logo.png", 200, 0) +
      fileDiff("src/lib/widget.ts", 2, 0);
    const ranked = rankHunks(diff, META);
    const flagged = ranked.filter((c) => c.tier === "High" || c.tier === "Medium");
    expect(flagged.every((c) => !c.signals.demoted)).toBe(true);
    expect(ranked.find((c) => c.file === "src/lib/widget.ts")?.tier).toBe("High");
  });

  it("excludes demoted hunks from the percentile base", () => {
    // One real hunk plus three demoted: the real hunk is still High, not Medium.
    const diff =
      fileDiff("src/lib/real.ts", 5, 0) +
      fileDiff("yarn.lock", 80, 0) +
      fileDiff("package-lock.json", 90, 0) +
      fileDiff("go.sum", 70, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked.find((c) => c.file === "src/lib/real.ts")?.tier).toBe("High");
    expect(ranked.filter((c) => c.signals.demoted)).toHaveLength(3);
  });

  it("labels the reason for a demoted hunk", () => {
    const ranked = rankHunks(fileDiff("dist/app.min.js", 10, 0), META);
    expect(ranked[0]?.reason).toBe("Generated file, demoted");
  });

  it("produces an all-Low ranking when every hunk is demoted", () => {
    const diff = fileDiff("pnpm-lock.yaml", 200, 0) + fileDiff("dist/bundle.min.js", 300, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((c) => c.tier === "Low")).toBe(true);
    expect(ranked.filter((c) => c.tier === "High")).toHaveLength(0);
  });
});

describe("rankHunks — graceful fallback on unrecognized languages (R2)", () => {
  it("produces a valid ranking for unknown-language files without throwing", () => {
    const diff = fileDiff("app/main.zig", 20, 0) + fileDiff("lib/thing.elm", 5, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked).toHaveLength(2);
    // Size-driven order, deterministic, every chunk carries a tier.
    expect(ranked[0]?.file).toBe("app/main.zig");
    expect(ranked.every((c) => c.tier === "High" || c.tier === "Medium" || c.tier === "Low")).toBe(
      true,
    );
  });

  it("contributes zero from unmatched signals: score reflects size alone", () => {
    const ranked = rankHunks(fileDiff("app/main.zig", 7, 0), META);
    const chunk = ranked[0];
    expect(chunk?.signals.riskPath).toBe(false);
    expect(chunk?.signals.apiBoundary).toBe(false);
    expect(chunk?.signals.missingTestDelta).toBe(false);
    expect(chunk?.score).toBeCloseTo(Math.log2(1 + 7), 10);
  });

  it("still credits a risk path even when the extension is unknown", () => {
    const diff = fileDiff("src/auth/handler.unknownext", 3, 0) + fileDiff("lib/plain.zig", 3, 0);
    const ranked = rankHunks(diff, META);
    expect(ranked[0]?.file).toBe("src/auth/handler.unknownext");
    expect(ranked[0]?.signals.riskPath).toBe(true);
    expect(ranked[0]?.signals.riskPathLabel).toBe("auth");
  });
});

describe("rankHunks — chunk fingerprint (R3)", () => {
  it("gives every chunk a stable 16-char fingerprint", () => {
    const ranked = rankHunks(fileDiff("src/lib/a.ts", 2, 0), META);
    expect(ranked[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs by file/line and is stable across calls", () => {
    const diff = fileDiff("src/a.ts", 2, 0) + fileDiff("src/b.ts", 2, 0);
    const first = rankHunks(diff, META);
    const second = rankHunks(diff, META);
    const fpsA = first.map((c) => c.fingerprint);
    const fpsB = second.map((c) => c.fingerprint);
    expect(fpsA).toEqual(fpsB);
    expect(new Set(fpsA).size).toBe(fpsA.length);
  });
});

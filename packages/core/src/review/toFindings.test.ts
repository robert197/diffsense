import { describe, expect, it } from "vitest";
import { ReviewFindingSchema } from "../schemas/finding.js";
import type { ReviewResult } from "./reviewPass.js";
import { toFindings } from "./toFindings.js";

function result(file: string, fingerprint: string, tier: "High" | "Medium" | "Low"): ReviewResult {
  return {
    chunk: { file, tier, patch: `@@ ${file} @@` },
    fingerprint,
    cached: false,
    review: {
      explanation: `change in ${file}`,
      claims: [{ claim: "c", evidence: "e" }],
      rating: "high",
      reasons: ["r"],
    },
  };
}

const ctx = { owner: "octo", repo: "demo", prNumber: 7 };

describe("toFindings (#13)", () => {
  it("maps each result to a valid finding, rank following input order", () => {
    const findings = toFindings(
      [result("a.ts", "fp-a", "High"), result("b.ts", "fp-b", "Medium")],
      ctx,
    );

    expect(findings.map((f) => [f.file, f.rank, f.tier])).toEqual([
      ["a.ts", 0, "High"],
      ["b.ts", 1, "Medium"],
    ]);
    for (const f of findings) {
      expect(ReviewFindingSchema.parse(f)).toEqual(f);
    }
  });

  it("attaches blast radius by fingerprint, empty when missing", () => {
    const blastRadius = new Map([["fp-a", ["b.ts:1 call a()"]]]);
    const [a, b] = toFindings([result("a.ts", "fp-a", "High"), result("b.ts", "fp-b", "High")], {
      ...ctx,
      blastRadius,
    });

    expect(a?.blastRadius).toEqual(["b.ts:1 call a()"]);
    expect(b?.blastRadius).toEqual([]);
  });

  it("returns an empty array for no results", () => {
    expect(toFindings([], ctx)).toEqual([]);
  });
});

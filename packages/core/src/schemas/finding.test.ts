import { describe, expect, it } from "vitest";
import { ReviewFindingSchema } from "./finding.js";

const base = {
  owner: "octo",
  repo: "demo",
  prNumber: 7,
  fingerprint: "abc123",
  file: "src/a.ts",
  tier: "High" as const,
  rank: 0,
  explanation: "Adds a y constant.",
  claims: [{ claim: "y is unused", evidence: "src/a.ts:2" }],
  reasons: ["touches exported API"],
  blastRadius: ["src/b.ts:10 call a()"],
};

describe("ReviewFindingSchema (#13)", () => {
  it("parses a valid finding", () => {
    expect(ReviewFindingSchema.parse(base)).toEqual(base);
  });

  it("rejects a tier outside the enum", () => {
    expect(ReviewFindingSchema.safeParse({ ...base, tier: "Critical" }).success).toBe(false);
  });

  it("requires at least one reason", () => {
    expect(ReviewFindingSchema.safeParse({ ...base, reasons: [] }).success).toBe(false);
  });

  it("allows empty claims and empty blast radius", () => {
    const trivial = { ...base, claims: [], blastRadius: [] };
    expect(ReviewFindingSchema.parse(trivial)).toEqual(trivial);
  });

  it("rejects a non-positive prNumber", () => {
    expect(ReviewFindingSchema.safeParse({ ...base, prNumber: 0 }).success).toBe(false);
  });

  it("rejects a negative rank", () => {
    expect(ReviewFindingSchema.safeParse({ ...base, rank: -1 }).success).toBe(false);
  });
});

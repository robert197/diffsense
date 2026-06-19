import { describe, expect, it } from "vitest";
import { PortfolioSchema, RiskPositionSchema } from "./portfolio.js";

const position = {
  title: "2 unverified API-boundary changes",
  detail: "Both change an exported signature without touching call sites.",
  severity: "high" as const,
  chunks: ["src/api.ts", "src/handler.ts"],
};

describe("RiskPositionSchema", () => {
  it("parses a valid, chunk-linked position", () => {
    expect(RiskPositionSchema.parse(position)).toEqual(position);
  });

  it("rejects a position with no chunk link — it would not be auditable", () => {
    expect(() => RiskPositionSchema.parse({ ...position, chunks: [] })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => RiskPositionSchema.parse({ ...position, title: "" })).toThrow();
  });

  it("rejects a non-categorical severity (no opaque numeric score)", () => {
    expect(() => RiskPositionSchema.parse({ ...position, severity: 0.87 })).toThrow();
  });
});

describe("PortfolioSchema", () => {
  it("parses a full portfolio: positions, intent coverage, overview", () => {
    const portfolio = {
      positions: [position],
      intentCoverage: "On scope: matches the stated refactor, plus one undeclared edit.",
      overview: "Look at the two API-boundary changes first; the rest is low risk.",
    };
    expect(PortfolioSchema.parse(portfolio)).toEqual(portfolio);
  });

  it("parses an empty portfolio (nothing survived, on scope)", () => {
    const portfolio = {
      positions: [],
      intentCoverage: "The change stays within its stated intent.",
      overview: "No risks survived verification.",
    };
    expect(PortfolioSchema.parse(portfolio)).toEqual(portfolio);
  });

  it("has no single overall numeric score field", () => {
    const portfolio = {
      positions: [position],
      intentCoverage: "On scope.",
      overview: "Overview.",
    };
    const parsed = PortfolioSchema.parse(portfolio);
    expect(parsed).not.toHaveProperty("score");
    expect(Object.values(parsed).some((v) => typeof v === "number")).toBe(false);
  });

  it("rejects an empty overview", () => {
    expect(() =>
      PortfolioSchema.parse({ positions: [], intentCoverage: "x", overview: "" }),
    ).toThrow();
  });
});

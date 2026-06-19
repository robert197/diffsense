import { describe, expect, it } from "vitest";
import { ChunkReviewSchema } from "./chunkReview.js";

const VALID = {
  explanation: "Adds a null check before dereferencing the session user.",
  claims: [
    { claim: "Throws when session is undefined.", evidence: "src/auth.ts:42" },
    { claim: "No test covers the undefined-session path.", evidence: "no auth.test.ts change" },
  ],
  rating: "high",
  reasons: ["touches auth", "no accompanying test"],
};

describe("ChunkReviewSchema", () => {
  it("accepts a well-formed review", () => {
    expect(ChunkReviewSchema.parse(VALID)).toEqual(VALID);
  });

  it("accepts an empty claims list (trivial change)", () => {
    const trivial = { ...VALID, claims: [] };
    expect(ChunkReviewSchema.parse(trivial).claims).toEqual([]);
  });

  it("rejects an unknown rating", () => {
    expect(() => ChunkReviewSchema.parse({ ...VALID, rating: "critical" })).toThrow();
  });

  it("rejects a claim missing its evidence", () => {
    const bad = { ...VALID, claims: [{ claim: "leaks a token" }] };
    expect(() => ChunkReviewSchema.parse(bad)).toThrow();
  });

  it("requires at least one reason for the rating", () => {
    expect(() => ChunkReviewSchema.parse({ ...VALID, reasons: [] })).toThrow();
  });

  it("requires a non-empty explanation", () => {
    expect(() => ChunkReviewSchema.parse({ ...VALID, explanation: "" })).toThrow();
  });
});

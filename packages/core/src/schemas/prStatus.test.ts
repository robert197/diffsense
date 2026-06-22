import { describe, expect, it } from "vitest";
import { PrLifecycleSchema, PrStatusValueSchema } from "./prStatus.js";

describe("PrStatusValueSchema", () => {
  it("accepts the three lifecycle labels", () => {
    for (const value of ["open", "merged", "closed"]) {
      expect(PrStatusValueSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown label", () => {
    expect(PrStatusValueSchema.safeParse("archived").success).toBe(false);
  });
});

describe("PrLifecycleSchema", () => {
  it("parses a live open PR", () => {
    expect(PrLifecycleSchema.parse({ state: "open", merged: false })).toEqual({
      state: "open",
      merged: false,
    });
  });

  it("parses a merged PR", () => {
    expect(PrLifecycleSchema.parse({ state: "closed", merged: true })).toEqual({
      state: "closed",
      merged: true,
    });
  });

  it("rejects an unknown state", () => {
    expect(PrLifecycleSchema.safeParse({ state: "draft", merged: false }).success).toBe(false);
  });

  it("rejects a missing merged flag", () => {
    expect(PrLifecycleSchema.safeParse({ state: "closed" }).success).toBe(false);
  });
});

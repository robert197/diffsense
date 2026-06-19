import { describe, expect, it } from "vitest";
import { VerificationVerdictSchema } from "./verification.js";

describe("VerificationVerdictSchema", () => {
  it("parses a valid refuted verdict", () => {
    const verdict = { refuted: true, rationale: "`user` is guarded by `if (user)` upstream" };
    expect(VerificationVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it("parses a valid surviving verdict", () => {
    const verdict = { refuted: false, rationale: "the null path is genuinely reachable" };
    expect(VerificationVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it("rejects an empty rationale", () => {
    expect(() => VerificationVerdictSchema.parse({ refuted: true, rationale: "" })).toThrow();
  });

  it("rejects a missing refuted flag", () => {
    expect(() => VerificationVerdictSchema.parse({ rationale: "no flag" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { PostedCommentSchema, PrCommentAnchorSchema, PrCommentInputSchema } from "./prComment.js";

describe("PrCommentAnchorSchema", () => {
  const base = { file: "src/a.ts", line: 12, side: "RIGHT" as const, commitId: "abc123" };

  it("accepts a single-line anchor (no startLine)", () => {
    expect(PrCommentAnchorSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a multi-line anchor with startLine <= line", () => {
    expect(PrCommentAnchorSchema.safeParse({ ...base, startLine: 8 }).success).toBe(true);
  });

  it("rejects startLine greater than line", () => {
    expect(PrCommentAnchorSchema.safeParse({ ...base, startLine: 20 }).success).toBe(false);
  });

  it("rejects a side outside LEFT/RIGHT", () => {
    expect(PrCommentAnchorSchema.safeParse({ ...base, side: "BOTH" }).success).toBe(false);
  });

  it("rejects a non-positive line and an empty commitId", () => {
    expect(PrCommentAnchorSchema.safeParse({ ...base, line: 0 }).success).toBe(false);
    expect(PrCommentAnchorSchema.safeParse({ ...base, commitId: "" }).success).toBe(false);
  });
});

describe("PrCommentInputSchema", () => {
  it("accepts a body with an anchor", () => {
    const parsed = PrCommentInputSchema.safeParse({
      body: "Looks off here.",
      anchor: { file: "a.ts", line: 3, side: "RIGHT", commitId: "sha" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a body with no anchor (general conversation comment)", () => {
    expect(PrCommentInputSchema.safeParse({ body: "General note." }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(PrCommentInputSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("rejects a body past the max length", () => {
    expect(PrCommentInputSchema.safeParse({ body: "x".repeat(65_537) }).success).toBe(false);
  });
});

describe("PostedCommentSchema", () => {
  it("accepts a review and an issue comment result", () => {
    expect(
      PostedCommentSchema.safeParse({
        id: 1,
        htmlUrl: "https://github.com/a/b/pull/1#c",
        kind: "review",
      }).success,
    ).toBe(true);
    expect(
      PostedCommentSchema.safeParse({
        id: 2,
        htmlUrl: "https://github.com/a/b/issues/1#c",
        kind: "issue",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-url htmlUrl", () => {
    expect(
      PostedCommentSchema.safeParse({ id: 1, htmlUrl: "not-a-url", kind: "review" }).success,
    ).toBe(false);
  });

  it("rejects an out-of-enum kind", () => {
    expect(
      PostedCommentSchema.safeParse({ id: 1, htmlUrl: "https://x.dev/c", kind: "inline" }).success,
    ).toBe(false);
  });
});

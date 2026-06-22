import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import { parsePrRef } from "./prRef.js";

describe("parsePrRef (#32 U2)", () => {
  it("parses owner/repo#123", () => {
    expect(parsePrRef("octo-org/demo#123")).toEqual({
      owner: "octo-org",
      repo: "demo",
      prNumber: 123,
    });
  });

  it("parses owner/repo/123", () => {
    expect(parsePrRef("octo-org/demo/123")).toEqual({
      owner: "octo-org",
      repo: "demo",
      prNumber: 123,
    });
  });

  it("parses a full github.com pull URL", () => {
    expect(parsePrRef("https://github.com/o/r/pull/45")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 45,
    });
  });

  it("parses a pull URL with a trailing /files segment", () => {
    expect(parsePrRef("https://github.com/o/r/pull/45/files")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 45,
    });
  });

  it("parses a pull URL with query and hash", () => {
    expect(parsePrRef("https://github.com/o/r/pull/45?diff=split#discussion")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 45,
    });
  });

  it("handles owners/repos with hyphens and dots", () => {
    expect(parsePrRef("my-org/my.repo#7")).toEqual({
      owner: "my-org",
      repo: "my.repo",
      prNumber: 7,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePrRef("  o/r#9  ")).toEqual({ owner: "o", repo: "r", prNumber: 9 });
  });

  it("accepts a www.github.com pull URL", () => {
    expect(parsePrRef("https://www.github.com/o/r/pull/8")).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 8,
    });
  });

  it.each([
    "owner/repo",
    "owner#1",
    "repo#1",
    "owner/repo#abc",
    "owner/repo#0",
    "owner//1",
    "",
    "https://github.com/o/r/issues/3",
    // Look-alike / non-github hosts must be rejected, not silently reviewed.
    "https://notgithub.com/o/r/pull/1",
    "https://gist.github.com/o/r/pull/1",
    "https://github.com.evil.com/o/r/pull/1",
    // Out-of-safe-range PR number (21-digit paste) is not a real PR.
    "owner/repo#999999999999999999999",
  ])("throws UsageError for invalid input %j", (bad) => {
    expect(() => parsePrRef(bad)).toThrow(UsageError);
  });
});

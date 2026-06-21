import { describe, expect, it } from "vitest";
import { relativeTime } from "./ui";

describe("relativeTime", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  it("formats hours and days ago", () => {
    expect(relativeTime("2026-06-21T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-06-19T12:00:00Z", now)).toBe("2d ago");
  });

  it("returns 'just now' for sub-minute deltas", () => {
    expect(relativeTime("2026-06-21T11:59:30Z", now)).toBe("just now");
  });

  it("falls back to the raw value for an unparseable date", () => {
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});

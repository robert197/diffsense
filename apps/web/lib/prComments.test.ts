import { describe, expect, it } from "vitest";
import { type PostedCardComment, groupPostedComments } from "./prComments";

function comment(over: Partial<PostedCardComment> = {}): PostedCardComment {
  return {
    fingerprint: "fp-a",
    body: "a note",
    htmlUrl: "https://github.com/acme/web/pull/7#c1",
    kind: "review",
    createdAt: new Date("2026-06-21T10:00:00Z"),
    ...over,
  };
}

describe("groupPostedComments", () => {
  it("groups comments by fingerprint", () => {
    const grouped = groupPostedComments([
      comment({ fingerprint: "fp-a", body: "first" }),
      comment({ fingerprint: "fp-b", body: "second" }),
      comment({ fingerprint: "fp-a", body: "third" }),
    ]);
    expect(grouped.get("fp-a")?.map((c) => c.body)).toEqual(["first", "third"]);
    expect(grouped.get("fp-b")?.map((c) => c.body)).toEqual(["second"]);
    expect(grouped.get("fp-c")).toBeUndefined();
  });

  it("preserves input order within a fingerprint", () => {
    const grouped = groupPostedComments([
      comment({ body: "newer", createdAt: new Date("2026-06-21T12:00:00Z") }),
      comment({ body: "older", createdAt: new Date("2026-06-21T09:00:00Z") }),
    ]);
    expect(grouped.get("fp-a")?.map((c) => c.body)).toEqual(["newer", "older"]);
  });

  it("returns an empty map for no comments", () => {
    expect(groupPostedComments([]).size).toBe(0);
  });
});

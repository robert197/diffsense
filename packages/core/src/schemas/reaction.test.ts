import { describe, expect, it } from "vitest";
import { ChunkReactionSchema } from "./reaction.js";

const valid = {
  owner: "robert197",
  repo: "diffsense",
  prNumber: 3,
  fingerprint: "abc123def4567890",
  tier: "High" as const,
  sentiment: "up" as const,
};

describe("ChunkReactionSchema", () => {
  it("parses a valid reaction", () => {
    expect(ChunkReactionSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown sentiment", () => {
    expect(ChunkReactionSchema.safeParse({ ...valid, sentiment: "love" }).success).toBe(false);
  });

  it("rejects an unknown tier", () => {
    expect(ChunkReactionSchema.safeParse({ ...valid, tier: "Critical" }).success).toBe(false);
  });

  it("rejects a non-positive prNumber", () => {
    expect(ChunkReactionSchema.safeParse({ ...valid, prNumber: 0 }).success).toBe(false);
    expect(ChunkReactionSchema.safeParse({ ...valid, prNumber: -1 }).success).toBe(false);
  });

  it("rejects an empty fingerprint", () => {
    expect(ChunkReactionSchema.safeParse({ ...valid, fingerprint: "" }).success).toBe(false);
  });
});

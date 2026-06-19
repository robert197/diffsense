import { describe, expect, it } from "vitest";
import { cardViewLink } from "./cardViewLink.js";

describe("cardViewLink (#13)", () => {
  it("builds the /pr/{owner}/{repo}/{number} route", () => {
    expect(
      cardViewLink("https://diffsense.example", { owner: "octo", repo: "demo", prNumber: 12 }),
    ).toBe("https://diffsense.example/pr/octo/demo/12");
  });

  it("trims a trailing slash on the base URL", () => {
    expect(cardViewLink("https://diffsense.example/", { owner: "o", repo: "r", prNumber: 1 })).toBe(
      "https://diffsense.example/pr/o/r/1",
    );
  });

  it("url-encodes path segments", () => {
    expect(cardViewLink("https://x.test", { owner: "a/b", repo: "r r", prNumber: 3 })).toBe(
      "https://x.test/pr/a%2Fb/r%20r/3",
    );
  });
});

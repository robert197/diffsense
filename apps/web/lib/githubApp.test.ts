import { describe, expect, it } from "vitest";
import { appSlug, buildInstallUrl } from "./githubApp";

describe("appSlug", () => {
  it("returns the configured slug, trimmed", () => {
    expect(appSlug({ GITHUB_APP_SLUG: " diffsense " } as NodeJS.ProcessEnv)).toBe("diffsense");
  });

  it("throws a clear error when the slug is unset", () => {
    expect(() => appSlug({} as NodeJS.ProcessEnv)).toThrow(/GITHUB_APP_SLUG/);
  });

  it("throws when the slug is blank", () => {
    expect(() => appSlug({ GITHUB_APP_SLUG: "  " } as NodeJS.ProcessEnv)).toThrow(
      /GITHUB_APP_SLUG/,
    );
  });
});

describe("buildInstallUrl", () => {
  it("builds the canonical install URL for the slug", () => {
    expect(buildInstallUrl("diffsense-local")).toBe(
      "https://github.com/apps/diffsense-local/installations/new",
    );
  });
});

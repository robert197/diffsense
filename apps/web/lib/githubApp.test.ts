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
  it("builds the generic install URL with no account", () => {
    expect(buildInstallUrl("diffsense")).toBe(
      "https://github.com/apps/diffsense/installations/new",
    );
  });

  it("builds a per-account install URL targeting the account id", () => {
    expect(buildInstallUrl("diffsense", { accountId: 42 })).toBe(
      "https://github.com/apps/diffsense/installations/new/permissions?target_id=42",
    );
  });
});

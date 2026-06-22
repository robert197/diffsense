import { describe, expect, it } from "vitest";
import { loadCliConfig } from "./config.js";
import { CliConfigError } from "./errors.js";

const baseEnv: NodeJS.ProcessEnv = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "-----BEGIN KEY-----",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
};

describe("loadCliConfig (#32 U3)", () => {
  it("parses when all required env is present; optional fields default to undefined", () => {
    const cfg = loadCliConfig(baseEnv);
    expect(cfg.githubAppId).toBe("123");
    expect(cfg.databaseUrl).toBe("postgres://u:p@localhost:5432/db");
    expect(cfg.installationId).toBeUndefined();
    expect(cfg.publicBaseUrl).toBeUndefined();
    expect(cfg.webBaseUrl).toBeUndefined();
  });

  it("reads optional public URLs and installation id from env", () => {
    const cfg = loadCliConfig({
      ...baseEnv,
      GITHUB_INSTALLATION_ID: "99",
      PUBLIC_BASE_URL: "https://ingress.example",
      WEB_BASE_URL: "https://cards.example",
    });
    expect(cfg.installationId).toBe(99);
    expect(cfg.publicBaseUrl).toBe("https://ingress.example");
    expect(cfg.webBaseUrl).toBe("https://cards.example");
  });

  it("lets a --installation-id override beat the env value", () => {
    const cfg = loadCliConfig({ ...baseEnv, GITHUB_INSTALLATION_ID: "99" }, { installationId: 42 });
    expect(cfg.installationId).toBe(42);
  });

  it("throws CliConfigError naming a missing required key (GITHUB_APP_ID)", () => {
    const { GITHUB_APP_ID, ...rest } = baseEnv;
    expect(() => loadCliConfig(rest)).toThrow(CliConfigError);
    try {
      loadCliConfig(rest);
    } catch (err) {
      expect((err as Error).message).toContain("githubAppId");
    }
  });

  it("throws CliConfigError when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = baseEnv;
    expect(() => loadCliConfig(rest)).toThrow(CliConfigError);
  });

  it("throws CliConfigError when DATABASE_URL is not a URL", () => {
    expect(() => loadCliConfig({ ...baseEnv, DATABASE_URL: "not-a-url" })).toThrow(CliConfigError);
  });
});

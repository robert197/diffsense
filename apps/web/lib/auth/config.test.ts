import { describe, expect, it } from "vitest";
import { loadAuthConfig, redirectUri } from "./config";

const valid: NodeJS.ProcessEnv = {
  GITHUB_OAUTH_CLIENT_ID: "Iv1.client",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  SESSION_SECRET: "session-secret",
  WEB_BASE_URL: "https://cards.diffsense.example.com",
};

describe("loadAuthConfig", () => {
  it("parses a complete env", () => {
    const config = loadAuthConfig(valid);
    expect(config.clientId).toBe("Iv1.client");
    expect(config.clientSecret).toBe("secret");
    expect(config.sessionSecret).toBe("session-secret");
    expect(config.webBaseUrl).toBe("https://cards.diffsense.example.com");
  });

  it("strips a trailing slash from WEB_BASE_URL", () => {
    const config = loadAuthConfig({ ...valid, WEB_BASE_URL: "https://x.example.com/" });
    expect(config.webBaseUrl).toBe("https://x.example.com");
  });

  it("sets secureCookies only in production", () => {
    expect(loadAuthConfig({ ...valid, NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(loadAuthConfig({ ...valid, NODE_ENV: "development" }).secureCookies).toBe(false);
  });

  it.each([
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "SESSION_SECRET",
    "WEB_BASE_URL",
  ])("throws naming the missing var %s", (missing) => {
    const env = { ...valid };
    delete env[missing as keyof typeof env];
    expect(() => loadAuthConfig(env)).toThrow(missing);
  });

  it("builds the redirect URI from the base URL", () => {
    expect(redirectUri(loadAuthConfig(valid))).toBe(
      "https://cards.diffsense.example.com/api/auth/callback",
    );
  });
});

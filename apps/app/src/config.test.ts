import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://localhost:5432/diffsense",
  REDIS_URL: "redis://localhost:6379",
} as NodeJS.ProcessEnv;

describe("loadConfig pr-status poll settings (#31)", () => {
  it("applies the default poll interval and batch when unset", () => {
    const config = loadConfig(baseEnv);
    expect(config.prStatusPollIntervalMs).toBe(300_000);
    expect(config.prStatusPollBatch).toBe(50);
  });

  it("parses overrides from env", () => {
    const config = loadConfig({
      ...baseEnv,
      PR_STATUS_POLL_INTERVAL_MS: "60000",
      PR_STATUS_POLL_BATCH: "10",
    });
    expect(config.prStatusPollIntervalMs).toBe(60_000);
    expect(config.prStatusPollBatch).toBe(10);
  });
});

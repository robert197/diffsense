import { z } from "zod";
import { CliConfigError } from "./errors.js";

/**
 * Configuration the `diffsense review` CLI needs (issue #32, KTD3). Deliberately
 * a *narrow* subset of the service `Config` (apps/app/src/config.ts): the CLI runs
 * the pipeline in-process and bypasses the queue, so it needs neither `REDIS_URL`
 * nor `GITHUB_WEBHOOK_SECRET`. Requiring the full service config would force an
 * operator to set env the CLI never reads. Auth + provider config still come from
 * env (or flags), honoring the provider-agnostic + self-host rules.
 */
const CliConfigSchema = z.object({
  githubAppId: z.string().min(1, "GITHUB_APP_ID is required"),
  githubPrivateKey: z.string().min(1, "GITHUB_PRIVATE_KEY is required"),
  databaseUrl: z.string().url("DATABASE_URL must be a valid URL"),
  // Optional: the installation hosting the repo. When omitted, the CLI resolves it
  // from the repo via the GitHub App. A `--installation-id` flag overrides env.
  installationId: z.coerce.number().int().positive().optional(),
  // Optional public URLs, mirroring the service config — they only enrich the
  // ranked comment (reaction links / card-view link); the review runs without them.
  publicBaseUrl: z.string().url("PUBLIC_BASE_URL must be a valid URL").optional(),
  webBaseUrl: z.string().url("WEB_BASE_URL must be a valid URL").optional(),
});

export type CliConfig = z.infer<typeof CliConfigSchema>;

/** Flag-derived overrides that take precedence over env (e.g. `--installation-id`). */
export interface CliConfigOverrides {
  installationId?: number;
}

/**
 * Load + validate the CLI configuration from env, applying flag overrides. Throws
 * a `CliConfigError` (→ exit code 3) listing every missing/invalid key, so a
 * misconfigured run fails fast with an actionable message rather than a cryptic
 * downstream auth error.
 */
export function loadCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliConfigOverrides = {},
): CliConfig {
  const result = CliConfigSchema.safeParse({
    githubAppId: env.GITHUB_APP_ID,
    githubPrivateKey: env.GITHUB_PRIVATE_KEY,
    databaseUrl: env.DATABASE_URL,
    // Flag beats env for the installation id.
    installationId: overrides.installationId ?? env.GITHUB_INSTALLATION_ID,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    webBaseUrl: env.WEB_BASE_URL,
  });

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new CliConfigError(`Invalid CLI configuration:\n${issues.join("\n")}`);
  }

  return result.data;
}

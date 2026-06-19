import { z } from "zod";

/**
 * Environment configuration, validated at startup (fail fast).
 *
 * `DATABASE_URL` / `REDIS_URL` default to the docker-compose services but
 * accept any external host (docs/STACK.md). GitHub App secrets are required
 * for the live serve/worker roles; tests inject values directly and do not
 * call `loadConfig()`.
 */
const ConfigSchema = z.object({
  githubAppId: z.string().min(1, "GITHUB_APP_ID is required"),
  githubPrivateKey: z.string().min(1, "GITHUB_PRIVATE_KEY is required"),
  githubWebhookSecret: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  databaseUrl: z.string().url("DATABASE_URL must be a valid URL"),
  redisUrl: z.string().url("REDIS_URL must be a valid URL"),
  port: z.coerce.number().int().positive().default(3000),
  // Public URL of the ingress, used to build the 👍/👎 reaction links in the
  // comment. Optional: when unset, the comment renders without the affordance.
  publicBaseUrl: z.string().url("PUBLIC_BASE_URL must be a valid URL").optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse({
    githubAppId: env.GITHUB_APP_ID,
    githubPrivateKey: env.GITHUB_PRIVATE_KEY,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }

  return result.data;
}

/** Minimal config the DB layer needs — usable standalone in migrations/tests. */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  return url;
}

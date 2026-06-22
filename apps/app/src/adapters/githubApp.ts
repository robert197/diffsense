import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { App, Octokit } from "octokit";
import type { Config } from "../config.js";

/**
 * The GitHub App, with the throttling + retry plugins baked into the Octokit it
 * mints for every installation (issue #31, R5). Background merge-status sync polls
 * GitHub on a schedule, so all App-auth traffic must respect GitHub's primary and
 * secondary rate limits rather than hammering through them.
 *
 * `@octokit/plugin-throttling` paces requests against the live `X-RateLimit` budget
 * and the secondary-limit signal; `@octokit/plugin-retry` retries transient 5xx.
 * The `onRateLimit`/`onSecondaryRateLimit` callbacks allow a *bounded* number of
 * retries (then give up, logged) so a throttled poll backs off instead of stalling
 * the worker indefinitely. Baking the config into `Octokit.defaults` means every
 * installation client `getInstallationOctokit` returns inherits it.
 */
const MAX_THROTTLE_RETRIES = 3;

const ThrottledOctokit = Octokit.plugin(throttling, retry).defaults({
  throttle: {
    onRateLimit: (
      retryAfter: number,
      options: { method?: string; url?: string },
      _o: unknown,
      retryCount: number,
    ) => {
      console.warn(
        `[github] rate limit on ${options.method} ${options.url}; retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
      );
      return retryCount < MAX_THROTTLE_RETRIES;
    },
    onSecondaryRateLimit: (
      retryAfter: number,
      options: { method?: string; url?: string },
      _o: unknown,
      retryCount: number,
    ) => {
      console.warn(
        `[github] secondary rate limit on ${options.method} ${options.url}; retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
      );
      return retryCount < MAX_THROTTLE_RETRIES;
    },
  },
});

/** Build the rate-limit-aware GitHub App from validated config. */
export function createGitHubApp(config: Pick<Config, "githubAppId" | "githubPrivateKey">): App {
  return new App({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    Octokit: ThrottledOctokit,
  });
}

import { randomUUID } from "node:crypto";
import { createDrizzleDeckStore } from "../adapters/deckStore.js";
import { createGitHubApp } from "../adapters/githubApp.js";
import { createDb } from "../db/client.js";
import { buildReviewSupport, runReviewForRef } from "../worker/reviewRunner.js";
import { loadCliConfig } from "./config.js";
import { type GitHubAppLike, type ReviewCommandDeps, runReviewCommand } from "./review.js";

/**
 * `diffsense` CLI entry — the agent-native surface (issue #32). It runs the same
 * on-demand pipeline the web `/decks` trigger runs, in-process, by binding the
 * real adapters into the injectable `runReviewCommand` and reusing the shared
 * `runReviewForRef` (the exact path the worker takes). Only one subcommand today:
 *
 *   diffsense review <owner/repo#123> [--installation-id <n>]
 *
 * Everything testable lives in `review.ts`/`output.ts`/`prRef.ts`/`config.ts`;
 * this file is thin glue: argv dispatch, real-adapter wiring, and `process.exit`.
 */

const USAGE = "Usage: diffsense review <owner/repo#123> [--installation-id <n>]";

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand !== "review") {
    process.stderr.write(
      `${subcommand ? `Unknown command "${subcommand}".` : "Missing command."} ${USAGE}\n`,
    );
    return 2;
  }

  const deps: ReviewCommandDeps = {
    env: process.env,
    loadConfig: loadCliConfig,
    // The App's installation Octokit satisfies the structural GitHubAppLike shape.
    createApp: (cfg) =>
      createGitHubApp({
        githubAppId: cfg.githubAppId,
        githubPrivateKey: cfg.githubPrivateKey,
      }) as unknown as GitHubAppLike,
    openDb: (databaseUrl) => {
      const { db, client } = createDb(databaseUrl);
      return { db, close: () => client.end() };
    },
    createDeckStore: createDrizzleDeckStore,
    buildReviewSupport,
    runReviewForRef,
    newDeliveryId: () => randomUUID(),
  };

  return runReviewCommand(rest, deps, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}

/**
 * Flush stdout before forcing exit. `process.exit` can truncate buffered stdout
 * when it is a pipe under backpressure (a slow `jq`/agent reader on a large
 * deck) — the single-JSON-object contract must survive that, so wait for the
 * write queue to drain first.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("", () => resolve());
  });
}

main()
  .then(async (code) => {
    await flushStdout();
    process.exit(code);
  })
  .catch(async (err) => {
    // Last-resort guard: runReviewCommand catches its own errors, so reaching here
    // means a wiring/programming fault. Report it and exit non-zero.
    process.stderr.write(`diffsense: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    await flushStdout();
    process.exit(1);
  });

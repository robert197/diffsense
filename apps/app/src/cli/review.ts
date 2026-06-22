import type { DeckStore } from "@diffsense/core";
import type { GitHubClient } from "../adapters/github.js";
import type { Database } from "../db/client.js";
import type { PrRef } from "../types.js";
import type { ReviewRunnerDeps, ReviewSupport, RunReviewResult } from "../worker/reviewRunner.js";
import type { CliConfig, CliConfigOverrides } from "./config.js";
import { UsageError } from "./errors.js";
import { buildReviewOutput, exitCodeForError } from "./output.js";
import { type ParsedPrRef, parsePrRef } from "./prRef.js";

/** Where the command writes — injected so tests capture output without a real tty. */
export interface ReviewIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Minimal GitHub App surface the command needs (resolve installation + mint client). */
export interface GitHubAppLike {
  octokit: {
    rest: {
      apps: {
        getRepoInstallation: (p: { owner: string; repo: string }) => Promise<{
          data: { id: number };
        }>;
      };
    };
  };
  getInstallationOctokit: (installationId: number) => Promise<unknown>;
}

/** An open DB handle plus its teardown. */
export interface DbHandleLike {
  db: Database;
  close: () => Promise<void>;
}

/**
 * The outside-world collaborators, injected so `runReviewCommand` is unit-testable
 * with fakes (no Postgres, no GitHub). `main.ts` binds the real adapters.
 */
export interface ReviewCommandDeps {
  env: NodeJS.ProcessEnv;
  loadConfig: (env: NodeJS.ProcessEnv, overrides: CliConfigOverrides) => CliConfig;
  createApp: (cfg: CliConfig) => GitHubAppLike;
  openDb: (databaseUrl: string) => DbHandleLike;
  createDeckStore: (db: Database) => DeckStore;
  buildReviewSupport: (db: Database) => ReviewSupport | null;
  runReviewForRef: (
    octokit: GitHubClient,
    ref: PrRef,
    deps: ReviewRunnerDeps,
  ) => Promise<RunReviewResult>;
  newDeliveryId: () => string;
}

interface ReviewArgs {
  prRef: string;
  installationId?: number;
}

/**
 * Parse the tokens after `review`. Accepts one positional `<pr-ref>`, plus the
 * optional `--installation-id <n>` (or `=n`) override and a tolerated `--json`
 * flag (JSON is always the output). Unknown flags or a missing ref throw a
 * `UsageError` (→ exit code 2).
 */
export function parseReviewArgs(argv: string[]): ReviewArgs {
  let prRef: string | undefined;
  let installationId: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      continue;
    }
    if (arg === "--installation-id" || arg.startsWith("--installation-id=")) {
      let raw: string | undefined;
      if (arg.includes("=")) {
        raw = arg.slice(arg.indexOf("=") + 1);
      } else {
        raw = argv[i + 1];
        // A trailing flag (or one followed by another option) has no value — say
        // so explicitly rather than coercing `undefined`/a flag to NaN.
        if (raw === undefined || raw.startsWith("-")) {
          throw new UsageError("--installation-id requires a value, e.g. --installation-id 42");
        }
        i++;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--installation-id expects a positive integer, got "${raw}"`);
      }
      installationId = n;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new UsageError(`Unknown flag "${arg}".`);
    }
    if (prRef === undefined) {
      prRef = arg;
      continue;
    }
    throw new UsageError(`Unexpected extra argument "${arg}".`);
  }

  if (!prRef) {
    throw new UsageError(
      "Missing <pr-ref>. Usage: diffsense review <owner/repo#123> [--installation-id <n>]",
    );
  }
  return { prRef, installationId };
}

/**
 * Run a full diffsense review for one PR and emit the ordered deck + findings as
 * a single JSON object on stdout (issue #32). Reuses the shared `runReviewForRef`
 * — the same pipeline the worker runs — and the same Drizzle stores, then reads
 * the persisted deck + findings back. Returns the process exit code; all
 * diagnostics go to stderr so stdout carries only the JSON.
 */
export async function runReviewCommand(
  argv: string[],
  deps: ReviewCommandDeps,
  io: ReviewIo,
): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const args = parseReviewArgs(argv);
    const pr: ParsedPrRef = parsePrRef(args.prRef);
    const cfg = deps.loadConfig(deps.env, { installationId: args.installationId });

    const app = deps.createApp(cfg);
    const installationId = cfg.installationId ?? (await resolveInstallationId(app, pr));
    const octokit = (await app.getInstallationOctokit(installationId)) as GitHubClient;

    const handle = deps.openDb(cfg.databaseUrl);
    close = handle.close;
    const deckStore = deps.createDeckStore(handle.db);
    const reviewSupport = deps.buildReviewSupport(handle.db);

    const ref: PrRef = {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
      installationId,
      action: "synchronize",
      deliveryId: `cli-${deps.newDeliveryId()}`,
    };

    // `findings` come straight back from the run (the exact set this pass
    // produced), so they always agree with the deck and the `llm` flag. The deck
    // is read back from the store because it is persisted, not returned; it is
    // head-keyed, so it is read only when the head resolved.
    const { headSha, upsert, findings } = await deps.runReviewForRef(octokit, ref, {
      deckStore,
      reviewSupport,
      reactionBaseUrl: cfg.publicBaseUrl,
      cardViewBaseUrl: cfg.webBaseUrl,
    });

    const deck = headSha
      ? await deckStore.get({ owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber, headSha })
      : null;

    const output = buildReviewOutput({
      pr,
      headSha,
      upsert,
      deck,
      findings,
      llm: reviewSupport !== null,
    });
    io.stdout(JSON.stringify(output));
    return 0;
  } catch (err) {
    io.stderr(`diffsense review: ${errorMessage(err)}`);
    return exitCodeForError(err);
  } finally {
    if (close) {
      // Don't let a teardown failure mask the primary outcome, but don't hide it
      // either — a failed pool drain is what keeps a CLI process from exiting.
      await close().catch((err) => io.stderr(`diffsense review: closing db: ${errorMessage(err)}`));
    }
  }
}

/** Resolve the installation hosting the repo via the GitHub App. */
async function resolveInstallationId(app: GitHubAppLike, pr: ParsedPrRef): Promise<number> {
  const { data } = await app.octokit.rest.apps.getRepoInstallation({
    owner: pr.owner,
    repo: pr.repo,
  });
  return data.id;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

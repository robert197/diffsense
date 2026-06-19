import {
  type ReviewFindingsContext,
  createReviewTools,
  reviewAndPersistFindings,
} from "@diffsense/core";
import { createReviewProvider } from "@diffsense/llm";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { App } from "octokit";
import { createAstGrepCodeSearch } from "../adapters/codeSearch.js";
import { createDrizzleConventionStore } from "../adapters/conventionStore.js";
import { createDrizzleFindingStore } from "../adapters/findingStore.js";
import { createDrizzleFingerprintCache } from "../adapters/fingerprintCache.js";
import type { GitHubClient } from "../adapters/github.js";
import { type RepoReaderClient, createGitHubRepoReader } from "../adapters/repoReader.js";
import type { Config } from "../config.js";
import { createDb } from "../db/client.js";
import { type PrRef, REVIEW_QUEUE_NAME } from "../types.js";
import { type ReviewFindingsRunner, handlePullRequestEvent } from "./handlePullRequestEvent.js";

/** Source files worth feeding ast-grep, and the per-PR fetch cap. */
const SOURCE_EXT = /\.(c|m)?[jt]sx?$/i;
const MAX_SOURCE_FILES = 50;

/**
 * BullMQ consumer — the composition root. Deserializes a `PrRef`, builds an
 * installation-scoped Octokit (KTD3/KTD4), and calls the seam. The deterministic
 * ranked comment always ships. When an LLM is configured, the worker also runs
 * the agentic review pass and persists per-chunk findings for the hosted card
 * view (#13); with no LLM key it stays exactly as before — rank + comment only.
 */
export function startWorker(config: Config): Worker<PrRef> {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("worker redis error:", err));
  const app = new App({ appId: config.githubAppId, privateKey: config.githubPrivateKey });
  const review = buildReviewSupport(config);

  const worker = new Worker<PrRef>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      const ref = job.data;
      const octokit = (await app.getInstallationOctokit(
        ref.installationId,
      )) as unknown as GitHubClient;
      // PrRef is a superset of PullRequestEvent — pass it directly.
      await handlePullRequestEvent(ref, octokit, {
        reactionBaseUrl: config.publicBaseUrl,
        cardViewBaseUrl: config.webBaseUrl,
        reviewFindings: review?.makeRunner(octokit, ref),
      });
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`review job ${job?.id} failed:`, err);
  });
  // BullMQ Worker is an EventEmitter — an unhandled "error" event crashes the
  // process on transient Redis failures. ioredis auto-reconnects; just log.
  worker.on("error", (err) => {
    console.error("worker error:", err);
  });

  return worker;
}

interface ReviewSupport {
  makeRunner(octokit: GitHubClient, ref: PrRef): ReviewFindingsRunner;
}

/**
 * Wire the agentic review producer, or `null` when no LLM provider key is set —
 * the no-LLM deployment keeps the original rank-and-comment behavior untouched.
 * The store-backed ports are built once; the repo-scoped ports (reader, search,
 * tools) are built per job since they depend on the PR's head and changed files.
 */
function buildReviewSupport(config: Config): ReviewSupport | null {
  if (!hasLlmKey(process.env)) {
    return null;
  }
  const llm = createReviewProvider();
  const { db } = createDb(config.databaseUrl);
  const cache = createDrizzleFingerprintCache(db);
  const findingStore = createDrizzleFindingStore(db);
  const conventionStore = createDrizzleConventionStore(db);

  return {
    makeRunner(octokit, ref): ReviewFindingsRunner {
      const { owner, repo } = ref;
      return async (ctx: ReviewFindingsContext) => {
        const headSha = await headShaFor(octokit, ref);
        const repoReader = createGitHubRepoReader(octokit as unknown as RepoReaderClient, {
          owner,
          repo,
          prNumber: ref.prNumber,
          ref: headSha,
        });
        const files = await collectSources(ctx.diff, repoReader);
        const codeSearch = createAstGrepCodeSearch({ files });
        const tools = createReviewTools({
          repoReader,
          codeSearch,
          conventionStore,
          repo: { owner, repo },
        });
        return reviewAndPersistFindings(ctx, { llm, cache, findingStore, codeSearch, tools });
      };
    },
  };
}

/** True when the configured provider's API key is present in env. */
function hasLlmKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/** Resolve the PR head commit so file reads + search hit the reviewed code. */
async function headShaFor(octokit: GitHubClient, ref: PrRef): Promise<string | undefined> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.prNumber,
  });
  const head = (data as { head?: { sha?: string } })?.head;
  return head?.sha;
}

/** Fetch the changed JS/TS file sources from the PR head for blast-radius search. */
async function collectSources(
  diff: string,
  repoReader: ReturnType<typeof createGitHubRepoReader>,
): Promise<{ path: string; source: string }[]> {
  const paths = changedSourcePaths(diff).slice(0, MAX_SOURCE_FILES);
  const files: { path: string; source: string }[] = [];
  for (const path of paths) {
    const source = await repoReader.readFile(path);
    if (source !== null) {
      files.push({ path, source });
    }
  }
  return files;
}

/** New-side paths of changed source files, parsed from the unified diff header. */
function changedSourcePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = match[1]?.trim();
    if (path && path !== "/dev/null" && SOURCE_EXT.test(path)) {
      paths.add(path);
    }
  }
  return [...paths];
}

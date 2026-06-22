import {
  type DeckStore,
  type ReviewFinding,
  type ReviewFindingsContext,
  createReviewTools,
  reviewAndPersistFindings,
} from "@diffsense/core";
import { createReviewProvider } from "@diffsense/llm";
import { createAstGrepCodeSearch } from "../adapters/codeSearch.js";
import { createDrizzleConventionStore } from "../adapters/conventionStore.js";
import { createDrizzleFindingStore } from "../adapters/findingStore.js";
import { createDrizzleFingerprintCache } from "../adapters/fingerprintCache.js";
import type { GitHubClient, UpsertResult } from "../adapters/github.js";
import { type RepoReaderClient, createGitHubRepoReader } from "../adapters/repoReader.js";
import type { Database } from "../db/client.js";
import type { PrRef } from "../types.js";
import {
  type DeckPersister,
  type ReviewFindingsRunner,
  handlePullRequestEvent,
} from "./handlePullRequestEvent.js";
import { processPrIntoDeck } from "./processPrIntoDeck.js";

/** Source files worth feeding ast-grep, and the per-PR fetch cap. */
const SOURCE_EXT = /\.(c|m)?[jt]sx?$/i;
const MAX_SOURCE_FILES = 50;

/**
 * The reusable per-PR review orchestration, extracted from the worker so the
 * worker (`startWorker`) and the agent-facing CLI (`diffsense review`, issue #32)
 * run the *identical* pipeline — no duplicate review logic. It resolves the head
 * SHA, then calls the deterministic `handlePullRequestEvent` seam wired with the
 * agentic review pass (when an LLM is configured) and the deck builder. The seam
 * itself is unchanged; this only lifts the wiring that used to live inside the
 * worker's job closure.
 */

/** Per-run dependencies the runner needs, injected by each caller (worker / CLI). */
export interface ReviewRunnerDeps {
  /** Wired on every run — the deck is deterministic, so it ships with or without an LLM. */
  deckStore: DeckStore;
  /** The agentic review producer, or `null` when no LLM provider key is configured. */
  reviewSupport: ReviewSupport | null;
  /** Public ingress URL; enables the 👍/👎 reaction links in the ranked comment. */
  reactionBaseUrl?: string;
  /** Public base URL of the hosted card view; adds the "view cards" link (#13). */
  cardViewBaseUrl?: string;
}

/** What `runReviewForRef` hands back: the resolved head SHA and the comment upsert. */
export interface RunReviewResult {
  /** PR head commit the review + deck are keyed to, or `undefined` if it could not resolve. */
  headSha: string | undefined;
  /** Result of the idempotent ranked-comment delivery. */
  upsert: UpsertResult;
  /**
   * The findings *this* run produced — empty when no LLM is configured or when
   * the agentic pass threw (the seam swallows that to protect the ranked
   * comment). Returned directly rather than re-read from the store: `FindingStore`
   * is PR-scoped (not head-scoped) and only rewritten when the pass succeeds, so
   * a store read-back would surface a *prior* run's findings on a no-LLM or
   * failed re-run. This keeps the emitted findings consistent with the deck and
   * with the `llm` flag.
   */
  findings: readonly ReviewFinding[];
}

/**
 * Run the full review pipeline for one PR reference using an already-built
 * Octokit. Resolves the head SHA best-effort (a failure degrades to `undefined`
 * — the review reads the default branch and the deck step skips with a log,
 * never sinking the guaranteed ranked comment), then calls the seam with the
 * review-findings runner and deck persister wired from `deps`.
 */
export async function runReviewForRef(
  octokit: GitHubClient,
  ref: PrRef,
  deps: ReviewRunnerDeps,
): Promise<RunReviewResult> {
  const headSha = await resolveHeadSha(octokit, ref);

  // Capture exactly the findings this run produces. The seam hands them to the
  // deck persister but only returns the comment upsert, so we wrap the runner to
  // record its output. If the runner throws, the seam catches it and `findings`
  // stays empty — the contract the CLI relies on.
  let findings: readonly ReviewFinding[] = [];
  const baseRunner = deps.reviewSupport?.makeRunner(octokit, ref, headSha);
  const reviewFindings: ReviewFindingsRunner | undefined = baseRunner
    ? async (ctx) => {
        const produced = await baseRunner(ctx);
        findings = produced;
        return produced;
      }
    : undefined;

  // PrRef is a superset of PullRequestEvent — pass it directly.
  const upsert = await handlePullRequestEvent(ref, octokit, {
    reactionBaseUrl: deps.reactionBaseUrl,
    cardViewBaseUrl: deps.cardViewBaseUrl,
    reviewFindings,
    persistDeck: makeDeckPersister(deps.deckStore, ref, headSha),
  });
  return { headSha, upsert, findings };
}

export interface ReviewSupport {
  makeRunner(octokit: GitHubClient, ref: PrRef, headSha: string | undefined): ReviewFindingsRunner;
}

/**
 * Bind the deck-building seam (#26) to a job. Always wired — the deck is a
 * deterministic fold of the ranking + whatever findings the review pass
 * produced (possibly none), so a no-LLM deployment still gets a full ranked
 * deck. Keyed to the resolved head SHA; if the head could not be resolved the
 * deck is skipped with a log rather than persisted against an empty key.
 */
function makeDeckPersister(
  deckStore: DeckStore,
  ref: PrRef,
  headSha: string | undefined,
): DeckPersister {
  return async (ctx, findings) => {
    if (!headSha) {
      console.warn(
        `skipping deck for ${ref.owner}/${ref.repo}#${ref.prNumber}: head SHA unresolved`,
      );
      return;
    }
    await processPrIntoDeck(
      { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber, headSha, diff: ctx.diff },
      findings,
      deckStore,
    );
  };
}

/**
 * Wire the agentic review producer, or `null` when no LLM provider key is set —
 * the no-LLM deployment keeps the original rank-and-comment behavior untouched
 * (the deterministic deck is still produced via `makeDeckPersister`). The
 * store-backed ports share the caller's `db`; the repo-scoped ports (reader,
 * search, tools) are built per run since they depend on the PR's head and files.
 */
export function buildReviewSupport(db: Database): ReviewSupport | null {
  if (!hasLlmKey(process.env)) {
    return null;
  }
  const llm = createReviewProvider();
  const cache = createDrizzleFingerprintCache(db);
  const findingStore = createDrizzleFindingStore(db);
  const conventionStore = createDrizzleConventionStore(db);

  return {
    makeRunner(octokit, ref, headSha): ReviewFindingsRunner {
      const { owner, repo } = ref;
      return async (ctx: ReviewFindingsContext) => {
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
        return reviewAndPersistFindings(ctx, {
          llm,
          cache,
          findingStore,
          codeSearch,
          tools,
        });
      };
    },
  };
}

/** True when the configured provider's API key is present in env. */
export function hasLlmKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/**
 * Resolve the PR head commit so file reads + search hit the reviewed code and
 * the deck keys to it. Best-effort: a failed lookup logs and yields undefined
 * rather than throwing, so the guaranteed ranked comment still ships.
 */
async function resolveHeadSha(octokit: GitHubClient, ref: PrRef): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
    });
    const head = (data as { head?: { sha?: string } })?.head;
    return head?.sha;
  } catch (err) {
    console.error(`could not resolve head SHA for ${ref.owner}/${ref.repo}#${ref.prNumber}:`, err);
    return undefined;
  }
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

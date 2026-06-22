import type { Deck, DeckStore, ReviewFinding } from "@diffsense/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../adapters/github.js";
import type { Database } from "../db/client.js";
import type { PrRef } from "../types.js";
import type { ReviewRunContext } from "./handlePullRequestEvent.js";
import {
  type ReviewSupport,
  buildReviewSupport,
  hasLlmKey,
  runReviewForRef,
} from "./reviewRunner.js";

const ONE_HUNK_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;

/**
 * A fake Octokit whose `pulls.get` answers both calls the runner makes: the
 * head-SHA resolve (no `mediaType`) and the diff fetch (`mediaType.format ===
 * "diff"`). `headRejects` fails only the head resolve, leaving the diff fetch
 * intact — that is the degrade path the runner must survive.
 */
function makeFakeOctokit(opts: { diff?: string; headSha?: string; headRejects?: boolean }) {
  const get = vi.fn(
    async (p: {
      owner: string;
      repo: string;
      pull_number: number;
      mediaType?: { format?: string };
    }) => {
      if (p.mediaType?.format === "diff") {
        return { data: opts.diff ?? ONE_HUNK_DIFF };
      }
      if (opts.headRejects) throw new Error("head fetch failed");
      return { data: { head: { sha: opts.headSha ?? "headsha123" } } };
    },
  );
  const listComments = vi.fn(async () => ({ data: [] as Array<{ id: number; body: string }> }));
  const createComment = vi.fn(async () => ({ data: { id: 999 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 0 } }));
  const octokit = {
    rest: { pulls: { get }, issues: { listComments, createComment, updateComment } },
  } as unknown as GitHubClient;
  return { octokit, get, createComment, updateComment };
}

const ref: PrRef = {
  owner: "octo-org",
  repo: "demo",
  prNumber: 42,
  installationId: 1234,
  action: "synchronize",
  deliveryId: "cli-test",
};

/** A finding the fake review pass produces, to assert it flows out of the run. */
const finding: ReviewFinding = {
  owner: "octo-org",
  repo: "demo",
  prNumber: 42,
  fingerprint: "fp-0",
  file: "a.ts",
  tier: "Low",
  rank: 0,
  explanation: "Adds a const.",
  claims: [],
  reasons: [],
  blastRadius: [],
};

/** A DeckStore that records every save so tests can assert what landed. */
function recordingDeckStore() {
  const saved: Deck[] = [];
  const store: DeckStore = {
    async save(deck) {
      saved.push(deck);
    },
    async get() {
      return saved.at(-1) ?? null;
    },
  };
  return { store, saved };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runReviewForRef (#32 — shared by worker + CLI)", () => {
  it("resolves the head SHA, runs the review pass + deck, and returns the upsert + findings", async () => {
    const fake = makeFakeOctokit({ headSha: "abc123" });
    const { store, saved } = recordingDeckStore();
    const runner = vi.fn(async (_ctx: ReviewRunContext): Promise<ReviewFinding[]> => [finding]);
    const reviewSupport: ReviewSupport = { makeRunner: vi.fn(() => runner) };

    const result = await runReviewForRef(fake.octokit, ref, { deckStore: store, reviewSupport });

    expect(result.headSha).toBe("abc123");
    expect(result.upsert).toEqual({ action: "created", commentId: 999 });
    // The findings the pass produced flow straight back out of the run.
    expect(result.findings).toEqual([finding]);
    // The review pass was wired with the resolved head and actually ran.
    expect(reviewSupport.makeRunner).toHaveBeenCalledWith(fake.octokit, ref, "abc123");
    expect(runner).toHaveBeenCalledOnce();
    // The deterministic deck was persisted, keyed to the resolved head.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.headSha).toBe("abc123");
    expect(saved[0]?.cards.length).toBeGreaterThan(0);
    // The guaranteed ranked comment shipped.
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("returns empty findings (never a prior run's) when the review pass throws, comment still ships", async () => {
    const fake = makeFakeOctokit({ headSha: "abc123" });
    const { store } = recordingDeckStore();
    const runner = vi.fn(async (): Promise<ReviewFinding[]> => {
      throw new Error("LLM exploded mid-pass");
    });
    const reviewSupport: ReviewSupport = { makeRunner: vi.fn(() => runner) };

    const result = await runReviewForRef(fake.octokit, ref, { deckStore: store, reviewSupport });

    // The seam swallows the pass failure; the run reports no findings rather than
    // leaking whatever the PR-scoped store happened to hold.
    expect(result.findings).toEqual([]);
    // ...and the guaranteed ranked comment still ships.
    expect(result.upsert.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("degrades when the head SHA cannot be resolved: no deck, comment still ships", async () => {
    const fake = makeFakeOctokit({ headRejects: true });
    const { store, saved } = recordingDeckStore();
    const runner = vi.fn(async (): Promise<ReviewFinding[]> => []);
    const reviewSupport: ReviewSupport = { makeRunner: vi.fn(() => runner) };

    const result = await runReviewForRef(fake.octokit, ref, { deckStore: store, reviewSupport });

    expect(result.headSha).toBeUndefined();
    // Deck step is skipped (no head to key it to)...
    expect(saved).toHaveLength(0);
    // ...but the ranked comment is the guaranteed deliverable and still ships.
    expect(result.upsert.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
    // The review pass still runs over the diff even without a head, so its
    // findings flow back (the deck just can't be keyed to a head).
    expect(result.findings).toEqual([]);
  });

  it("runs with no LLM (reviewSupport null): seam gets no findings runner, deck still persists", async () => {
    const fake = makeFakeOctokit({ headSha: "def456" });
    const { store, saved } = recordingDeckStore();

    const result = await runReviewForRef(fake.octokit, ref, {
      deckStore: store,
      reviewSupport: null,
    });

    expect(result.headSha).toBe("def456");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.headSha).toBe("def456");
    expect(fake.createComment).toHaveBeenCalledOnce();
    // No LLM wired → no agentic pass → no findings.
    expect(result.findings).toEqual([]);
  });
});

describe("buildReviewSupport / hasLlmKey (#32)", () => {
  it("hasLlmKey is true only when a provider key is present", () => {
    expect(hasLlmKey({})).toBe(false);
    expect(hasLlmKey({ ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
    expect(hasLlmKey({ OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(hasLlmKey({ GOOGLE_GENERATIVE_AI_API_KEY: "x" })).toBe(true);
  });

  it("returns null when no provider key is configured", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    expect(buildReviewSupport({} as Database)).toBeNull();
  });

  it("returns a runner factory when a provider key is present", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const support = buildReviewSupport({} as Database);
    expect(support).not.toBeNull();
    expect(typeof support?.makeRunner).toBe("function");
  });
});

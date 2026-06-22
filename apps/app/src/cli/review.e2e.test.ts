import type { Deck, DeckStore } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../adapters/github.js";
import type { Database } from "../db/client.js";
import { runReviewForRef } from "../worker/reviewRunner.js";
import type { CliConfig } from "./config.js";
import {
  type GitHubAppLike,
  type ReviewCommandDeps,
  type ReviewIo,
  runReviewCommand,
} from "./review.js";

/**
 * End-to-end CLI test (#32). Unlike review.test.ts — which mocks
 * `runReviewForRef` to isolate the command's control flow — this wires the
 * *real* shared runner, so the assertion exercises the actual pipeline a no-LLM
 * `diffsense review` run takes: parse ref → resolve installation → resolve head
 * → `handlePullRequestEvent` (fetch diff, `rankHunks`, build + persist deck,
 * upsert the advisory ranked comment) → read the deck back → emit one JSON
 * object on stdout. Only GitHub (Octokit) and Postgres (the deck store) are
 * faked; everything between is real. This is the AC1/AC2/AC5 guard: the command
 * truly runs the engine and emits the documented machine-readable shape.
 */

const RISKY_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,6 @@
 export function authenticate(token: string) {
-  return verify(token);
+  if (!token) {
+    throw new Error("missing token");
+  }
+  return verify(token, { ignoreExpiration: true });
 }
`;

/**
 * A fake Octokit answering everything the no-LLM pipeline calls: the head-SHA
 * resolve (`pulls.get` with no mediaType), the diff fetch (`pulls.get` with
 * `mediaType.format === "diff"`), the installation resolve, and the
 * comment upsert (no existing comment → create).
 */
function makeFakeOctokit(headSha: string) {
  const get = vi.fn(async (p: { mediaType?: { format?: string } }) => {
    if (p.mediaType?.format === "diff") {
      return { data: RISKY_DIFF };
    }
    return { data: { head: { sha: headSha } } };
  });
  const listComments = vi.fn(async () => ({ data: [] as Array<{ id: number; body: string }> }));
  const createComment = vi.fn(async () => ({ data: { id: 4242 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 0 } }));
  const getRepoInstallation = vi.fn(async () => ({ data: { id: 55 } }));
  const octokit = {
    rest: {
      pulls: { get },
      issues: { listComments, createComment, updateComment },
      apps: { getRepoInstallation },
    },
  } as unknown as GitHubClient;
  return { octokit, get, createComment, getRepoInstallation };
}

/** An in-memory deck store that round-trips by head SHA, like the real adapter. */
function inMemoryDeckStore(): DeckStore {
  const byHead = new Map<string, Deck>();
  return {
    async save(deck) {
      byHead.set(deck.headSha, deck);
    },
    async get(ref) {
      return byHead.get(ref.headSha) ?? null;
    },
  };
}

const cfg: CliConfig = {
  githubAppId: "1",
  githubPrivateKey: "k",
  databaseUrl: "postgres://u:p@localhost:5432/db",
};

describe("diffsense review (end-to-end over the real pipeline, no LLM)", () => {
  it("runs rank → deck → comment and emits the documented JSON shape, returns 0", async () => {
    const headSha = "deadbeefcafe";
    const fake = makeFakeOctokit(headSha);
    const close = vi.fn(async () => {});
    const out: string[] = [];
    const err: string[] = [];
    const io: ReviewIo = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };

    const app: GitHubAppLike = {
      octokit: { rest: { apps: { getRepoInstallation: fake.getRepoInstallation } } },
      getInstallationOctokit: vi.fn(async () => fake.octokit),
    };

    const deps: ReviewCommandDeps = {
      env: {},
      loadConfig: () => cfg,
      createApp: () => app,
      openDb: () => ({ db: {} as Database, close }),
      createDeckStore: () => inMemoryDeckStore(),
      // No LLM configured — the deterministic deck still ships.
      buildReviewSupport: () => null,
      // The REAL shared runner — this is what makes the test end-to-end.
      runReviewForRef,
      newDeliveryId: () => "fixed-id",
    };

    const code = await runReviewCommand(["octo-org/demo#42"], deps, io);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);

    // Exactly one parseable JSON object on stdout.
    const parsed = JSON.parse(out[0] as string);

    // Top-level contract.
    expect(parsed.pr).toEqual({ owner: "octo-org", repo: "demo", prNumber: 42 });
    expect(parsed.headSha).toBe(headSha);
    expect(parsed.llm).toBe(false);
    // No LLM → no agentic findings, by construction (not a stale store read).
    expect(parsed.findings).toEqual([]);

    // The advisory ranked comment was actually upserted by the real seam.
    expect(fake.createComment).toHaveBeenCalledOnce();
    expect(parsed.comment).toEqual({ action: "created", commentId: 4242 });

    // The deck was built from the diff by rankHunks and read back, keyed to head.
    expect(parsed.deck).not.toBeNull();
    expect(parsed.deck.headSha).toBe(headSha);
    expect(parsed.deck.cards.length).toBeGreaterThan(0);
    const card = parsed.deck.cards[0];
    expect(card.file).toBe("src/auth.ts");
    expect(["High", "Medium", "Low"]).toContain(card.tier);
    expect(typeof card.riskScore).toBe("number");
    expect(card.rank).toBe(0);
    expect(Array.isArray(card.highlights)).toBe(true);

    // The db handle is released.
    expect(close).toHaveBeenCalledOnce();
  });
});

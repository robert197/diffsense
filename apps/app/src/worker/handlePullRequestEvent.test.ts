import type { Deck, DeckStore, ReviewFinding } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import { COMMENT_MARKER, type GitHubClient } from "../adapters/github.js";
import {
  type DeckPersister,
  type PullRequestEvent,
  type ReviewRunContext,
  handlePullRequestEvent,
} from "./handlePullRequestEvent.js";
import { processPrIntoDeck } from "./processPrIntoDeck.js";

const ONE_HUNK_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;

function makeFakeOctokit(opts: {
  diff?: string;
  existingComments?: Array<{ id: number; body: string }>;
  getRejects?: boolean;
}) {
  const get = vi.fn(async (_p: { owner: string; repo: string; pull_number: number }) => {
    if (opts.getRejects) throw new Error("diff fetch failed");
    return { data: opts.diff ?? ONE_HUNK_DIFF };
  });
  const listComments = vi.fn(async (_p: { owner: string; repo: string; issue_number: number }) => ({
    data: opts.existingComments ?? [],
  }));
  const createComment = vi.fn(
    async (_p: { owner: string; repo: string; issue_number: number; body: string }) => ({
      data: { id: 999 },
    }),
  );
  const updateComment = vi.fn(
    async (_p: { owner: string; repo: string; comment_id: number; body: string }) => ({
      data: { id: 0 },
    }),
  );

  const octokit = {
    rest: { pulls: { get }, issues: { listComments, createComment, updateComment } },
  } as unknown as GitHubClient;

  return { octokit, get, listComments, createComment, updateComment };
}

const openedEvent: PullRequestEvent = {
  owner: "octo-org",
  repo: "demo",
  prNumber: 42,
  action: "opened",
};
const synchronizeEvent: PullRequestEvent = { ...openedEvent, action: "synchronize" };

describe("handlePullRequestEvent (R3, R4, R5)", () => {
  it("creates exactly one marker comment with the hunk count on opened", async () => {
    const fake = makeFakeOctokit({});

    const result = await handlePullRequestEvent(openedEvent, fake.octokit);

    expect(result).toEqual({ action: "created", commentId: 999 });
    expect(fake.createComment).toHaveBeenCalledOnce();
    expect(fake.updateComment).not.toHaveBeenCalled();
    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("review these first");
    expect(body).toContain("**[High]**");
  });

  it("edits the same comment in place on synchronize (no duplicate)", async () => {
    const fake = makeFakeOctokit({
      existingComments: [{ id: 555, body: `${COMMENT_MARKER}\nold body` }],
    });

    const result = await handlePullRequestEvent(synchronizeEvent, fake.octokit);

    expect(result).toEqual({ action: "updated", commentId: 555 });
    expect(fake.updateComment).toHaveBeenCalledOnce();
    expect(fake.updateComment.mock.calls[0]?.[0].comment_id).toBe(555);
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("falls back to create on synchronize when no marker comment exists", async () => {
    const fake = makeFakeOctokit({
      existingComments: [{ id: 1, body: "unrelated human comment" }],
    });

    const result = await handlePullRequestEvent(synchronizeEvent, fake.octokit);

    expect(result.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
    expect(fake.updateComment).not.toHaveBeenCalled();
  });

  it("still posts a comment when the diff has no rankable changes", async () => {
    const fake = makeFakeOctokit({ diff: "" });

    await handlePullRequestEvent(openedEvent, fake.octokit);

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).toContain("No rankable changes");
  });

  it("throws and posts nothing when the diff fetch fails", async () => {
    const fake = makeFakeOctokit({ getRejects: true });

    await expect(handlePullRequestEvent(openedEvent, fake.octokit)).rejects.toThrow(
      "diff fetch failed",
    );
    expect(fake.createComment).not.toHaveBeenCalled();
    expect(fake.updateComment).not.toHaveBeenCalled();
  });

  it("embeds 👍/👎 reaction links when a base URL is provided", async () => {
    const fake = makeFakeOctokit({});

    await handlePullRequestEvent(openedEvent, fake.octokit, {
      reactionBaseUrl: "https://diffsense.example",
    });

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).toContain("https://diffsense.example/reactions?");
    expect(body).toContain("👍");
    expect(body).toContain("s=down");
  });

  it("omits reaction links when no base URL is provided", async () => {
    const fake = makeFakeOctokit({});

    await handlePullRequestEvent(openedEvent, fake.octokit);

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).not.toContain("/reactions?");
    expect(body).not.toContain("👍");
  });

  it("links the hosted card view when a card-view base URL is provided (#13)", async () => {
    const fake = makeFakeOctokit({});

    await handlePullRequestEvent(openedEvent, fake.octokit, {
      cardViewBaseUrl: "https://cards.example",
    });

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).toContain(
      "[View the full risk cards →](https://cards.example/pr/octo-org/demo/42)",
    );
  });

  it("runs the review-findings pass with the diff when wired, then comments (#13)", async () => {
    const fake = makeFakeOctokit({});
    const reviewFindings = vi.fn(async (_ctx: ReviewRunContext): Promise<ReviewFinding[]> => []);

    await handlePullRequestEvent(openedEvent, fake.octokit, {
      cardViewBaseUrl: "https://cards.example",
      reviewFindings,
    });

    expect(reviewFindings).toHaveBeenCalledOnce();
    expect(reviewFindings.mock.calls[0]?.[0]).toMatchObject({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      diff: ONE_HUNK_DIFF,
    });
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("still posts the ranked comment when the review-findings pass throws (#13)", async () => {
    const fake = makeFakeOctokit({});
    const reviewFindings = vi.fn(async (): Promise<ReviewFinding[]> => {
      throw new Error("llm exploded");
    });

    const result = await handlePullRequestEvent(openedEvent, fake.octokit, { reviewFindings });

    expect(result.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  // --- Deck production (#26) ----------------------------------------------------

  it("builds + persists a deck on every review run, even with NO LLM (empty findings)", async () => {
    const fake = makeFakeOctokit({});
    const persisted: Array<{ ctx: ReviewRunContext; findings: readonly ReviewFinding[] }> = [];
    const persistDeck: DeckPersister = async (ctx, findings) => {
      persisted.push({ ctx, findings });
    };

    // No reviewFindings wired == the no-LLM deployment.
    await handlePullRequestEvent(openedEvent, fake.octokit, { persistDeck });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.findings).toEqual([]);
    expect(persisted[0]?.ctx).toMatchObject({
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      diff: ONE_HUNK_DIFF,
    });
    // The deterministic ranked comment still ships.
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("folds the review pass's findings into the deck it persists (#26)", async () => {
    const fake = makeFakeOctokit({});
    const finding: ReviewFinding = {
      owner: "octo-org",
      repo: "demo",
      prNumber: 42,
      fingerprint: "fp-1",
      file: "a.ts",
      tier: "High",
      rank: 0,
      explanation: "Adds y.",
      claims: [{ claim: "y is unused", evidence: "a.ts:2" }],
      reasons: ["small change"],
      blastRadius: [],
    };
    const reviewFindings = vi.fn(async (): Promise<ReviewFinding[]> => [finding]);
    let handed: readonly ReviewFinding[] | undefined;
    const persistDeck: DeckPersister = async (_ctx, findings) => {
      handed = findings;
    };

    await handlePullRequestEvent(openedEvent, fake.octokit, { reviewFindings, persistDeck });

    expect(handed).toEqual([finding]);
  });

  it("persists no findings into the deck when the review pass throws (#26)", async () => {
    const fake = makeFakeOctokit({});
    const reviewFindings = vi.fn(async (): Promise<ReviewFinding[]> => {
      throw new Error("llm exploded");
    });
    let handed: readonly ReviewFinding[] | undefined;
    const persistDeck: DeckPersister = async (_ctx, findings) => {
      handed = findings;
    };

    await handlePullRequestEvent(openedEvent, fake.octokit, { reviewFindings, persistDeck });

    // Review blew up, but the deterministic deck still gets built with no findings.
    expect(handed).toEqual([]);
  });

  it("still posts the ranked comment when deck persistence throws (#26)", async () => {
    const fake = makeFakeOctokit({});
    const persistDeck: DeckPersister = async () => {
      throw new Error("deck store down");
    };

    const result = await handlePullRequestEvent(openedEvent, fake.octokit, { persistDeck });

    expect(result.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("does not attempt to persist a deck when none is wired", async () => {
    const fake = makeFakeOctokit({});
    // No persistDeck — just rank + comment, exactly as before.
    const result = await handlePullRequestEvent(openedEvent, fake.octokit);
    expect(result.action).toBe("created");
  });

  it("does not link the card view by default (#13)", async () => {
    const fake = makeFakeOctokit({});

    await handlePullRequestEvent(openedEvent, fake.octokit);

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).not.toContain("View the full risk cards");
  });

  it("end-to-end: a real review run persists a deck covering all changed code (AC#1/#2/#3)", async () => {
    // Two changed files => two hunks => the deck must carry a card for each,
    // ordered by risk, each with highlights + a non-empty explanation. No LLM.
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function login() {
+  return checkToken();
 }
diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -10,2 +10,3 @@
 function noop() {
+  log("x");
 }
`;
    const fake = makeFakeOctokit({ diff });
    const saved: Deck[] = [];
    const store: DeckStore = {
      async save(deck) {
        saved.push(deck);
      },
      async get() {
        return saved.at(-1) ?? null;
      },
    };
    // The real seam the worker uses, against a fake store + a fixed head SHA.
    const persistDeck: DeckPersister = (ctx, findings) =>
      processPrIntoDeck({ ...ctx, headSha: "deadbeef" }, findings, store).then(() => undefined);

    await handlePullRequestEvent(openedEvent, fake.octokit, { persistDeck });

    expect(saved).toHaveLength(1);
    const deck = saved[0] as Deck;
    expect(deck.headSha).toBe("deadbeef");
    expect(deck.cards).toHaveLength(2);
    expect(deck.cards.map((c) => c.file).sort()).toEqual(["src/auth.ts", "src/util.ts"]);
    // Ordered by risk, and every card covers real code with highlights + prose.
    expect(deck.cards[0]?.rank).toBe(0);
    expect(deck.cards[1]?.rank).toBe(1);
    for (const card of deck.cards) {
      expect(card.highlights.length).toBeGreaterThan(0);
      expect(card.explanation.length).toBeGreaterThan(0);
    }
  });
});

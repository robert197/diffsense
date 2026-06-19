import { describe, expect, it, vi } from "vitest";
import { COMMENT_MARKER, type GitHubClient } from "../adapters/github.js";
import { type PullRequestEvent, handlePullRequestEvent } from "./handlePullRequestEvent.js";

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
    const reviewFindings = vi.fn(
      async (_ctx: { owner: string; repo: string; prNumber: number; diff: string }) => undefined,
    );

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
    const reviewFindings = vi.fn(async () => {
      throw new Error("llm exploded");
    });

    const result = await handlePullRequestEvent(openedEvent, fake.octokit, { reviewFindings });

    expect(result.action).toBe("created");
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("does not link the card view by default (#13)", async () => {
    const fake = makeFakeOctokit({});

    await handlePullRequestEvent(openedEvent, fake.octokit);

    const body = fake.createComment.mock.calls[0]?.[0].body as string;
    expect(body).not.toContain("View the full risk cards");
  });
});

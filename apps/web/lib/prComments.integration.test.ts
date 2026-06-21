import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, prComments } from "./db";
import {
  type CommentRef,
  type PostedCommentEntry,
  listPostedComments,
  recordPostedComment,
} from "./prComments";

/**
 * End-to-end coverage for leaving PR comments from a card (issue #30) against a REAL
 * Postgres — the record + reflect path through the actual Drizzle queries, not mocks,
 * so a wrong column, the unique constraint, or the kind CHECK would surface here
 * rather than in production. Requires `DATABASE_URL` with migrations applied (the CI
 * compose/service); skips locally when it is unset, mirroring `reviewProgress.integration.test.ts`.
 */

const databaseUrl = process.env.DATABASE_URL;

const RUN = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
const USER = 810_000_000 + Math.round(Math.random() * 1e8);
const OTHER_USER = USER + 1;
const OWNER = `it-prc-${RUN}`;
const REPO = "web";
const PR = 7;
const H1 = `sha1-${RUN}`;
const H2 = `sha2-${RUN}`;

function ref(headSha = H1, githubUserId = USER): CommentRef {
  return { githubUserId, owner: OWNER, repo: REPO, prNumber: PR, headSha };
}

let nextId = 900_000_000 + Math.round(Math.random() * 1e8);
function entry(over: Partial<PostedCommentEntry> = {}): PostedCommentEntry {
  return {
    fingerprint: "fp-a",
    body: "looks off here",
    githubCommentId: nextId++,
    htmlUrl: "https://github.com/acme/web/pull/7#discussion_r1",
    kind: "review",
    ...over,
  };
}

describe.skipIf(!databaseUrl)("pr comments round-trip (issue #30)", () => {
  afterAll(async () => {
    await getDb().delete(prComments).where(eq(prComments.owner, OWNER));
  });

  beforeEach(async () => {
    await getDb().delete(prComments).where(eq(prComments.owner, OWNER));
  });

  it("records a posted comment and reads it back for the reviewer + deck", async () => {
    await recordPostedComment(ref(), entry({ fingerprint: "fp-a", body: "first" }));
    await recordPostedComment(ref(), entry({ fingerprint: "fp-b", body: "second", kind: "issue" }));

    const listed = await listPostedComments(ref());
    expect(listed).toHaveLength(2);
    expect(listed.map((c) => c.body).sort()).toEqual(["first", "second"]);
    expect(listed.find((c) => c.fingerprint === "fp-b")?.kind).toBe("issue");
  });

  it("scopes comments to the reviewer and the head SHA", async () => {
    await recordPostedComment(ref(), entry({ body: "mine on h1" }));

    // A different reviewer has their own (empty) view — no cross-user bleed.
    expect(await listPostedComments(ref(H1, OTHER_USER))).toEqual([]);
    // A different head SHA on the same PR has no comments either.
    expect(await listPostedComments(ref(H2))).toEqual([]);
  });

  it("is idempotent on the GitHub comment id (an at-least-once retry adds no duplicate)", async () => {
    const e = entry({ githubCommentId: nextId++, body: "once" });
    await recordPostedComment(ref(), e);
    await recordPostedComment(ref(), e);

    const listed = await listPostedComments(ref());
    expect(listed).toHaveLength(1);
  });

  it("rejects a kind outside review/issue at the DB layer (CHECK constraint)", async () => {
    await expect(
      getDb().insert(prComments).values({
        githubUserId: USER,
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha: H1,
        fingerprint: "bad",
        body: "x",
        githubCommentId: nextId++,
        htmlUrl: "https://x.dev/c",
        kind: "inline",
      }),
    ).rejects.toThrow();
  });
});

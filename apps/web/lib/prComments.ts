import { and, desc, eq } from "drizzle-orm";
import { getDb, prComments } from "./db";

/**
 * Leave PR comments from a card (issue #30) — the `apps/web` DB helper over the
 * `pr_comments` table. The comment action records a posted comment on success; the
 * deck page reads a reviewer's comments for the deck back so the card can reflect
 * what was already posted (a link to it). Mirrors how `lib/reviewProgress.ts` owns
 * the per-reviewer read-model directly rather than through a core port. Strictly a
 * record of what the reviewer chose to send — it carries no merge/approve authority.
 */

/** The persistence key — a reviewer's posted comments on one deck (PR + head SHA). */
export interface CommentRef {
  githubUserId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** A successfully-posted comment to record (the `GitHubGateway` result + its card). */
export interface PostedCommentEntry {
  fingerprint: string;
  body: string;
  githubCommentId: number;
  htmlUrl: string;
  kind: "review" | "issue";
}

/** One posted comment as the card view reflects it. */
export interface PostedCardComment {
  fingerprint: string;
  body: string;
  htmlUrl: string;
  kind: "review" | "issue";
  createdAt: Date;
}

/**
 * Record a posted comment. The GitHub comment id is unique, so an at-least-once
 * retry (the action re-running after a transient failure) is idempotent — a second
 * insert of the same comment is a no-op rather than a duplicate row.
 */
export async function recordPostedComment(
  ref: CommentRef,
  entry: PostedCommentEntry,
): Promise<void> {
  await getDb()
    .insert(prComments)
    .values({
      githubUserId: ref.githubUserId,
      owner: ref.owner,
      repo: ref.repo,
      prNumber: ref.prNumber,
      headSha: ref.headSha,
      fingerprint: entry.fingerprint,
      body: entry.body,
      githubCommentId: entry.githubCommentId,
      htmlUrl: entry.htmlUrl,
      kind: entry.kind,
    })
    .onConflictDoNothing({ target: prComments.githubCommentId });
}

/**
 * The reviewer's posted comments for one deck (PR + head SHA), newest first. The
 * deck page groups these by fingerprint (`groupPostedComments`) so each card can
 * show what the reviewer already posted from it.
 */
export async function listPostedComments(ref: CommentRef): Promise<PostedCardComment[]> {
  const rows = await getDb()
    .select({
      fingerprint: prComments.fingerprint,
      body: prComments.body,
      htmlUrl: prComments.htmlUrl,
      kind: prComments.kind,
      createdAt: prComments.createdAt,
      id: prComments.id,
    })
    .from(prComments)
    .where(
      and(
        eq(prComments.githubUserId, ref.githubUserId),
        eq(prComments.owner, ref.owner),
        eq(prComments.repo, ref.repo),
        eq(prComments.prNumber, ref.prNumber),
        eq(prComments.headSha, ref.headSha),
      ),
    )
    .orderBy(desc(prComments.createdAt), desc(prComments.id));
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    body: r.body,
    htmlUrl: r.htmlUrl,
    kind: r.kind === "issue" ? "issue" : "review",
    createdAt: r.createdAt,
  }));
}

/**
 * Group posted comments by the card (fingerprint) they were left from. Pure, so the
 * deck page can hand each card its own comments without a per-card query and the
 * grouping stays unit-testable without a database.
 */
export function groupPostedComments(
  comments: PostedCardComment[],
): Map<string, PostedCardComment[]> {
  const byFingerprint = new Map<string, PostedCardComment[]>();
  for (const comment of comments) {
    const list = byFingerprint.get(comment.fingerprint);
    if (list) {
      list.push(comment);
    } else {
      byFingerprint.set(comment.fingerprint, [comment]);
    }
  }
  return byFingerprint;
}

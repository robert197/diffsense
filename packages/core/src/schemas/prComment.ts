import { z } from "zod";

/**
 * Comment a reviewer posts to a PR straight from a deck card (issue #30). Pure
 * schema, no I/O and no vendor SDK — the shape the `GitHubGateway` port speaks in,
 * the same across any GitHub adapter. The deck card carries the file + highlighted
 * line ranges; `cardCommentAnchor` (in `core/render`) folds those into the optional
 * `anchor` below so the comment lands on the exact changed lines when it can.
 */

// A review comment can only be left where GitHub renders the diff: a single body
// has to fit GitHub's comment ceiling, so bound it here rather than discovering the
// limit as a 422 at post time.
const MAX_BODY_LENGTH = 65_536;

/**
 * Where on the diff a comment is anchored. `side` follows GitHub's review-comment
 * convention: "RIGHT" = the new (head) side, "LEFT" = the old side. `line` is the
 * end line of the range (1-based); `startLine` is set only for a multi-line range
 * and must not exceed `line`. `commitId` is the PR head SHA the deck was built
 * against — the commit the line numbers refer to.
 */
export const PrCommentAnchorSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    side: z.enum(["LEFT", "RIGHT"]),
    commitId: z.string().min(1),
  })
  .refine((a) => a.startLine === undefined || a.startLine <= a.line, {
    message: "anchor startLine must be <= line",
  });
export type PrCommentAnchor = z.infer<typeof PrCommentAnchorSchema>;

/**
 * A reviewer-authored comment to post. `body` is the reviewer's own words (never
 * auto-generated — the product stays advisory and human-driven). An absent `anchor`
 * means a general PR-conversation comment rather than a diff-anchored one.
 */
export const PrCommentInputSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  anchor: PrCommentAnchorSchema.optional(),
});
export type PrCommentInput = z.infer<typeof PrCommentInputSchema>;

/**
 * The result of a successful post: GitHub's comment id and html URL, plus which
 * kind of comment actually landed ("review" = diff-anchored, "issue" = general
 * conversation — the fallback when an anchored post can't be positioned).
 */
export const PostedCommentSchema = z.object({
  id: z.number().int(),
  htmlUrl: z.string().url(),
  kind: z.enum(["review", "issue"]),
});
export type PostedComment = z.infer<typeof PostedCommentSchema>;

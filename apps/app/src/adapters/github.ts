/**
 * GitHub adapter (Octokit). The seam types against a minimal structural
 * interface so tests can supply a fake without the real client.
 */

export const COMMENT_MARKER = "<!-- diffsense:pr-review -->";

const COMMENTS_PER_PAGE = 100;
// Bound the scan so a pathological PR can't loop forever (~1000 comments).
// Comment-ID persistence (issue #12) will make this lookup O(1) and page-independent.
const MAX_COMMENT_PAGES = 10;

/** The subset of Octokit's REST surface this slice uses. */
export interface GitHubClient {
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format?: string };
      }) => Promise<{ data: unknown }>;
    };
    issues: {
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: Array<{ id: number; body?: string | null }> }>;
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<{ data: { id: number } }>;
      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<{ data: { id: number } }>;
    };
  };
}

export interface UpsertResult {
  action: "created" | "updated";
  commentId: number;
}

/**
 * Idempotent comment delivery (KTD2): find the app's existing comment by hidden
 * marker and edit it in place; otherwise create it. Guarantees exactly one
 * diffsense comment per PR — no duplicate, no per-push spam on `synchronize`.
 */
export async function upsertReviewComment(
  octokit: GitHubClient,
  params: { owner: string; repo: string; prNumber: number; body: string },
): Promise<UpsertResult> {
  const { owner, repo, prNumber, body } = params;
  const fullBody = `${COMMENT_MARKER}\n${body}`;

  // Paginate so the marker is found even on PRs with >100 comments — otherwise
  // a later `synchronize` misses it and posts a duplicate (breaks idempotency).
  let existingId: number | null = null;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: COMMENTS_PER_PAGE,
      page,
    });
    const match = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (match) {
      existingId = match.id;
      break;
    }
    if (comments.length < COMMENTS_PER_PAGE) {
      break;
    }
  }

  if (existingId !== null) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body: fullBody,
    });
    return { action: "updated", commentId: existingId };
  }

  const { data: created } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: fullBody,
  });
  return { action: "created", commentId: created.id };
}

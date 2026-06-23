/**
 * The shape the `postCardComment` server action returns and the deck's comment
 * composer renders (issue #30). It lives in this boundary-neutral module — no
 * `"use server"` / `"use client"` directive — so both the server action and the
 * client component import the *same* type instead of each declaring a structural
 * twin that can silently drift. The composer drives it via `useActionState`: a
 * link on success, a clear message on failure.
 */
export interface PostCommentState {
  ok: boolean;
  error?: string;
  comment?: { htmlUrl: string; kind: "review" | "issue" };
}

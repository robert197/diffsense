import { GitPullRequest } from "lucide-react";
import { redirect } from "next/navigation";
import { PullRow } from "../../../../../components/pulls/PullRow";
import { AppHeader } from "../../../../../components/site/AppHeader";
import { clearSessionRow, requireSession } from "../../../../../lib/auth/session";
import { GitHubAuthError, type PullRequest } from "../../../../../lib/github";

/**
 * Open-PR list for one repo (issue #25). Each PR row links to the existing review
 * entry point (`/pr/<owner>/<repo>/<number>`) — deck generation is a later slice,
 * so this is purely the handoff, no review controls here.
 */

export const dynamic = "force-dynamic";

type Params = { owner: string; repo: string };

export default async function RepoPullsPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;
  const session = await requireSession();

  let pulls: PullRequest[];
  try {
    pulls = await session.github.listOpenPullRequests(owner, repo);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      await clearSessionRow();
      redirect("/login");
    }
    throw err;
  }

  return (
    <>
      <AppHeader
        login={session.login}
        crumbs={[{ label: "Repositories", href: "/repos" }, { label: `${owner}/${repo}` }]}
      />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            {owner}/{repo}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pulls.length === 0
              ? "Open pull requests"
              : `${pulls.length} open pull request${pulls.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {pulls.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
              <GitPullRequest className="size-6" />
            </div>
            <p className="font-medium">No open pull requests</p>
            <p className="mt-1 text-sm text-muted-foreground">
              When a PR opens here, it&apos;ll show up ready to review.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pulls.map((pull) => (
              <li key={pull.number}>
                <PullRow owner={owner} repo={repo} pull={pull} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

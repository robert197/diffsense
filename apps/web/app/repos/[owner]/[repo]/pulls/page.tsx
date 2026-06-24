import { redirect } from "next/navigation";
import { PullsList } from "../../../../../components/pulls/PullsList";
import { AppHeader } from "../../../../../components/site/AppHeader";
import { clearSessionRow, requireSession } from "../../../../../lib/auth/session";
import { GitHubAuthError, type PullRequest } from "../../../../../lib/github";

/**
 * Open-PR list for one repo (issue #25). Each PR row links to the existing review
 * entry point (`/pr/<owner>/<repo>/<number>`) — deck generation is a later slice,
 * so this is purely the handoff, no review controls here.
 *
 * The server does the first paint (auth + the initial fetch); `PullsList` (client)
 * then keeps the list synced while the page is open — refresh on tab refocus + a
 * manual Refresh — so a reviewer returning from GitHub sees current PRs without a
 * full-page reload.
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
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">
          {owner}/{repo}
        </h1>
        <PullsList owner={owner} repo={repo} initialPulls={pulls} />
      </main>
    </>
  );
}

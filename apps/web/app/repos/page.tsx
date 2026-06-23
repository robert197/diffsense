import { ArrowRight, Building2, FolderGit2, User } from "lucide-react";
import { redirect } from "next/navigation";
import { RepoRow } from "../../components/repos/RepoRow";
import { AppHeader } from "../../components/site/AppHeader";
import { Badge } from "../../components/ui/badge";
import { clearSessionRow, requireSession } from "../../lib/auth/session";
import { GitHubAuthError, type Repository } from "../../lib/github";

/**
 * Repo picker (issue #25). Lists the GitHub App installations the signed-in
 * reviewer can access and, under each, the repositories — every repo a tappable
 * row into its open PRs. A 401 from GitHub clears the session and bounces to
 * /login (the token was revoked or expired beyond refresh). A non-auth failure
 * for a single installation degrades that group only, not the whole page.
 */

export const dynamic = "force-dynamic";

type RepoGroup = {
  account: string;
  accountType: string;
  repos: Repository[];
  failed: boolean;
};

export default async function ReposPage() {
  const session = await requireSession();

  let groups: RepoGroup[];
  try {
    const installations = await session.github.listInstallations();
    // Fetch each installation's repos independently so one org's transient
    // failure doesn't blank the entire page (Promise.all would reject on first).
    const settled = await Promise.allSettled(
      installations.map((installation) =>
        session.github.listInstallationRepositories(installation.id),
      ),
    );
    // Re-surface an auth failure uniformly so the catch below clears the session.
    const authFailure = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && result.reason instanceof GitHubAuthError,
    );
    if (authFailure) {
      throw authFailure.reason;
    }
    groups = installations.map((installation, index) => {
      const result = settled[index];
      return {
        account: installation.account,
        accountType: installation.accountType,
        repos: result.status === "fulfilled" ? result.value : [],
        failed: result.status === "rejected",
      };
    });
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      await clearSessionRow();
      redirect("/login");
    }
    throw err;
  }

  const visible = groups.filter((group) => group.repos.length > 0 || group.failed);

  return (
    <>
      <AppHeader login={session.login} crumbs={[{ label: "Repositories" }]} />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your repositories</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a repo to see its open pull requests.
            </p>
          </div>
          <a
            href="/reviews"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Continue reviewing
            <ArrowRight className="size-4" />
          </a>
        </div>

        {visible.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-8">
            {visible.map((group) => (
              <section key={group.account}>
                <div className="mb-3 flex items-center gap-2">
                  {group.accountType.toLowerCase() === "organization" ? (
                    <Building2 className="size-4 text-muted-foreground" />
                  ) : (
                    <User className="size-4 text-muted-foreground" />
                  )}
                  <h2 className="text-sm font-semibold">{group.account}</h2>
                  <Badge variant="secondary" className="uppercase tracking-wide">
                    {group.accountType}
                  </Badge>
                </div>
                {group.failed ? (
                  <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                    Couldn&apos;t load repositories for this account just now. Try refreshing.
                  </p>
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {group.repos.map((repo) => (
                      <li key={repo.fullName}>
                        <RepoRow repo={repo} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
        <FolderGit2 className="size-6" />
      </div>
      <h2 className="font-medium">No repositories yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Install the diffsense GitHub App on a repository to get started, then refresh this page.
      </p>
    </div>
  );
}

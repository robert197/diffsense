import { redirect } from "next/navigation";
import { SignOutButton } from "../../components/SignOutButton";
import { clearSessionRow, requireSession } from "../../lib/auth/session";
import { GitHubAuthError, type Repository } from "../../lib/github";
import { badge, list, muted, page, row } from "../../lib/ui";

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

  const hasContent = groups.some((group) => group.repos.length > 0 || group.failed);

  return (
    <main style={page}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "1.25rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Your repositories</h1>
          <p style={{ ...muted, margin: "0.3rem 0 0" }}>Signed in as {session.login}</p>
        </div>
        <SignOutButton variant="pill" />
      </header>

      {!hasContent ? (
        <p style={{ opacity: 0.7, lineHeight: 1.5 }}>
          No repositories yet. Install the diffsense GitHub App on a repository to get started, then
          refresh.
        </p>
      ) : (
        groups
          .filter((group) => group.repos.length > 0 || group.failed)
          .map((group) => (
            <section key={group.account} style={{ marginBottom: "1.75rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.6rem",
                }}
              >
                <h2 style={{ fontSize: "1rem", margin: 0 }}>{group.account}</h2>
                <span style={badge}>{group.accountType}</span>
              </div>
              {group.failed ? (
                <p style={{ ...muted, lineHeight: 1.5 }}>
                  Couldn&apos;t load repositories for this account just now. Try refreshing.
                </p>
              ) : (
                <ul style={list}>
                  {group.repos.map((repo) => (
                    <li key={repo.fullName}>
                      <a href={`/repos/${repo.owner}/${repo.name}/pulls`} style={row}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span style={{ fontWeight: 600 }}>{repo.name}</span>
                          {repo.private && <span style={badge}>Private</span>}
                        </div>
                        <span style={{ ...muted, display: "block", marginTop: "0.2rem" }}>
                          {repo.fullName}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
      )}
    </main>
  );
}

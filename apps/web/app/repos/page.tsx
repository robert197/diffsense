import { redirect } from "next/navigation";
import { clearSessionRow, requireSession } from "../../lib/auth/session";
import { GitHubAuthError, type Repository } from "../../lib/github";
import { badge, list, muted, page, row } from "../../lib/ui";

/**
 * Repo picker (issue #25). Lists the GitHub App installations the signed-in
 * reviewer can access and, under each, the repositories — every repo a tappable
 * row into its open PRs. A 401 from GitHub clears the session and bounces to
 * /login (the token was revoked or expired beyond refresh).
 */

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  const session = await requireSession();

  let groups: Array<{ account: string; accountType: string; repos: Repository[] }>;
  try {
    const installations = await session.github.listInstallations();
    groups = await Promise.all(
      installations.map(async (installation) => ({
        account: installation.account,
        accountType: installation.accountType,
        repos: await session.github.listInstallationRepositories(installation.id),
      })),
    );
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      await clearSessionRow();
      redirect("/login");
    }
    throw err;
  }

  const hasRepos = groups.some((group) => group.repos.length > 0);

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
        <form action="/logout" method="post">
          <button
            type="submit"
            style={{
              background: "transparent",
              border: "1px solid #374151",
              color: "#9ca3af",
              borderRadius: 8,
              padding: "0.45rem 0.7rem",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Sign out
          </button>
        </form>
      </header>

      {!hasRepos ? (
        <p style={{ opacity: 0.7, lineHeight: 1.5 }}>
          No repositories yet. Install the diffsense GitHub App on a repository to get started, then
          refresh.
        </p>
      ) : (
        groups
          .filter((group) => group.repos.length > 0)
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
            </section>
          ))
      )}
    </main>
  );
}

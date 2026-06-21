import { redirect } from "next/navigation";
import { clearSessionRow, requireSession } from "../../../../../lib/auth/session";
import { GitHubAuthError, type PullRequest } from "../../../../../lib/github";
import { badge, list, muted, page, relativeTime, row } from "../../../../../lib/ui";

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
    <main style={page}>
      <header style={{ marginBottom: "1.25rem" }}>
        <a href="/repos" style={{ ...muted, textDecoration: "none" }}>
          ← Repositories
        </a>
        <h1 style={{ fontSize: "1.4rem", margin: "0.4rem 0 0" }}>
          {owner}/{repo}
        </h1>
        <p style={{ ...muted, margin: "0.3rem 0 0" }}>Open pull requests</p>
      </header>

      {pulls.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No open pull requests.</p>
      ) : (
        <ul style={list}>
          {pulls.map((pull) => (
            <li key={pull.number}>
              <a href={`/pr/${owner}/${repo}/${pull.number}`} style={row}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontWeight: 600 }}>{pull.title}</span>
                  {pull.draft && <span style={badge}>Draft</span>}
                </div>
                <span style={{ ...muted, display: "block", marginTop: "0.25rem" }}>
                  #{pull.number}
                  {pull.author ? ` · ${pull.author}` : ""} · updated {relativeTime(pull.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

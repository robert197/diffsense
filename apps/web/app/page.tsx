import { SignOutButton } from "../components/SignOutButton";
import { getSession } from "../lib/auth/session";
import { primaryButton } from "../lib/ui";

/**
 * The entry path home (issue #25). Signed-out reviewers get a "Sign in with
 * GitHub" call to action; signed-in reviewers get a link into their accessible
 * repos. Advisory product — no merge/approve controls anywhere.
 */

export const dynamic = "force-dynamic";

type SearchParams = { error?: string };

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { error } = await searchParams;
  const session = await getSession();

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "2rem" }}>
      <div style={{ maxWidth: 460, width: "100%", textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>diffsense</h1>
        <p style={{ opacity: 0.7, lineHeight: 1.5, marginBottom: "1.5rem" }}>
          Reviewing AI code at AI speed. Sign in to see the pull requests that need you,
          risk-ordered.
        </p>

        {error === "auth" && (
          <p style={{ color: "#f87171", fontSize: "0.9rem", marginBottom: "1rem" }}>
            Sign-in didn&apos;t complete. Please try again.
          </p>
        )}

        {session ? (
          <div style={{ display: "grid", gap: "1rem", justifyItems: "center" }}>
            <p style={{ opacity: 0.8, margin: 0 }}>
              Signed in as <strong>{session.login}</strong>
            </p>
            <a href="/repos" style={primaryButton}>
              Your repositories →
            </a>
            <a
              href="/reviews"
              style={{ color: "#60a5fa", textDecoration: "none", fontWeight: 600 }}
            >
              Continue reviewing →
            </a>
            <SignOutButton variant="link" />
          </div>
        ) : (
          <a href="/login" style={primaryButton}>
            Sign in with GitHub
          </a>
        )}
      </div>
    </main>
  );
}

import { type Finding, listFindings } from "../../../../../lib/findings";
import { TIER_COLOR } from "../../../../../lib/ui";
import { refute } from "./actions";

/**
 * The hosted card review view (issue #13). A read-model over the `findings`
 * table: one card per reviewed chunk, ordered by risk, each showing the
 * explanation, falsifiable claims (with a one-click refute), risk reasons, and
 * blast radius. Strictly advisory — there is no merge, approve, or block control
 * anywhere on this surface.
 */

export const dynamic = "force-dynamic";

type Params = { owner: string; repo: string; number: string };

export default async function PrCardsPage({ params }: { params: Promise<Params> }) {
  const { owner, repo, number } = await params;
  const prNumber = Number(number);
  const findings = Number.isInteger(prNumber) ? await listFindings({ owner, repo, prNumber }) : [];

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>
          {owner}/{repo} #{prNumber}
        </h1>
        <p style={{ opacity: 0.7, margin: "0.5rem 0 0", lineHeight: 1.5 }}>
          Reviewed changes, ordered by risk. This is advisory: a reading order and a place to push
          back on the findings, not a verdict on the PR.
        </p>
        <a
          href={`/pr/${owner}/${repo}/${prNumber}/deck`}
          style={{
            display: "inline-block",
            marginTop: "0.85rem",
            padding: "0.5rem 0.9rem",
            borderRadius: 8,
            border: "1px solid #2563eb",
            color: "#60a5fa",
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "0.9rem",
          }}
        >
          Swipe the deck →
        </a>
      </header>

      {findings.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No findings for this PR yet.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
          {findings.map((finding) => (
            <li key={finding.fingerprint}>
              <FindingCard finding={finding} owner={owner} repo={repo} prNumber={prNumber} />
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

function FindingCard({
  finding,
  owner,
  repo,
  prNumber,
}: {
  finding: Finding;
  owner: string;
  repo: string;
  prNumber: number;
}) {
  return (
    <article
      style={{
        border: "1px solid #1f2933",
        borderRadius: 10,
        padding: "1rem 1.25rem",
        background: "#11151a",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.5rem" }}>
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            color: "#0b0d10",
            background: TIER_COLOR[finding.tier] ?? "#9ca3af",
            borderRadius: 999,
            padding: "0.1rem 0.55rem",
          }}
        >
          {finding.tier}
        </span>
        <code style={{ fontSize: "0.85rem", opacity: 0.9 }}>{finding.file}</code>
      </div>

      <p style={{ margin: "0 0 0.75rem", lineHeight: 1.5 }}>{finding.explanation}</p>

      {finding.claims.length > 0 && (
        <section style={{ marginBottom: "0.75rem" }}>
          <h2 style={sectionHeading}>Claims</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.5rem" }}>
            {finding.claims.map((claim, i) => (
              <li key={`${finding.fingerprint}-claim-${i}`} style={{ lineHeight: 1.45 }}>
                <span>{claim.claim}</span>{" "}
                <span style={{ opacity: 0.55, fontSize: "0.8rem" }}>({claim.evidence})</span>{" "}
                <form action={refute} style={{ display: "inline" }}>
                  <input type="hidden" name="owner" value={owner} />
                  <input type="hidden" name="repo" value={repo} />
                  <input type="hidden" name="prNumber" value={prNumber} />
                  <input type="hidden" name="fingerprint" value={finding.fingerprint} />
                  <input type="hidden" name="tier" value={finding.tier} />
                  <button type="submit" style={refuteButton}>
                    Refute
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginBottom: "0.75rem" }}>
        <h2 style={sectionHeading}>Why it's ranked here</h2>
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {finding.reasons.map((reason, i) => (
            <li key={`${finding.fingerprint}-reason-${i}`} style={{ lineHeight: 1.45 }}>
              {reason}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 style={sectionHeading}>Blast radius</h2>
        {finding.blastRadius.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {finding.blastRadius.map((ref, i) => (
              <li key={`${finding.fingerprint}-blast-${i}`} style={{ lineHeight: 1.45 }}>
                <code style={{ fontSize: "0.8rem" }}>{ref}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, opacity: 0.5, fontSize: "0.85rem" }}>No call sites found.</p>
        )}
      </section>
    </article>
  );
}

const sectionHeading: React.CSSProperties = {
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.55,
  margin: "0 0 0.35rem",
};

const refuteButton: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "#e6e8eb",
  background: "transparent",
  border: "1px solid #374151",
  borderRadius: 6,
  padding: "0.05rem 0.5rem",
  cursor: "pointer",
};

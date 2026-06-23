import { Crosshair, FileCode2, Layers, ListChecks, Radar } from "lucide-react";
import { TierBadge } from "../../../../../components/review/RiskIndicator";
import { AppHeader } from "../../../../../components/site/AppHeader";
import { Button } from "../../../../../components/ui/button";
import { Card } from "../../../../../components/ui/card";
import { type Finding, listFindings } from "../../../../../lib/findings";
import { tierMeta } from "../../../../../lib/ui";
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
    <>
      <AppHeader
        crumbs={[
          { label: "Repositories", href: "/repos" },
          { label: `${owner}/${repo}`, href: `/repos/${owner}/${repo}/pulls` },
          { label: `#${prNumber}` },
        ]}
      />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h1 className="text-2xl font-semibold tracking-tight">
              {owner}/{repo} #{prNumber}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Reviewed changes, ordered by risk. Advisory: a reading order and a place to push back
              on the findings — not a verdict on the PR.
            </p>
          </div>
          <Button asChild>
            <a href={`/pr/${owner}/${repo}/${prNumber}/deck`}>
              <Layers />
              Swipe the deck
            </a>
          </Button>
        </div>

        {findings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-card text-muted-foreground">
              <Radar className="size-6" />
            </div>
            <p className="font-medium">No findings for this PR yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Once the engine processes the PR, its findings appear here, riskiest first.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {findings.map((finding, i) => (
              <li key={finding.fingerprint}>
                <FindingCard
                  finding={finding}
                  index={i + 1}
                  owner={owner}
                  repo={repo}
                  prNumber={prNumber}
                />
              </li>
            ))}
          </ol>
        )}
      </main>
    </>
  );
}

function FindingCard({
  finding,
  index,
  owner,
  repo,
  prNumber,
}: {
  finding: Finding;
  index: number;
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const m = tierMeta(finding.tier);
  return (
    <Card className={`overflow-hidden border-l-4 ${m.rail} p-5`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">#{index}</span>
        <TierBadge tier={finding.tier} />
        <code className="flex min-w-0 items-center gap-1.5 truncate text-sm text-foreground/90">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          {finding.file}
        </code>
      </div>

      <p className="mt-3 leading-relaxed">{finding.explanation}</p>

      {finding.claims.length > 0 && (
        <Section icon={<ListChecks className="size-3.5" />} title="Claims">
          <ul className="flex flex-col gap-2">
            {finding.claims.map((claim, i) => (
              <li
                key={`${finding.fingerprint}-claim-${i}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm leading-relaxed"
              >
                <span>{claim.claim}</span>
                <span className="text-xs text-muted-foreground">({claim.evidence})</span>
                <form action={refute} className="ml-auto inline">
                  <input type="hidden" name="owner" value={owner} />
                  <input type="hidden" name="repo" value={repo} />
                  <input type="hidden" name="prNumber" value={prNumber} />
                  <input type="hidden" name="fingerprint" value={finding.fingerprint} />
                  <input type="hidden" name="tier" value={finding.tier} />
                  <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    Refute
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section icon={<Radar className="size-3.5" />} title="Why it's ranked here">
        <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed marker:text-muted-foreground/50">
          {finding.reasons.map((reason, i) => (
            <li key={`${finding.fingerprint}-reason-${i}`}>{reason}</li>
          ))}
        </ul>
      </Section>

      <Section icon={<Crosshair className="size-3.5" />} title="Blast radius">
        {finding.blastRadius.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {finding.blastRadius.map((ref, i) => (
              <code
                key={`${finding.fingerprint}-blast-${i}`}
                className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-foreground/80"
              >
                {ref}
              </code>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No call sites found.</p>
        )}
      </Section>
    </Card>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4">
      <h2 className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

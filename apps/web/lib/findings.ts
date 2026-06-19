import { and, asc, desc, eq } from "drizzle-orm";
import { type Claim, findings, getDb, reactions } from "./db";

/** A card-ready finding as the view renders it. */
export interface Finding {
  fingerprint: string;
  file: string;
  tier: string;
  rank: number;
  explanation: string;
  claims: Claim[];
  reasons: string[];
  blastRadius: string[];
}

export interface PrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Findings for one PR, ordered by risk (rank ascending, newest run wins ties).
 * The card view renders them in this order — it never re-sorts.
 */
export async function listFindings(ref: PrRef): Promise<Finding[]> {
  const rows = await getDb()
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.owner, ref.owner),
        eq(findings.repo, ref.repo),
        eq(findings.prNumber, ref.prNumber),
      ),
    )
    .orderBy(asc(findings.rank), desc(findings.id));

  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    file: row.file,
    tier: row.tier,
    rank: row.rank,
    explanation: row.explanation,
    claims: Array.isArray(row.claims) ? row.claims : [],
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    blastRadius: Array.isArray(row.blastRadius) ? row.blastRadius : [],
  }));
}

/**
 * Record a reviewer refuting a finding — a 👎 against the chunk fingerprint and
 * its tier, written to the same precision-signal table the ranked comment feeds.
 * Advisory only: a refute is a signal, never a merge action.
 */
export async function recordRefute(ref: PrRef, fingerprint: string, tier: string): Promise<void> {
  await getDb().insert(reactions).values({
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    fingerprint,
    tier,
    sentiment: "down",
  });
}

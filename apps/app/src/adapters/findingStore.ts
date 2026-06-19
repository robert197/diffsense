import {
  type FindingPrRef,
  type FindingStore,
  type ReviewFinding,
  ReviewFindingSchema,
} from "@diffsense/core";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { findings } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `FindingStore` port (issue #13,
 * docs/ARCHITECTURE.md §1, §6). `core` owns the port and the `ReviewFinding`
 * shape; this is the only place that knows it is Postgres. `replaceForPr` swaps
 * the PR's findings for the latest run's set in one transaction, so a re-pushed
 * PR never stacks duplicate chunks; `listByPr` then orders by `rank asc` (id asc
 * to break ties deterministically). The JSON columns are re-validated against
 * `ReviewFindingSchema` on read, so a malformed row fails loudly rather than
 * rendering a broken card.
 */
export function createDrizzleFindingStore(db: Database): FindingStore {
  return {
    async replaceForPr(
      { owner, repo, prNumber }: FindingPrRef,
      list: ReviewFinding[],
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(findings)
          .where(
            and(
              eq(findings.owner, owner),
              eq(findings.repo, repo),
              eq(findings.prNumber, prNumber),
            ),
          );
        if (list.length === 0) {
          return;
        }
        await tx.insert(findings).values(
          list.map((finding) => ({
            owner: finding.owner,
            repo: finding.repo,
            prNumber: finding.prNumber,
            fingerprint: finding.fingerprint,
            file: finding.file,
            tier: finding.tier,
            rank: finding.rank,
            explanation: finding.explanation,
            claims: finding.claims,
            reasons: finding.reasons,
            blastRadius: finding.blastRadius,
          })),
        );
      });
    },

    async listByPr({ owner, repo, prNumber }: FindingPrRef): Promise<ReviewFinding[]> {
      const rows = await db
        .select()
        .from(findings)
        .where(
          and(eq(findings.owner, owner), eq(findings.repo, repo), eq(findings.prNumber, prNumber)),
        )
        .orderBy(asc(findings.rank), asc(findings.id));

      return rows.map((row) =>
        ReviewFindingSchema.parse({
          owner: row.owner,
          repo: row.repo,
          prNumber: row.prNumber,
          fingerprint: row.fingerprint,
          file: row.file,
          tier: row.tier,
          rank: row.rank,
          explanation: row.explanation,
          claims: row.claims,
          reasons: row.reasons,
          blastRadius: row.blastRadius,
        }),
      );
    },
  };
}

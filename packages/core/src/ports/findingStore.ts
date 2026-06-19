import type { ReviewFinding } from "../schemas/finding.js";

/** Repo coordinates identifying the PR a finding set belongs to. */
export interface FindingPrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Port: persist per-chunk review findings and read them back for one PR.
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` writes the rows; the `apps/web` card view reads them (issue #13,
 * docs/ARCHITECTURE.md §1, §6). `listByPr` returns findings ordered by risk
 * (rank ascending, highest risk first) so the view never re-sorts.
 */
export interface FindingStore {
  record(finding: ReviewFinding): Promise<void>;
  listByPr(ref: FindingPrRef): Promise<ReviewFinding[]>;
}

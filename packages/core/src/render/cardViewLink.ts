/**
 * Build the URL of the hosted card view for one PR (issue #13). The advisory PR
 * comment links here so a reviewer reaches the full per-chunk detail — the
 * explanation, claims, reasons, and blast radius — without installing anything in
 * GitHub. `apps/web` serves this route as `/pr/{owner}/{repo}/{number}`.
 */
export interface CardViewPr {
  owner: string;
  repo: string;
  prNumber: number;
}

export function cardViewLink(webBaseUrl: string, pr: CardViewPr): string {
  const base = webBaseUrl.replace(/\/$/, "");
  const owner = encodeURIComponent(pr.owner);
  const repo = encodeURIComponent(pr.repo);
  return `${base}/pr/${owner}/${repo}/${pr.prNumber}`;
}

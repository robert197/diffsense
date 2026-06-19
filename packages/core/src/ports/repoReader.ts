/**
 * Port: read code context for the review unit (docs/ARCHITECTURE.md §3).
 *
 * Pure interface — `core` never knows it is Octokit/GitHub. The github adapter
 * in `apps/app` implements it, closing over the PR's repo coordinates so the
 * review unit can ask for a file range or the PR's intent without carrying
 * coords through every call.
 */

/** A 1-based, inclusive line range within a file. */
export interface LineRange {
  start: number;
  end: number;
}

/** The PR's stated intent — what the author says the change is for. */
export interface PrIntent {
  title: string;
  body: string;
}

export interface RepoReader {
  /**
   * Return the file's contents, or just `range` (1-based, inclusive) when given.
   * Resolves to `null` when the file does not exist — never throws on absence.
   */
  readFile(path: string, range?: LineRange): Promise<string | null>;
  /** The PR title + description. */
  getPrIntent(): Promise<PrIntent>;
}

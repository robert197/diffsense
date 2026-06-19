/**
 * Port: per-repo learned conventions — the agent's accumulated `context.md`
 * (docs/ARCHITECTURE.md §5). The review unit reads it (`read_conventions`) to
 * sharpen the next review without shipping code.
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` implements it as one last-write-wins notes row per repo.
 */

/** Repo coordinates a convention note is keyed by. */
export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ConventionStore {
  /** The repo's convention notes, or `null` when none have been written yet. */
  readConventions(repo: RepoRef): Promise<string | null>;
  /** Upsert the repo's convention notes (last write wins). */
  writeConventions(repo: RepoRef, notes: string): Promise<void>;
}

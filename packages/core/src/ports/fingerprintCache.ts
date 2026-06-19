import type { ChunkReview } from "../schemas/chunkReview.js";
import type { RepoRef } from "./conventionStore.js";

/**
 * Port: per-chunk review cache keyed by a structural fingerprint
 * (docs/ARCHITECTURE.md §5). A recurring chunk reuses its stored `ChunkReview`
 * instead of issuing a fresh LLM call — the cost lever that makes inference
 * follow attention, not PR size.
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` implements it. Keyed by `{ owner, repo }` + fingerprint so the same
 * structural change in two repos does not collide.
 */
export interface FingerprintCache {
  /** The cached review for this fingerprint, or `null` on a miss. */
  get(repo: RepoRef, fingerprint: string): Promise<ChunkReview | null>;
  /** Store (or overwrite) the review for this fingerprint. */
  set(repo: RepoRef, fingerprint: string, review: ChunkReview): Promise<void>;
}

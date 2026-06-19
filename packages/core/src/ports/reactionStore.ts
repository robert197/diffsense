import type { ChunkReaction } from "../schemas/reaction.js";

/**
 * Port: persist a reviewer reaction against a chunk's tier.
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` implements it (docs/ARCHITECTURE.md §1, ports & adapters).
 */
export interface ReactionStore {
  record(reaction: ChunkReaction): Promise<void>;
}

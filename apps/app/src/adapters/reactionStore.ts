import type { ChunkReaction, ReactionStore } from "@diffsense/core";
import type { Database } from "../db/client.js";
import { reactions } from "../db/schema.js";

/**
 * Drizzle adapter implementing the `ReactionStore` port (docs/ARCHITECTURE.md
 * §1). `core` owns the port and the `ChunkReaction` shape; this is the only
 * place that knows it is Postgres. Each reaction is an append-only row.
 */
export function createDrizzleReactionStore(db: Database): ReactionStore {
  return {
    async record(reaction: ChunkReaction): Promise<void> {
      await db.insert(reactions).values({
        owner: reaction.owner,
        repo: reaction.repo,
        prNumber: reaction.prNumber,
        fingerprint: reaction.fingerprint,
        tier: reaction.tier,
        sentiment: reaction.sentiment,
      });
    },
  };
}

import { z } from "zod";

/**
 * PR lifecycle status (issue #31). The deterministic, vendor-free domain behind
 * background merge-status sync: the label diffsense persists per PR, and the raw
 * shape it reads back from GitHub.
 *
 * `PrStatusValue` is the single label the dashboard filters on — `open` while the
 * PR is live, `merged`/`closed` once it leaves the active list. `PrLifecycle` is
 * GitHub's own `{ state, merged }` pair as the reader adapter returns it; the pure
 * `derivePrStatus` (in `status/prStatus.ts`) folds the pair into the label.
 */

/** The persisted lifecycle label the dashboard splits active vs. done on. */
export const PrStatusValueSchema = z.enum(["open", "merged", "closed"]);
export type PrStatusValue = z.infer<typeof PrStatusValueSchema>;

/**
 * Live PR lifecycle as read from GitHub: `state` is the PR's open/closed state and
 * `merged` is true only for a closed-and-merged PR. The reader adapter maps the REST
 * response to this shape; `core` never sees Octokit.
 */
export const PrLifecycleSchema = z.object({
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
});
export type PrLifecycle = z.infer<typeof PrLifecycleSchema>;

import type { PrStatusValue } from "../schemas/prStatus.js";
import type { GitHubPrRef } from "./githubGateway.js";

/**
 * The full status write: the PR's coordinates, the installation that can re-read it,
 * and the derived lifecycle label. Used by the webhook update job and by the poll
 * when a PR's status actually changed.
 */
export interface PrStatusRecord extends GitHubPrRef {
  installationId: number;
  status: PrStatusValue;
}

/** The minimal seed an `opened`/`synchronize` review writes: a PR we now track as open. */
export interface PrStatusSeed extends GitHubPrRef {
  installationId: number;
}

/** One row the poll reconciles: a tracked PR plus the installation to re-read it with. */
export interface PrStatusPollRow extends GitHubPrRef {
  installationId: number;
  status: PrStatusValue;
}

/**
 * Port: persist and query per-PR lifecycle status (issue #31).
 *
 * Pure interface — `core` never knows it is Postgres. The Drizzle adapter in
 * `apps/app` owns the `pr_status` table; `apps/web` reads it directly via its own
 * mirror for the dashboard (the same `apps/app`/`apps/web` split `decks` uses).
 *
 * - `recordStatus` upserts the authoritative label (webhook update, poll change).
 * - `seedOpen` tracks a freshly reviewed PR as open without ever clobbering a
 *   terminal `merged`/`closed` status (a late `synchronize` must not resurrect it).
 * - `markSynced` bumps the reconcile timestamp when the poll found no change.
 * - `listOpenForPoll` returns up to `limit` still-open PRs, oldest-synced first —
 *   the bounded batch that keeps the poll within GitHub's rate budget.
 */
export interface PrStatusStore {
  recordStatus(record: PrStatusRecord): Promise<void>;
  seedOpen(ref: PrStatusSeed): Promise<void>;
  markSynced(refs: GitHubPrRef[]): Promise<void>;
  listOpenForPoll(limit: number): Promise<PrStatusPollRow[]>;
}

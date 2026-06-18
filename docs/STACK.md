# diffsense — Tech Stack (canonical)

The locked stack for the MVP. Build on this; don't re-decide per slice. Rationale lives next to each choice.

## Shape

A long-lived TypeScript service receives GitHub PR webhooks, acknowledges fast, and enqueues a review job. A worker runs the review pipeline (structural rank → context assembly → LLM review → adversarial verify → scope-creep → synthesis) and posts results back to the PR thread. A separate Next.js app serves the hosted card view from the shared database.

```
GitHub ──webhook──► Hono endpoint (apps/app) ──enqueue──► BullMQ (Redis)
                                                              │
                                                       review worker
                                                       (packages/core pipeline)
                                                              │
                                              Octokit ◄───────┤──► Postgres (Drizzle)
                                              (PR comment)            │
                                                                 Next.js card view (apps/web)
```

## Choices

| Layer | Choice | Why |
|---|---|---|
| Language / pkg mgr | TypeScript (Node 22), pnpm | Anthropic SDK + Octokit are first-class TS. |
| Repo layout | pnpm monorepo: `packages/core`, `apps/app`, `apps/web` | Pure units (`rankHunks`, `assembleContext`, `reviewChunk`, `verifyFinding`, `detectScopeCreep`, `synthesizePortfolio`) live in `core`, isolated and unit-tested. The integration seam (`handlePullRequestEvent`) and the worker live in `apps/app`. |
| HTTP | Hono | Tiny, fast, typed, runtime-agnostic. |
| GitHub App | Octokit (`octokit`, `@octokit/webhooks`, `@octokit/app`) — not Probot | Full control, clean testability, fits the queue/worker model. |
| Deploy | Railway (or Fly.io), long-lived Node service — not edge/Workers | LLM orchestration runs minutes (Fable 5); edge CPU/duration limits break it. Predictable, local parity. |
| Jobs | BullMQ + Redis (Upstash) | Webhook acks fast and enqueues; worker runs the pipeline durably with retries. Required for minutes-long LLM runs. |
| DB | Postgres (Neon) via Drizzle ORM | Typed, lightweight, first-class migrations. Holds fingerprint cache, findings, reactions, cost records. |
| LLM | `@anthropic-ai/sdk` + Zod (`zodOutputFormat` → structured outputs) | Schema-enforced, falsifiable fields. `claude-opus-4-8` default; `claude-fable-5` for top-risk chunks + synthesis. Adaptive thinking on. |
| Diff parsing | `parse-diff` | Unified-diff hunks, language-agnostic. |
| AST / blast radius | `@ast-grep/napi` | Fast structural code search across languages (call sites, symbols) for context assembly. |
| Hosted card view | Next.js (React) on Vercel, shared Postgres | Best React DX; separate deploy, shared DB. |
| Test / lint | Vitest + Biome | Fast; pure units are trivially unit-testable. |

## Secrets (one-time, not code)

`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `REDIS_URL`.

## Map to issues

- `packages/core` pure units: #2 `rankHunks`, #3 demotion/fallback, #7 `assembleContext`, #8 `reviewChunk` + fingerprint cache, #9 `verifyFinding`, #10 `detectScopeCreep`, #11 `synthesizePortfolio`, #12 `renderComment`.
- `apps/app`: #1 scaffold + `handlePullRequestEvent` + webhook + worker, #12 delivery + cost logging.
- `apps/web`: #13 hosted card view.

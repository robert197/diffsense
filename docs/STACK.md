# diffsense — Tech Stack (canonical)

The locked stack for the MVP. Build on this; don't re-decide per slice. Two hard constraints: **LLM-provider-independent** (Anthropic today, Gemini/OpenAI swappable by config) and **self-hosted via Docker** (no serverless/edge, no managed-PaaS lock-in).

## Shape

A long-lived TypeScript service receives GitHub PR webhooks, acknowledges fast, and enqueues a review job. A worker runs the review pipeline (structural rank → context assembly → LLM review → adversarial verify → scope-creep → synthesis) and posts results back to the PR thread. A Next.js app serves the hosted card view from the shared database. Everything runs as Docker containers on your own server.

```
GitHub ──webhook──► Caddy ──► Hono endpoint (serve) ──enqueue──► Redis / BullMQ
                      │                                              │
                      │                                       review worker
                      │                                       (packages/core pipeline
                      │                                        + LLMProvider adapter)
                      ▼                                              │
              Next.js card view (web) ◄────── Postgres (Drizzle) ◄──┘
                                                                Octokit ──► PR comment
```

## Choices

| Layer | Choice | Why |
|---|---|---|
| Language / pkg mgr | TypeScript (Node 22), pnpm | Octokit + AI SDK are first-class TS. |
| Repo layout | pnpm monorepo: `packages/core`, `packages/llm`, `apps/app`, `apps/web` | Pure units live in `core` (no vendor imports); the LLM adapter is isolated in `llm`; the service + worker in `apps/app`; the card view in `apps/web`. |
| HTTP | Hono | Tiny, fast, typed. |
| GitHub App | Octokit (`octokit`, `@octokit/webhooks`, `@octokit/app`) — not Probot | Full control, clean tests, fits the queue/worker model. |
| Jobs | BullMQ + Redis | Webhook acks fast and enqueues; worker runs the pipeline durably with retries. Required for minutes-long LLM runs. |
| DB | Postgres via Drizzle ORM | Typed, lightweight, first-class migrations. Holds fingerprint cache, findings, reactions, cost records. |
| **LLM** | **Provider-agnostic: `LLMProvider` interface in `core`; adapter in `packages/llm` via the Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`); structured output via Zod + `generateObject`** | Stay independent. `core` never imports a vendor SDK — it depends only on the `LLMProvider` interface. Swap providers by env, not by code change. Zod is the single schema source across providers. |
| Diff parsing | `parse-diff` | Unified-diff hunks, language-agnostic. |
| AST / blast radius | `@ast-grep/napi` | Fast structural code search across languages (call sites, symbols) for context assembly. |
| Hosted card view | Next.js (React), own container, shared Postgres | Best React DX; runs as a container like everything else. |
| Test / lint | Vitest + Biome | Fast; pure units are trivially unit-testable. |
| **Deploy** | **Self-hosted Docker. One multi-stage image run as `serve` / `worker` / `web`; `docker-compose` with app, worker, web, postgres, redis; Caddy reverse proxy for auto-TLS** | Your server, your containers. No serverless/edge (LLM orchestration runs minutes), no managed-PaaS lock-in. `DATABASE_URL` / `REDIS_URL` default to the compose services but accept any external host. |

## LLM provider independence — the rule

- `packages/core` defines `interface LLMProvider { reviewChunk(ctx, schema), verifyFinding(...), synthesize(...) }` — **pure types and Zod schemas only, no `@ai-sdk/*` or `@anthropic-ai/*` import.**
- `packages/llm` implements `LLMProvider` with the Vercel AI SDK: one `generateObject({ model, schema, prompt })` path, the `model` chosen from env.
- **Env drives everything:** `LLM_PROVIDER` (`anthropic` | `openai` | `google`), `REVIEW_MODEL`, `SYNTHESIS_MODEL`. Default `anthropic` with `claude-opus-4-8` (review) and `claude-fable-5` (synthesis). Switching to Gemini/OpenAI is a config change, no recompile of `core`.
- Provider-specific knobs (thinking, effort, safety settings) are set inside the adapter via the AI SDK's provider-options — portability is prioritized over per-provider tuning.

## Docker / self-host

- **One multi-stage `Dockerfile`** builds the monorepo; the container command selects the role: `serve` (Hono ingress), `worker` (BullMQ consumer), `web` (Next.js).
- **`docker-compose.yml`** services: `app` (serve), `worker`, `web`, `postgres` (with a named volume), `redis`, `caddy` (TLS + routing). `.env` supplies all secrets.
- **Migrations** run via a one-shot `drizzle migrate` step on deploy (compose `migrate` profile or entrypoint guard).
- Postgres and Redis run as containers by default; point `DATABASE_URL` / `REDIS_URL` at an external managed host instead if you prefer — no code change.

## Secrets (one-time, not code)

`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `LLM_PROVIDER`, `REVIEW_MODEL`, `SYNTHESIS_MODEL`, the chosen provider's API key (`ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY`), `DATABASE_URL`, `REDIS_URL`.

## Map to issues

- `packages/core` pure units (no vendor imports): #2 `rankHunks`, #3 demotion/fallback, #7 `assembleContext`, #8 `reviewChunk` + fingerprint cache (calls the `LLMProvider` interface), #9 `verifyFinding`, #10 `detectScopeCreep`, #11 `synthesizePortfolio`, #12 `renderComment`.
- `packages/llm`: the `LLMProvider` adapter (AI SDK), introduced in #8.
- `apps/app`: #1 scaffold + `handlePullRequestEvent` + webhook + worker + Docker/compose, #12 delivery + cost logging.
- `apps/web`: #13 hosted card view (own container).

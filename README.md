# diffsense

**Reviewing AI code at AI speed.**

As AI writes more code, review is the bottleneck. diffsense points the reviewer at
the few changes that actually carry risk — fast, advisory, without leaving GitHub.

It ranks every diff hunk in a pull request by structural risk (size, risk-path,
API-boundary crossing, test-delta) and surfaces a "review these first" list, so
finite human attention lands on the changes most likely to hide a defect instead of
being spread evenly across a 1,000-line PR.

## Where things are

- [`STRATEGY.md`](STRATEGY.md) — what the product is, who it serves, how it wins.
- [`docs/STACK.md`](docs/STACK.md) — the locked tech stack.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, ports & adapters, the pipeline.
- [`docs/ideation/`](docs/ideation/) — the candidate directions explored.
- [`docs/brainstorms/`](docs/brainstorms/) — the requirements for the first MVP: an
  8-week risk-ordering validation pilot.

Early-stage. The current goal is to validate one thesis: risk-ordered review finds
more real defects per review-minute than native GitHub order.

## Architecture (at a glance)

TypeScript pnpm monorepo, self-hosted via Docker:

- `packages/core` — pure domain logic + Zod schemas + port interfaces. **No vendor SDK imports.**
- `packages/llm` — provider-agnostic LLM adapter (stub today; AI SDK in #8).
- `apps/app` — Hono webhook ingress · BullMQ queue/worker · pipeline · adapters (Octokit, Drizzle).
- `apps/web` — Next.js reviewer surface: GitHub sign-in + repo/PR picker (#25) and the read-only card view (#13).

A webhook hits the Hono ingress, which verifies the signature and enqueues a job.
A worker consumes it and (this slice) posts a single placeholder comment — the
`handlePullRequestEvent(event, octokit)` seam every later slice plugs into.

## Quickstart (local, Docker)

```bash
cp .env.example .env     # then fill in the GitHub App secrets (see below)
docker compose up        # boots app + worker + postgres + redis (+ web stub)
```

- Ingress: `http://localhost:3000` (`GET /healthz` → `{"ok":true}`, `POST /webhook`).
- Web stub: `http://localhost:3001`.
- Migrations run automatically as a one-shot `migrate` service before app/worker start.

`DATABASE_URL` / `REDIS_URL` default to the compose `postgres`/`redis` services but
accept any external host — point them elsewhere with no code change.

## Local development (without Docker)

```bash
pnpm install
pnpm test          # vitest (the Postgres round-trip test is skipped unless DATABASE_URL is set)
pnpm lint          # biome
pnpm typecheck     # tsc per package

# run the roles directly (needs postgres + redis reachable and .env populated)
pnpm --filter @diffsense/app serve
pnpm --filter @diffsense/app worker
```

## One-time GitHub App registration

Coding does **not** block on this — tests use a recorded webhook fixture, and local
end-to-end uses a [smee.io](https://smee.io) channel. Do this once when you want to
receive real webhooks:

1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.**
2. **Webhook URL:** your public ingress (or a smee.io channel URL for local dev).
   **Webhook secret:** a random string → `GITHUB_WEBHOOK_SECRET`.
3. **Permissions:** Pull requests *Read*, Issues / Pull request comments *Read & write*.
4. **Subscribe to events:** `Pull request`.
5. After creating: note the **App ID** → `GITHUB_APP_ID`; generate a **private key**
   (`.pem`) → `GITHUB_PRIVATE_KEY`.
6. **Install** the App on a repo to start receiving `pull_request` webhooks.

Put all three (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) plus
the infra URLs into `.env` (see [`.env.example`](.env.example)).

## Reviewer sign-in + repo/PR picker (apps/web, #25)

The web app is the reviewer's entry path: sign in with GitHub, pick a repo from the
GitHub App installations you can access, see its open PRs, and click through to the
review view. It uses the **same GitHub App** via its user-authorization (OAuth) flow
— no second app to register:

1. On the GitHub App: enable **Request user authorization (OAuth) during
   installation**, set the **Callback URL** to `${WEB_BASE_URL}/api/auth/callback`
   (e.g. `http://localhost:3001/api/auth/callback`), and **generate a client
   secret**.
2. Put the App's **Client ID** → `GITHUB_OAUTH_CLIENT_ID`, the **client secret** →
   `GITHUB_OAUTH_CLIENT_SECRET`, a random **`SESSION_SECRET`** (encrypts the stored
   GitHub tokens at rest), and your public **`WEB_BASE_URL`** into `.env`.

Sessions persist in the shared Postgres (`web_sessions` table, migration `0006`);
the cookie holds only an opaque token and the GitHub tokens are encrypted at rest.
All secrets come from env — nothing is hard-coded, consistent with the self-host and
provider-independence rules.

Flow: `/login` → GitHub authorize → `/api/auth/callback` → `/repos` (installations +
repos) → `/repos/<owner>/<repo>/pulls` (open PRs) → `/pr/<owner>/<repo>/<number>`
(review view).

### Local webhook delivery via smee

```bash
npx smee-client --url https://smee.io/your-channel --target http://localhost:3000/webhook
```

Set the GitHub App's webhook URL to the same smee channel. Opening a PR on the
installed repo then flows through to a single placeholder comment. Alternatively,
replay the recorded fixture in `apps/app/test/fixtures/` against a running ingress.

---
name: diffsense-e2e
description: >-
  End-to-end test the diffsense app (GitHub login → repo/PR picker → swipe deck
  → findings) against a real, isolated Docker stack, driven by agent-browser
  (Arc/Chrome over CDP) or Playwright. Use when asked to e2e test diffsense,
  browser-test the app, verify the login/repo/PR/deck flow, smoke-test a build,
  or reproduce the OAuth/deck-generation paths. Encodes the non-obvious gotchas
  (GitHub App vs OAuth App, the disabled Authorize button under automation, the
  on-demand /decks trigger, provider limits) so a run does not rediscover them.
---

# diffsense E2E testing

A battle-tested playbook for exercising the **whole** diffsense product surface end
to end: GitHub login → repositories → pull requests → swipe deck → findings, plus
the on-demand pipeline trigger that actually produces findings.

It runs against a **real, isolated Docker stack** (Postgres + Redis + ingress +
worker + web), not mocks, and drives the browser with **agent-browser** (attached
to your logged-in Arc/Chrome over CDP) or **Playwright** (with a saved
authenticated session). Every sharp edge discovered in practice is written down
here so a test run is boring, not an investigation.

> TL;DR: `scripts/up.sh` brings the stack up isolated, you authorize the GitHub
> App **once** by hand (GitHub blocks the Authorize button under automation),
> then `arc-drive.sh` or the Playwright spec walks the flow, and
> `scripts/trigger-deck.sh` generates real findings. `scripts/down.sh` cleans up.

---

## 0. The mental model (read this first)

The app has two halves, and confusing them wastes hours:

1. **Read-model UI** — the pages at `/repos`, `/repos/:o/:r/pulls`,
   `/pr/:o/:r/:n`, `/pr/:o/:r/:n/deck`. These only **display** data already in the
   database. Visiting a PR page does **not** generate anything. "No findings for
   this PR yet" almost always means *nothing has processed that PR*, not a bug.

2. **Pipeline** — the worker (`runReview`/`processPrIntoDeck`) that ranks the diff,
   runs the agentic review unit, verifies, and writes findings + a deck. It is
   triggered by a **GitHub webhook** (`pull_request` opened/synchronize) **or** an
   **on-demand `POST /decks`** call. There is currently **no UI button** to trigger
   it. In a local test the webhook goes to the app's configured smee.io URL, *not*
   your container, so you must use `POST /decks` to get findings.

So a full E2E "findings" test is always: **process a PR via `POST /decks`**, then
**read it back in the UI**.

### Ports & roles

| Role | Container | Port | What it is |
|------|-----------|------|------------|
| `web` | `web` | **3001** | Next.js read-model UI (`next dev -p 3001`) |
| `serve` | `app` | **3000** | Hono ingress: `/webhook`, `/decks`, `/healthz` |
| `worker` | `worker` | — | BullMQ consumer → `runReview` pipeline |
| db | `postgres` | 5432 (internal) | findings, decks, reactions, cost |
| queue | `redis` | 6379 (internal) | BullMQ |

Postgres/Redis are **not** published to the host, so the web app must run inside
the compose network (its `DATABASE_URL`/`REDIS_URL` use service hostnames). Run
the UI in Docker, not via host `pnpm dev`.

---

## 1. Prerequisites & environment

### Why a GitHub **App**, not an OAuth App  (the #1 gotcha)

The repo picker calls `GET /user/installations` to list the GitHub App
installations the user can access. **That endpoint only works with a GitHub App
user-to-server token.** If you wire up a standalone *OAuth App* (Client ID starts
`Ov23…`), login succeeds but `/repos` 500s with:

```
Error: github /user/installations?per_page=100&page=1 returned 403
```

You **must** use the existing **GitHub App**'s OAuth credentials (Client ID starts
`Iv23…`). For diffsense that app is **`diffsense-robert197`** (display name
"diffsense-local", App ID `4094483`).

GitHub App settings → set these:
- **User authorization callback URL** = `http://localhost:3001/api/auth/callback`
- **Client ID** → `GITHUB_OAUTH_CLIENT_ID` (the `Iv23…` value)
- Generate a **client secret** → `GITHUB_OAUTH_CLIENT_SECRET`

### Required env keys (added on top of the repo's base `.env`)

```bash
WEB_BASE_URL=http://localhost:3001
SESSION_SECRET=<openssl rand -hex 32>
GITHUB_OAUTH_CLIENT_ID=Iv23...            # GitHub App client id, NOT Ov23 OAuth app
GITHUB_OAUTH_CLIENT_SECRET=<from the GitHub App>
# LLM — needed only to GENERATE findings (login/repo/PR browsing work without it):
LLM_PROVIDER=anthropic                    # see provider note below
REVIEW_MODEL=claude-opus-4-8
SYNTHESIS_MODEL=claude-fable-5
ANTHROPIC_API_KEY=...
# On-demand deck trigger (off unless set; >=16 chars):
DECK_API_SECRET=<openssl rand -hex 16>
```

### Provider note (the #2 gotcha): **Gemini cannot run the review unit**

The agentic review unit combines **function-calling (tools) + JSON structured
output**. Anthropic and OpenAI support that; **Google/Gemini rejects it**:

```
400 INVALID_ARGUMENT
Function calling with a response mime type: 'application/json' is unsupported
```

Result: the review step errors and **no findings are written** (the UI shows "no
findings"). For findings tests use `LLM_PROVIDER=anthropic` (default) or `openai`.
Gemini is fine for the non-tool single-shot calls but not the deck pipeline — this
is a known provider-agnostic gap worth a backlog issue, not a test failure.

### The web container `.next` permission fix (the #3 gotcha)

The image runs as `USER node`, but `next dev` must `mkdir /app/apps/web/.next`
under root-owned `/app`, so the web container crashes with:

```
EACCES: permission denied, mkdir '/app/apps/web/.next'
```

Fix (test only) — a `docker-compose.override.yml` that runs web as root.
`scripts/up.sh` writes this automatically.

---

## 2. Bring up an isolated stack

**Never test in the primary working tree** — an autonomous loop/agent may be
switching branches there (`gh pr checkout`), which yanks the code out from under
you. Always use a throwaway git worktree on `origin/master` + a named compose
project.

```bash
.claude/skills/diffsense-e2e/scripts/up.sh
# → worktree at ~/diffsense-test, compose project "diffsense-test", web on :3001
```

`up.sh` is idempotent: it creates/refreshes the worktree, copies your base `.env`,
ensures the required keys exist (generating `SESSION_SECRET`/`DECK_API_SECRET`),
writes the web-as-root override, and `docker compose up --build -d`. It prints
which keys you still need to fill (OAuth client id/secret, LLM key).

Verify:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/   # 200
curl -s http://localhost:3000/healthz                              # {"ok":true}
docker compose -p diffsense-test logs web --tail 5                 # "Ready in ..."
```

---

## 3. Authorize the GitHub App **once** (manual — unavoidable)

GitHub keeps the **"Authorize" button disabled until a genuinely focused human
click**. Under CDP automation `document.hasFocus()` is `false`, the enable-timer
is throttled, and the button never enables — and force-clicking the disabled
button submits a *denial* (`error=access_denied`). There is no way around this
from automation.

Do this **once** per environment:
1. In a normal browser, open `http://localhost:3001` → **Sign in with GitHub**.
2. On **"Authorize diffsense-local"**, click **Authorize** (passkey if asked).

After this first consent, the GitHub App is authorized for your user, and **every
later `/login` auto-redirects** `authorize → /api/auth/callback → /repos` with **no
button** — which automation handles fine.

> Stale-session trap: if `/repos` 403s right after switching OAuth credentials,
> you're on an old session cookie. Hit `/logout`, then `/login` again for a fresh
> token.

---

## 4a. Drive it with agent-browser (Arc over CDP)

Attach to your **already-logged-in Arc** so GitHub auth is reused — no separate
login. Arc must run with a debug port (it usually already does):

```bash
# Arc launched with --remote-debugging-port=9222 (relaunch if not):
#   open -na "Arc" --args --remote-debugging-port=9222
curl -s http://localhost:9222/json/version | grep -q Chrome && agent-browser connect 9222
```

Then walk the happy path (see `scripts/arc-drive.sh` for the full version):

```bash
agent-browser open http://localhost:3001/login         # auto-redirects to /repos if authorized
agent-browser get url                                   # expect .../repos
agent-browser snapshot -i -u                            # see repo links
agent-browser open http://localhost:3001/repos/robert197/diffsense/pulls
agent-browser snapshot -i -u                            # PR list (#N links)
agent-browser open http://localhost:3001/pr/robert197/diffsense/<N>/deck
agent-browser snapshot -i                               # deck cards (after processing)
```

Snapshot refs (`@eN`) are **fresh per snapshot** — re-snapshot after every
navigation. Use the DOM (`agent-browser eval`) for state checks like
`button.disabled`; the a11y tree can lag.

## 4b. Drive it with Playwright

For repeatable CI-style runs, use the spec in `playwright/`. Because the Authorize
gate can't be automated, Playwright reuses a **saved authenticated session**
(`storageState`) captured once. See `playwright/README.md`:

```bash
# one-time: capture an authenticated session after you log in manually
npx playwright open --save-storage=auth.json http://localhost:3001
# then run the suite
npx playwright test -c .claude/skills/diffsense-e2e/playwright/playwright.config.ts
```

The spec asserts: `/` shows "Sign in with GitHub"; an authed session lands on
`/repos`; the repo and PR lists render; a processed PR shows a deck/findings; an
unprocessed PR shows the empty state. `add-repos.spec.ts` additionally asserts the
Add Repositories modal flow (see §4c).

## 4c. Add Repositories / organisation-sync flow

The repo picker lets a reviewer **sync an organisation's repos** — including private
ones — by installing the GitHub App on the org. "Syncing" *is* installing: a GitHub
App user token can't list an org's repos until the App is installed there. The modal
is the browse-and-route surface (`AddRepositoriesModal.tsx`): it lists installed
accounts with their repos, and renders role-aware **Install** / **Request access**
cards for orgs without diffsense yet. After the reviewer approves on GitHub (new tab)
and returns, the modal **refreshes on tab refocus** so the just-synced org appears
without a manual reopen; a **Refresh** button is the fallback when focus events don't
fire.

Drive it against a real org (default `devs-group`) with agent-browser on Arc:

```bash
ORG=devs-group .claude/skills/diffsense-e2e/scripts/arc-drive-add-repos.sh
```

It asserts: the "Add repositories" button is on `/repos`; the modal opens and lists
installed groups and/or installable targets; the target org is **syncable** — either
already installed (with a private repo row visible) *or* offered as an Install/Request
target; and the Refresh affordance is present. The org assertion is **role-agnostic** —
admins see *Install*, members see *Request access*, and an already-installed org shows
its repos; all three are valid "can be synced" outcomes. If `devs-group` isn't
reachable yet (no membership accepted, or `/user/memberships/orgs` unreadable for the
App token), the run emits a guiding **note** rather than a hard fail.

The same flow runs headlessly in Playwright via `add-repos.spec.ts` (reuses the saved
`storageState`):

```bash
STORAGE_STATE=auth.json npx playwright test \
  -c .claude/skills/diffsense-e2e/playwright/playwright.config.ts \
  --project=desktop-authed add-repos.spec.ts
```

> Reminder (SKILL.md §3): GitHub's **Authorize** button can't be clicked under
> automation, and neither can the App's own install/approve screen. These tests
> assert the diffsense-side modal and routing; the actual GitHub grant is the one
> manual step. To exercise the post-sync state, install the App on the org by hand
> once, then re-run — the org moves from a target to an installed group.

---

## 4d. Pulls list sync

The repo pulls page (`/repos/<owner>/<repo>/pulls`) keeps its open-PR list **synced**
while the reviewer has it open. The server does the first paint; `PullsList.tsx` (a
client island) then re-fetches through the `loadOpenPullRequests` server action — so
only the PR array crosses the wire, not a whole page re-render. It **refreshes on tab
refocus** (throttled, so rapid tab toggles don't storm GitHub), exposes a manual
**Refresh** button + a "Synced …" freshness status, and flags PRs that are **New** or
**Updated** since the last sync. Merged/closed PRs simply drop out.

Drive it against a repo with private PRs (default `devs-group/core-gent`) with
agent-browser on Arc:

```bash
OWNER=devs-group REPO=core-gent .claude/skills/diffsense-e2e/scripts/arc-drive-pulls-sync.sh
```

It asserts: the pulls page renders for the repo; the open-PR list shows (rows **or**
the empty state — both valid); the "Synced …" status and the Refresh affordance are
present; a manual Refresh re-syncs **in place** (a `window` tag survives the click, so
no full-page reload); and the list stays healthy after a simulated tab refocus. A repo
with zero open PRs surfaces a guiding **note** rather than a hard fail.

The same flow runs headlessly in Playwright via `pulls-sync.spec.ts`:

```bash
OWNER=devs-group REPO=core-gent STORAGE_STATE=auth.json npx playwright test \
  -c .claude/skills/diffsense-e2e/playwright/playwright.config.ts \
  --project=desktop-authed pulls-sync.spec.ts
```

It strictly asserts the structure (header, list-or-empty, synced status, Refresh) and
the no-full-reload contract; PR contents are not asserted, since the open-PR set
changes over time.

---

## 5. Generate real findings (on-demand `POST /decks`)

Findings only exist after the pipeline runs. Trigger it:

```bash
.claude/skills/diffsense-e2e/scripts/trigger-deck.sh <prNumber>
# → POSTs to :3000/decks with the bearer secret + installationId, polls the worker
```

Under the hood:
```bash
curl -s -X POST http://localhost:3000/decks \
  -H "Authorization: Bearer $DECK_API_SECRET" -H 'Content-Type: application/json' \
  -d '{"owner":"robert197","repo":"diffsense","prNumber":<N>,"installationId":<INSTALL_ID>}'
# → {"accepted":true} 202, then the worker runs the Gemini/Anthropic pipeline
```

Gotchas:
- `404 {"error":"decks trigger not enabled"}` → `DECK_API_SECRET` isn't set in the
  app container's env (restart `app` + `worker` after editing `.env`).
- `401` → wrong/missing bearer.
- **installationId** is required and `gh` (a PAT) **cannot** list it
  (`/user/installations` → 403). Get it from the UI: `https://github.com/settings/installations`
  → the **Configure** link next to **diffsense-local** → the id in
  `/settings/installations/<id>`. For this account it is **141322577**.

To exercise findings meaningfully, open a PR with *real* risk (not a README tweak).
`scripts/make-risky-pr.sh` opens a disposable PR containing an obvious SQL-injection
+ hardcoded secret + open-redirect so the reviewer has something to flag.

Watch it:
```bash
docker compose -p diffsense-test logs -f worker      # pipeline progress / LLM calls
```
Then re-read `/pr/.../deck` and `/pr/.../<N>` in the browser.

---

## 6. What "passing" looks like

- `GET /` → 200, shows **diffsense** + "Sign in with GitHub".
- Authed `/login` → redirects to **`/repos`** (no Authorize button).
- `/repos` → 200, lists installations/repos (**no** `/user/installations 403` in
  web logs).
- `/repos/:o/:r/pulls` → 200, lists open PRs; a freshly opened PR appears.
- `POST /decks` → `202 {"accepted":true}`; worker logs show a completed run.
- `/pr/:o/:r/:n` → renders finding cards; `/deck` → swipeable cards with risk
  score, highlighted lines, plain-language explanation.
- An unprocessed PR → graceful empty state ("No findings… yet").

---

## 7. Cleanup (always)

```bash
.claude/skills/diffsense-e2e/scripts/down.sh
# closes disposable test PRs, deletes their branches, `compose down -v`,
# removes the ~/diffsense-test worktree
```

Leave no orphans: disposable PRs (`test/*`), their remote branches, the worktree,
and the named compose stack with its volume.

---

## 8. Gotcha index (quick reference)

| Symptom | Cause | Fix |
|---|---|---|
| `/repos` 500, `/user/installations 403` | Using an OAuth App (`Ov23…`) not the GitHub App (`Iv23…`) | Use the GitHub App's OAuth client id/secret + its user callback URL |
| `/repos` 403 right after changing creds | Stale session cookie | `/logout` then `/login` |
| Authorize button never enables in automation | GitHub gates it on a focused human click (`document.hasFocus()` false under CDP) | Authorize once by hand; later logins auto-redirect |
| Web container crashes `EACCES … .next` | Image runs `USER node`, `/app` root-owned | `docker-compose.override.yml` → web `user: "root"` (in `up.sh`) |
| Deck job: `Function calling with a response mime type 'application/json' is unsupported` | Gemini can't do tools + JSON output | Use `LLM_PROVIDER=anthropic` or `openai` for findings |
| `POST /decks` → 404 | `DECK_API_SECRET` unset in app env | set it, restart `app`+`worker` |
| `POST /decks` → 400 invalid | wrong body / missing `installationId` | body `{owner,repo,prNumber,installationId}` |
| Can't get installationId via `gh` | PAT can't list app installations | read it from `/settings/installations/<id>` (here: 141322577) |
| "No findings" on a PR page | Pipeline never processed it (read-model only) | `trigger-deck.sh <N>` then re-read |
| Stack flaky in main repo | a loop/agent is switching branches in the working tree | always test in the isolated worktree (`up.sh`) |
```


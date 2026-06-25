# diffsense Playwright suite

CI-style E2E for the diffsense app. Public pages run anonymously; the authed flow
reuses a **saved GitHub session**, because GitHub's "Authorize" button cannot be
clicked under automation (it gates on a focused human click — see SKILL.md §3).

## Prereqs

- Stack up and reachable at `BASE_URL` (default `http://localhost:3001`) — use
  `../scripts/up.sh`.
- The GitHub App authorized once by hand for your user.
- `npm i -D @playwright/test && npx playwright install chromium`.

## 1. Capture an authenticated session (once)

```bash
# Opens a real browser; log in + authorize the GitHub App, then close the window.
npx playwright open --save-storage=auth.json http://localhost:3001/login
```

This writes `auth.json` (cookies/localStorage). Re-capture if the session expires.

## 2. Run

```bash
# public pages only (no auth):
npx playwright test -c playwright.config.ts --project=public

# full authed flow on mobile + desktop (includes the Add Repositories modal flow):
STORAGE_STATE=auth.json npx playwright test -c playwright.config.ts \
  --project=mobile-authed --project=desktop-authed

# just the Add Repositories / org-sync modal flow (see SKILL.md §4c):
ORG=devs-group STORAGE_STATE=auth.json npx playwright test -c playwright.config.ts \
  --project=desktop-authed add-repos.spec.ts

# just the pulls-list sync flow (see SKILL.md §4d):
OWNER=devs-group REPO=core-gent STORAGE_STATE=auth.json npx playwright test -c playwright.config.ts \
  --project=desktop-authed pulls-sync.spec.ts

# assert findings render (process a PR first via ../scripts/trigger-deck.sh):
PROCESSED_PR=38 EMPTY_PR=37 STORAGE_STATE=auth.json \
  npx playwright test -c playwright.config.ts --project=mobile-authed
```

## Env knobs

| Var | Default | Meaning |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:3001` | app under test |
| `STORAGE_STATE` | `auth.json` | saved session for authed projects |
| `OWNER`/`REPO` | `robert197`/`diffsense` | target repo |
| `ORG` | `devs-group` | org expected to be syncable in `add-repos.spec.ts` (soft-checked) |
| `PROCESSED_PR` | — | PR already run through the pipeline (asserts findings) |
| `EMPTY_PR` | — | PR not processed (asserts empty state) |

## Notes

- The product is mobile-first; the default authed projects emulate iPhone 14 and
  Desktop Chrome so both are covered.
- Findings are produced by the pipeline, not by viewing a page. To make
  `PROCESSED_PR` meaningful, run `../scripts/make-risky-pr.sh` then
  `../scripts/trigger-deck.sh <prNumber>` before the suite.
- Provider caveat: deck generation needs `LLM_PROVIDER=anthropic|openai`. Gemini
  fails the agentic review step (tools + JSON output unsupported).

---
name: diffsense-review
description: >-
  Run a diffsense PR review from the command line and act on the structured
  result. Use when asked to review a pull request with diffsense, risk-rank a
  PR's changes, get the diffsense deck/findings for a PR as JSON, or review a PR
  without the web UI. Wraps the `diffsense review <pr-ref>` CLI, which runs the
  same on-demand pipeline as the hosted card view (structural rank → optional
  agentic review → ordered Deck of cards → advisory ranked PR comment) over the
  same Postgres stores, then emits the ordered deck and per-chunk findings as
  machine-readable JSON with meaningful exit codes. This is the agent-native
  surface: anything the reviewer can do in the UI, an agent can do here.
---

# diffsense review (agent CLI)

`diffsense review <pr-ref>` runs a full diffsense review on a pull request and prints
the ordered **deck of risk cards** and per-chunk **findings** as a single JSON object on
stdout. It reuses the engine and stores directly — the same `handlePullRequestEvent`
seam, the same deck/finding Drizzle stores — so it is not a re-implementation: it *is*
the pipeline, run from a terminal instead of a webhook or the web app.

> Mental model: this command **does real work**. It fetches the PR diff, ranks the hunks,
> runs the agentic review pass when an LLM is configured, persists the deck + findings to
> Postgres, and upserts the single advisory ranked comment on the PR (idempotent — it
> edits its own comment in place, never spams). It is advisory, never merge-gating.

---

## When to use this

- "Review PR #123 in owner/repo with diffsense."
- "Which changes in this PR are risky? Give me the diffsense deck."
- "Run diffsense on https://github.com/owner/repo/pull/45 and summarize the top card."
- Any time you want diffsense's risk-ordered output as structured data to act on
  (triage, summarize, decide where to look first), without opening the web UI.

---

## Command

From the repo root (any cwd works for the `bin/` form):

```bash
bin/diffsense review <pr-ref> [--installation-id <n>]
# or, via pnpm:
pnpm -C apps/app cli review <pr-ref> [--installation-id <n>]
# or, from the repo root:
pnpm diffsense review <pr-ref>
```

`<pr-ref>` accepts any of:

- `owner/repo#123`
- `owner/repo/123`
- `https://github.com/owner/repo/pull/123` (a trailing `/files`, query, or `#hash` is fine)

`--installation-id <n>` (optional) names the GitHub App installation hosting the repo.
Omit it and the CLI resolves it from the repo automatically. It can also be set via
`GITHUB_INSTALLATION_ID`; the flag wins.

---

## Configuration (env or flags)

Required:

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | diffsense GitHub App id (auth) |
| `GITHUB_PRIVATE_KEY` | GitHub App private key, PEM |
| `DATABASE_URL` | Postgres holding the deck/finding stores (self-hosted) |

Optional:

| Variable | Effect |
|---|---|
| `GITHUB_INSTALLATION_ID` | Skip the repo→installation lookup (or use `--installation-id`) |
| `LLM_PROVIDER` | `anthropic` (default) \| `openai` \| `google` — picks the provider |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | The chosen provider's key. **If none is set, the review still runs** — the deterministic deck is produced and emitted, just without the agentic per-chunk findings (`"llm": false`). |
| `REVIEW_MODEL` / `SYNTHESIS_MODEL` | Override model ids (defaults: `claude-opus-4-8` / `claude-fable-5`) |
| `PUBLIC_BASE_URL` | Adds 👍/👎 reaction links to the ranked comment |
| `WEB_BASE_URL` | Adds the "view cards" link to the ranked comment |

Provider independence and self-host are honored: the provider/model come from env, and
the command runs in-process against your own Postgres — it needs no Redis and no running
server.

---

## Output (stdout JSON)

stdout carries **only** the JSON object (diagnostics go to stderr), so it pipes cleanly
to `jq`. Shape:

```jsonc
{
  "pr": { "owner": "octo-org", "repo": "demo", "prNumber": 42 },
  "headSha": "abc123…",            // PR head the deck/findings are keyed to (null if unresolved)
  "comment": { "action": "created", "commentId": 999 },  // the advisory ranked comment upsert
  "deck": {                         // the ordered deck (null if head unresolved / no deck stored)
    "owner": "octo-org", "repo": "demo", "prNumber": 42, "headSha": "abc123…",
    "cards": [                      // ordered: rank 0 = highest structural risk, review first
      {
        "fingerprint": "…",
        "file": "src/auth.ts",
        "tier": "High",             // High | Medium | Low
        "rank": 0,
        "riskScore": 9.5,
        "highlights": [             // line ranges to scrutinize
          { "side": "R", "start": 2, "end": 2 }   // side R = added/new, L = removed/old
        ],
        "suggestions": ["check token expiry"],     // "what could be wrong"
        "explanation": "Adds a token check."        // plain-language summary
      }
    ]
  },
  "findings": [                     // per-chunk agentic findings (empty when "llm" is false)
    {
      "file": "src/auth.ts", "fingerprint": "…", "tier": "High", "rank": 0,
      "explanation": "…",
      "claims": [{ "claim": "token may be null", "evidence": "src/auth.ts:2" }],
      "reasons": ["auth-sensitive"],
      "blastRadius": ["src/login.ts:10 login()"]
    }
  ],
  "llm": true                       // whether the agentic review pass ran
}
```

How to act on it: review **`deck.cards` in order** — `rank` ascending is highest risk
first. For each card, the `highlights` tell you which lines to read, `suggestions` and the
matching `findings[]` entry (joined by `fingerprint`) say what to look for, and
`explanation` is the human summary. `claims[].evidence` and `blastRadius` ground each
finding to specific code.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Review ran; JSON emitted on stdout |
| `1` | Unexpected runtime error |
| `2` | Usage error — missing/unparseable `<pr-ref>`, unknown flag |
| `3` | Configuration error — missing/invalid creds or `DATABASE_URL` |
| `4` | GitHub access — PR/repo not found or forbidden (404/403); often means the App isn't installed on the repo |

Script accordingly: treat `0` as success, branch on the rest.

---

## Worked example

```bash
# Review a PR and pull the single highest-risk card to act on.
out=$(bin/diffsense review octo-org/demo#42) || { echo "review failed: $?" >&2; exit 1; }
echo "$out" | jq '{
  top: (.deck.cards[0] | { file, tier, riskScore, explanation, suggestions }),
  ran_llm: .llm,
  comment: .comment.commentId
}'
```

```bash
# List every High-tier card, highest risk first.
bin/diffsense review https://github.com/octo-org/demo/pull/42 \
  | jq -r '.deck.cards[] | select(.tier=="High") | "\(.rank)\t\(.file)\t\(.explanation)"'
```

---

## Notes & gotchas

- **It posts a comment.** Every run upserts diffsense's one advisory ranked comment on the
  PR (created on first run, edited in place after) — this is part of "the same pipeline,"
  not a separate action. There is no dry-run mode in this slice.
- **No LLM key ≠ failure.** Without a provider key you still get a full ranked deck; only
  the agentic `findings` (and `claims`/`blastRadius`) are absent and `"llm": false`.
- **`deck` can be `null`** if the PR head SHA could not be resolved (e.g. transient GitHub
  error) — the ranked comment still ships; re-run to get the deck.
- **Self-host:** point `DATABASE_URL` at your Postgres. The CLI bypasses the queue, so no
  Redis is needed for a one-off review.

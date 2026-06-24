#!/usr/bin/env bash
# Drive the diffsense happy path with agent-browser attached to your logged-in
# Arc (over CDP). Reuses your GitHub session, so login auto-redirects — PROVIDED
# you have authorized the GitHub App once by hand (SKILL.md §3).
#
# Usage: arc-drive.sh [prNumber]
# Env:   BASE (default http://localhost:3001), CDP_PORT (default 9222),
#        OWNER/REPO (default robert197/diffsense)
set -uo pipefail

BASE="${BASE:-http://localhost:3001}"
CDP_PORT="${CDP_PORT:-9222}"
OWNER="${OWNER:-robert197}"
REPO="${REPO:-diffsense}"
PR="${1:-}"

ab() { agent-browser "$@"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; }

command -v agent-browser >/dev/null || { echo "agent-browser not installed (npm i -g agent-browser && agent-browser install)"; exit 1; }

# 1) Attach to Arc. If the debug port is down, tell the operator how to relaunch.
if ! curl -s --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Chrome; then
  echo "No CDP on :$CDP_PORT. Relaunch Arc with: open -na \"Arc\" --args --remote-debugging-port=$CDP_PORT"
  exit 1
fi
ab connect "$CDP_PORT" >/dev/null 2>&1
echo "[arc] connected on :$CDP_PORT"

# 2) Home page
ab open "$BASE/" >/dev/null 2>&1; sleep 1
title=$(ab get title 2>/dev/null)
[ "$title" = "diffsense" ] && pass "home loads ($title)" || fail "home title='$title'"

# 3) Login → should auto-redirect to /repos (app already authorized)
ab open "$BASE/login" >/dev/null 2>&1; sleep 3
url=$(ab get url 2>/dev/null)
case "$url" in
  *"/repos"*) pass "login auto-redirected to /repos" ;;
  *github.com/login/oauth/authorize*) fail "stuck on GitHub Authorize — authorize the app once by hand (SKILL.md §3)"; exit 1 ;;
  *) fail "login landed on: $url" ;;
esac

# 4) Repo list
ab open "$BASE/repos" >/dev/null 2>&1; sleep 2
if ab snapshot -i -u 2>/dev/null | grep -qi "$OWNER/$REPO"; then pass "repo list shows $OWNER/$REPO"; else fail "repo $OWNER/$REPO not listed (check /user/installations 403)"; fi

# 5) PR list
ab open "$BASE/repos/$OWNER/$REPO/pulls" >/dev/null 2>&1; sleep 2
prs=$(ab snapshot -i -u 2>/dev/null | grep -ciE '/pr/'"$OWNER"'/'"$REPO"'/[0-9]+')
[ "$prs" -gt 0 ] && pass "PR list rendered ($prs PR link(s))" || echo "  note: no open PRs listed (open one with make-risky-pr.sh)"

# 6) Deck / findings for a specific PR.
#    NOTE: the empty-state ("No findings… yet" / "isn't ready") is a <p>, so we
#    must read page TEXT, not `snapshot -i` (interactive elements only) — else the
#    empty state is invisible and findings look present when they aren't.
if [ -n "$PR" ]; then
  ab open "$BASE/pr/$OWNER/$REPO/$PR" >/dev/null 2>&1; sleep 2
  body=$(ab get text body 2>/dev/null)
  if echo "$body" | grep -qiE 'no findings'; then
    echo "  note: PR #$PR has no findings yet — run trigger-deck.sh $PR (use anthropic/openai, not gemini)"
  elif echo "$body" | grep -qiE 'finding|risk|claim'; then
    pass "PR #$PR shows findings"
  else
    echo "  note: PR #$PR — could not classify (check manually)"
  fi
  ab open "$BASE/pr/$OWNER/$REPO/$PR/deck" >/dev/null 2>&1; sleep 2
  if ab get text body 2>/dev/null | grep -qiE "isn't ready|not ready|no deck"; then
    echo "  note: deck not generated yet for #$PR (trigger-deck.sh $PR)"
  else
    pass "deck route renders cards for #$PR"
  fi
fi
echo "[arc] done."

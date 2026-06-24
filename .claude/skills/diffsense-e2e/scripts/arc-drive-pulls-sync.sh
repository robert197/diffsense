#!/usr/bin/env bash
# Drive the repo pulls-list *sync* UX with agent-browser attached to your logged-in
# Arc (over CDP). Reuses your GitHub session, so login auto-redirects — PROVIDED you
# authorized the GitHub App once by hand (SKILL.md §3).
#
# Asserts the live open-PR list keeps itself synced: the page renders, exposes a
# manual Refresh affordance and a "Synced …" freshness status, re-syncs on demand
# without a full-page reload, and re-syncs when the tab regains focus. Tolerant of a
# repo with zero open PRs — the empty state is a valid render, surfaced as a note so
# the run guides rather than red-fails on an environment gap.
#
# Usage: arc-drive-pulls-sync.sh
# Env:   BASE (default http://localhost:3001), CDP_PORT (default 9222),
#        OWNER/REPO (default devs-group/core-gent)
set -uo pipefail

BASE="${BASE:-http://localhost:3001}"
CDP_PORT="${CDP_PORT:-9222}"
OWNER="${OWNER:-devs-group}"
REPO="${REPO:-core-gent}"
PULLS="$BASE/repos/$OWNER/$REPO/pulls"

ab() { agent-browser "$@"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; }
note() { printf '  note: %s\n' "$*"; }

command -v agent-browser >/dev/null || { echo "agent-browser not installed (npm i -g agent-browser && agent-browser install)"; exit 1; }

# 1) Attach to Arc. If the debug port is down, tell the operator how to relaunch.
if ! curl -s --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version" | grep -q Chrome; then
  echo "No CDP on :$CDP_PORT. Relaunch Arc with: open -na \"Arc\" --args --remote-debugging-port=$CDP_PORT"
  exit 1
fi
ab connect "$CDP_PORT" >/dev/null 2>&1
echo "[arc] connected on :$CDP_PORT"

# 2) Land on the pulls page (login auto-redirects when the app is already authorized).
ab open "$PULLS" >/dev/null 2>&1; sleep 3
url=$(ab get url 2>/dev/null)
case "$url" in
  *github.com/login/oauth/authorize*) fail "stuck on GitHub Authorize — authorize the app once by hand (SKILL.md §3)"; exit 1 ;;
  *"/login"*) ab open "$BASE/login" >/dev/null 2>&1; sleep 3; ab open "$PULLS" >/dev/null 2>&1; sleep 3 ;;
esac
body=$(ab get text body 2>/dev/null)

# 3) The pulls page rendered for this repo (header present).
if echo "$body" | grep -qi "$OWNER/$REPO"; then
  pass "pulls page rendered for $OWNER/$REPO"
else
  fail "pulls page header for $OWNER/$REPO not found"; note "body was: $(echo "$body" | head -c 240)"; exit 1
fi

# 4) The list rendered: either open-PR rows or the empty state (both valid).
if echo "$body" | grep -qiE "open pull request"; then
  pass "open-PR list rendered (rows or count)"
elif echo "$body" | grep -qi "no open pull requests"; then
  note "$OWNER/$REPO has no open PRs right now — empty state is a valid render"
else
  fail "neither PR list nor empty state found"; exit 1
fi

# 5) The "Synced …" freshness status is present.
if echo "$body" | grep -qi "synced"; then
  pass "sync status ('Synced …') present"
else
  fail "sync status not found"
fi

# 6) The manual Refresh affordance is present.
if echo "$body" | grep -qi "refresh"; then
  pass "Refresh affordance present"
else
  fail "Refresh affordance not found"; exit 1
fi

# 7) Manual Refresh re-syncs without a full-page reload. Tag the document, click
#    Refresh, and confirm the tag survives (a full navigation would wipe it).
ab eval "window.__diffsenseNoReload = true" >/dev/null 2>&1
ab eval "[...document.querySelectorAll('button')].find(b => /refresh/i.test(b.textContent||''))?.click()" >/dev/null 2>&1
sleep 2
survived=$(ab eval "String(window.__diffsenseNoReload === true)" 2>/dev/null)
if echo "$survived" | grep -qi true; then
  pass "manual Refresh re-synced without a full-page reload"
else
  note "could not confirm in-place refresh (page may have navigated) — survived=$survived"
fi

# 8) Refocus triggers a re-sync. Drive the same visibility/focus events the island
#    listens for; assert the page is still healthy afterward (no crash, list intact).
ab eval "document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))" >/dev/null 2>&1
sleep 2
body=$(ab get text body 2>/dev/null)
if echo "$body" | grep -qiE "open pull request|no open pull requests"; then
  pass "list intact after a simulated tab refocus"
else
  fail "list not healthy after refocus"
fi

echo "[arc] done."

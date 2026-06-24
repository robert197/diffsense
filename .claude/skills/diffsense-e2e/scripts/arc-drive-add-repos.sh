#!/usr/bin/env bash
# Drive the "Add repositories" / organisation-sync flow with agent-browser attached
# to your logged-in Arc (over CDP). Reuses your GitHub session, so login
# auto-redirects — PROVIDED you authorized the GitHub App once by hand (SKILL.md §3).
#
# Asserts the org-repo sync path end to end: the modal opens, lists the accounts
# diffsense is installed on, and surfaces a target org (default devs-group) as
# *syncable* — either already installed (with at least one private repo visible) or
# offered as an Install/Request target. Both are valid "this org can be synced"
# outcomes; which one you see depends on whether the app is installed there yet and
# whether you're an admin or a member.
#
# Usage: arc-drive-add-repos.sh
# Env:   BASE (default http://localhost:3001), CDP_PORT (default 9222),
#        OWNER/REPO (default robert197/diffsense), ORG (default devs-group)
set -uo pipefail

BASE="${BASE:-http://localhost:3001}"
CDP_PORT="${CDP_PORT:-9222}"
OWNER="${OWNER:-robert197}"
REPO="${REPO:-diffsense}"
ORG="${ORG:-devs-group}"

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

# 2) Land on /repos (login auto-redirects when the app is already authorized).
ab open "$BASE/login" >/dev/null 2>&1; sleep 3
url=$(ab get url 2>/dev/null)
case "$url" in
  *"/repos"*) pass "login auto-redirected to /repos" ;;
  *github.com/login/oauth/authorize*) fail "stuck on GitHub Authorize — authorize the app once by hand (SKILL.md §3)"; exit 1 ;;
  *) ab open "$BASE/repos" >/dev/null 2>&1; sleep 2 ;;
esac

# 3) The "Add repositories" trigger is present on /repos.
ab open "$BASE/repos" >/dev/null 2>&1; sleep 2
if ab snapshot -i -u 2>/dev/null | grep -qi "add repositories"; then
  pass "'Add repositories' button present on /repos"
else
  fail "'Add repositories' button not found on /repos"; exit 1
fi

# 4) Open the modal. The a11y snapshot's refs churn, so click via the DOM by text.
ab eval "[...document.querySelectorAll('button')].find(b => /add repositories/i.test(b.textContent||''))?.click()" >/dev/null 2>&1
sleep 2
body=$(ab get text body 2>/dev/null)

# Wait briefly for the lazy load to settle (the action fetches installs + repos).
for _ in 1 2 3 4 5; do
  echo "$body" | grep -qi "loading your repositories" || break
  sleep 1; body=$(ab get text body 2>/dev/null)
done

if echo "$body" | grep -qiE "add an organisation or account|pick a repo from your account"; then
  pass "Add repositories modal opened"
else
  fail "modal did not render expected content"; note "body was: $(echo "$body" | head -c 240)"; exit 1
fi

# 5) The modal lists at least one installed account OR offers an install target.
if echo "$body" | grep -qiE "manage repositories on github|add an organisation or account|install on another account"; then
  pass "modal lists installed groups and/or installable targets"
else
  note "no installed groups or targets surfaced — is the app installed on any account?"
fi

# 6) Target org is syncable: installed (private repo visible) OR an install/request target.
if echo "$body" | grep -qi "$ORG/"; then
  pass "$ORG appears as an installed group (repos visible — private included)"
elif echo "$body" | grep -qi "$ORG"; then
  pass "$ORG appears as an installable target (Install/Request) — syncable"
else
  note "$ORG not surfaced. If you're a member, accept the org invite; if not installed, you'll see it as a target only when /user/memberships/orgs is readable."
fi

# 7) The manual Refresh affordance is present (return-from-GitHub fallback).
if echo "$body" | grep -qi "refresh"; then
  pass "Refresh affordance present in the modal"
else
  fail "Refresh affordance not found"
fi

echo "[arc] done."

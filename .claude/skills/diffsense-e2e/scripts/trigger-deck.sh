#!/usr/bin/env bash
# Trigger on-demand pipeline processing for a PR, then tail the worker until it
# lands. This is the ONLY way to get findings locally (the GitHub webhook goes to
# the app's smee.io URL, not your container, and there is no UI button).
#
# Usage: trigger-deck.sh <prNumber> [owner] [repo]
#
# Env:
#   PROJECT        (default: diffsense-test)
#   WORKTREE       (default: ~/diffsense-test) — read .env for DECK_API_SECRET
#   INSTALLATION_ID(default: 141322577 — diffsense-local on robert197)
#   APP_URL        (default: http://localhost:3000)
set -euo pipefail

PRNUM="${1:?usage: trigger-deck.sh <prNumber> [owner] [repo]}"
OWNER="${2:-robert197}"
REPO="${3:-diffsense}"
PROJECT="${PROJECT:-diffsense-test}"
WORKTREE="${WORKTREE:-$HOME/diffsense-test}"
APP_URL="${APP_URL:-http://localhost:3000}"
INSTALLATION_ID="${INSTALLATION_ID:-141322577}"

SECRET=$(grep -E '^DECK_API_SECRET=' "$WORKTREE/.env" | head -1 | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "DECK_API_SECRET not set in $WORKTREE/.env (set it, then: docker compose -p $PROJECT up -d app worker)"; exit 1; }

echo "[deck] POST $APP_URL/decks  pr=#$PRNUM  install=$INSTALLATION_ID"
resp=$(curl -s -w '\n%{http_code}' -X POST "$APP_URL/decks" \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d "{\"owner\":\"$OWNER\",\"repo\":\"$REPO\",\"prNumber\":$PRNUM,\"installationId\":$INSTALLATION_ID}")
body=$(echo "$resp" | sed '$d'); code=$(echo "$resp" | tail -1)
echo "[deck] HTTP $code  $body"
case "$code" in
  202) echo "[deck] accepted — worker is processing";;
  404) echo "[deck] endpoint disabled: set DECK_API_SECRET in app env and restart (docker compose -p $PROJECT up -d app worker)"; exit 1;;
  401) echo "[deck] unauthorized: DECK_API_SECRET in .env != the running app's"; exit 1;;
  *)   echo "[deck] unexpected — check body above"; exit 1;;
esac

echo "[deck] tailing worker (Ctrl-C to stop)…"
( cd "$WORKTREE" && docker compose -p "$PROJECT" logs -f worker --since 10s ) &
TAIL=$!
# Stop tailing once the run looks done or after a timeout.
for _ in $(seq 1 60); do
  sleep 5
  if ( cd "$WORKTREE" && docker compose -p "$PROJECT" logs worker --tail 40 2>/dev/null ) \
       | grep -qiE 'deck (written|stored|complete)|review complete|findings (written|stored)|INVALID_ARGUMENT|error'; then
    break
  fi
done
kill "$TAIL" 2>/dev/null || true
echo "[deck] done. Read it back: http://localhost:3001/pr/$OWNER/$REPO/$PRNUM  (and /deck)"

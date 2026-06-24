#!/usr/bin/env bash
# Bring up an ISOLATED diffsense stack for E2E testing.
#   - git worktree on origin/master (never touch the primary working tree)
#   - copies the repo's base .env, ensures the E2E keys exist
#   - writes the web-as-root override (fixes the .next EACCES crash)
#   - docker compose up --build -d  (project name keeps it separate)
#
# Idempotent. Re-run any time. Prints which secrets you still must fill in.
#
# Env overrides:
#   REPO_DIR   (default: the repo this skill lives in)
#   WORKTREE   (default: ~/diffsense-test)
#   PROJECT    (default: diffsense-test)   docker compose -p
#   REF        (default: origin/master)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SKILL_DIR/../../.." && pwd)}"
WORKTREE="${WORKTREE:-$HOME/diffsense-test}"
PROJECT="${PROJECT:-diffsense-test}"
REF="${REF:-origin/master}"

say() { printf '\033[1;36m[up]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[up] WARN\033[0m %s\n' "$*"; }

command -v docker >/dev/null || { echo "docker not found"; exit 1; }

cd "$REPO_DIR"
git fetch origin -q || warn "git fetch failed (offline?) — using local $REF"

if [ ! -d "$WORKTREE/.git" ] && ! git -C "$WORKTREE" rev-parse >/dev/null 2>&1; then
  say "creating worktree $WORKTREE @ $REF"
  git worktree add --force "$WORKTREE" "$REF"
else
  say "refreshing worktree $WORKTREE @ $REF"
  git -C "$WORKTREE" fetch origin -q || true
  git -C "$WORKTREE" checkout -q --detach "$REF" || warn "could not fast-forward worktree"
fi

# Base env from the repo, then ensure E2E keys.
if [ ! -f "$WORKTREE/.env" ]; then
  if [ -f "$REPO_DIR/.env" ]; then cp "$REPO_DIR/.env" "$WORKTREE/.env"; say "copied base .env";
  else cp "$REPO_DIR/.env.example" "$WORKTREE/.env"; warn "no base .env — copied .env.example (fill secrets)"; fi
fi

set_kv() { # key value  — set if missing/empty, never clobber a real value
  local k="$1" v="$2"
  if grep -qE "^$k=.+" "$WORKTREE/.env"; then return; fi
  if grep -qE "^$k=" "$WORKTREE/.env"; then
    sed -i '' "s|^$k=.*|$k=$v|" "$WORKTREE/.env" 2>/dev/null || sed -i "s|^$k=.*|$k=$v|" "$WORKTREE/.env"
  else echo "$k=$v" >> "$WORKTREE/.env"; fi
}
set_kv WEB_BASE_URL "http://localhost:3001"
set_kv SESSION_SECRET "$(openssl rand -hex 32)"
set_kv DECK_API_SECRET "$(openssl rand -hex 16)"
# Placeholders the operator must fill (only added if absent):
grep -qE '^GITHUB_OAUTH_CLIENT_ID='     "$WORKTREE/.env" || echo 'GITHUB_OAUTH_CLIENT_ID=Iv23_PASTE_GITHUB_APP_CLIENT_ID'   >> "$WORKTREE/.env"
grep -qE '^GITHUB_OAUTH_CLIENT_SECRET=' "$WORKTREE/.env" || echo 'GITHUB_OAUTH_CLIENT_SECRET=PASTE_GITHUB_APP_CLIENT_SECRET' >> "$WORKTREE/.env"

# Web-as-root override (fixes: EACCES mkdir /app/apps/web/.next under USER node)
cat > "$WORKTREE/docker-compose.override.yml" <<'EOF'
# E2E only: web runs `next dev` and must create /app/apps/web/.next under
# root-owned /app, but the image runs as USER node. Run web as root for testing.
services:
  web:
    user: "root"
EOF

say "building + starting compose project '$PROJECT' (this can take a few minutes)…"
( cd "$WORKTREE" && docker compose -p "$PROJECT" up --build -d )

say "waiting for web on :3001…"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://localhost:3001/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && { say "web is up (HTTP 200)"; break; }
  sleep 3
done

echo
say "stack: web=http://localhost:3001  ingress=http://localhost:3000  project=$PROJECT  worktree=$WORKTREE"
# Report unfilled secrets.
for k in GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET; do
  grep -qE "^$k=(Iv23_PASTE|PASTE)" "$WORKTREE/.env" && warn "fill $k in $WORKTREE/.env (GitHub App creds — NOT an OAuth App), then: docker compose -p $PROJECT up -d app web worker"
done
grep -qiE '^LLM_PROVIDER=google' "$WORKTREE/.env" && warn "LLM_PROVIDER=google cannot run the review unit (tools+JSON). Use anthropic/openai for findings."
grep -qE '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY)=.+' "$WORKTREE/.env" || warn "no LLM key set — login/repo/PR browsing works, but deck generation will fail."
say "next: authorize the GitHub App once by hand (see SKILL.md §3), then drive with arc-drive.sh or Playwright."

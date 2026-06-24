#!/usr/bin/env bash
# Tear down the E2E stack and clean up disposable artifacts.
#   - close disposable test PRs (test/* branches) + delete their remote branches
#   - docker compose down -v   (removes the named stack + its volume)
#   - remove the ~/diffsense-test worktree
#
# Env: PROJECT (default diffsense-test), WORKTREE (~/diffsense-test),
#      REPO_SLUG (robert197/diffsense), KEEP_PRS=1 to skip closing PRs.
set -uo pipefail

PROJECT="${PROJECT:-diffsense-test}"
WORKTREE="${WORKTREE:-$HOME/diffsense-test}"
REPO_SLUG="${REPO_SLUG:-robert197/diffsense}"

say() { printf '\033[1;36m[down]\033[0m %s\n' "$*"; }

if [ "${KEEP_PRS:-0}" != "1" ] && command -v gh >/dev/null; then
  say "closing disposable test PRs (head test/*)…"
  gh pr list --repo "$REPO_SLUG" --state open --json number,headRefName \
    --jq '.[] | select(.headRefName|startswith("test/")) | "\(.number) \(.headRefName)"' 2>/dev/null \
  | while read -r num branch; do
      [ -n "$num" ] || continue
      say "  closing #$num ($branch) + deleting branch"
      gh pr close "$num" --repo "$REPO_SLUG" --delete-branch -c "Disposable E2E test PR — closing." 2>/dev/null || true
    done
fi

if [ -d "$WORKTREE" ]; then
  say "compose down -v (project $PROJECT)…"
  ( cd "$WORKTREE" && docker compose -p "$PROJECT" down -v ) 2>/dev/null || true
fi

# Remove the worktree from whichever repo owns it.
if git -C "$WORKTREE" rev-parse >/dev/null 2>&1; then
  MAIN=$(git -C "$WORKTREE" rev-parse --git-common-dir 2>/dev/null | xargs dirname 2>/dev/null)
  say "removing worktree $WORKTREE"
  git -C "${MAIN:-$WORKTREE}" worktree remove --force "$WORKTREE" 2>/dev/null \
    || { rm -rf "$WORKTREE"; git -C "${MAIN:-.}" worktree prune 2>/dev/null || true; }
fi
say "clean."

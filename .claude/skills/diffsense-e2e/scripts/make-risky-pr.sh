#!/usr/bin/env bash
# Open a DISPOSABLE pull request containing obvious, intentional risks so the
# review pipeline has something real to flag (a README tweak yields no findings).
# Prints the PR number on the last line.
#
# Usage: make-risky-pr.sh [branch-suffix]
# Env:   WORKTREE (default ~/diffsense-test), REPO_SLUG (default robert197/diffsense)
set -euo pipefail

WORKTREE="${WORKTREE:-$HOME/diffsense-test}"
REPO_SLUG="${REPO_SLUG:-robert197/diffsense}"
SUFFIX="${1:-$(date +%H%M%S)}"
BRANCH="test/risky-$SUFFIX"

cd "$WORKTREE"
git checkout -q --detach origin/master 2>/dev/null || git checkout -q master
git checkout -q -b "$BRANCH"

mkdir -p apps/web/lib
cat > "apps/web/lib/e2e-risky-demo.ts" <<'EOF'
// DISPOSABLE E2E fixture — intentional vulnerabilities to exercise the reviewer.
// Do NOT merge.
export function findUser(db: any, userId: string) {
  // SQL injection: untrusted input concatenated into the query.
  return db.query("SELECT * FROM users WHERE id = '" + userId + "'");
}

// Hardcoded credential committed to source control.
export const API_TOKEN = "sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c";

export function buildRedirect(target: string) {
  // Open redirect: user-controlled destination, no allowlist.
  return `https://app.example.com/go?to=${target}`;
}
EOF

git add apps/web/lib/e2e-risky-demo.ts
git -c user.name='diffsense-e2e' -c user.email='e2e@example.com' \
  commit -q -m "test: risky demo module (SQLi, hardcoded secret, open redirect) — disposable"
git push -q -u origin "$BRANCH"

URL=$(gh pr create --repo "$REPO_SLUG" --base master --head "$BRANCH" \
  --title "test: risky change for deck findings (disposable)" \
  --body "Intentional risks to verify the review pipeline produces findings. Safe to close/delete." | tail -1)
echo "PR_URL=$URL"
echo "${URL##*/}"

#!/bin/sh
set -e

# One image, role selected by $ROLE (KTD7). See docs/STACK.md §Docker.
ROLE="${ROLE:-serve}"

case "$ROLE" in
  serve)
    exec pnpm --filter @diffsense/app serve
    ;;
  worker)
    exec pnpm --filter @diffsense/app worker
    ;;
  migrate)
    exec pnpm db:migrate
    ;;
  web)
    exec pnpm --filter @diffsense/web dev
    ;;
  *)
    echo "unknown ROLE: $ROLE (expected serve|worker|migrate|web)" >&2
    exit 1
    ;;
esac

# Multi-stage build for the diffsense monorepo. One image, three runtime roles
# (serve / worker / web) selected by $ROLE via the entrypoint (KTD7).

FROM node:22-slim AS base
# Cache the pinned pnpm in a shared, world-readable location at build time so the
# unprivileged `node` runtime user finds it without a network round-trip. Default
# COREPACK_HOME lives under the *building* user's $HOME (root) — unreadable to
# `node`, which then tries to download pnpm at start and crashes offline (EAI_AGAIN).
ENV COREPACK_HOME=/usr/local/corepack
RUN corepack enable \
 && corepack prepare pnpm@10.10.0 --activate \
 && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

# --- deps: install once against manifests for layer caching ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/llm/package.json ./packages/llm/
COPY apps/app/package.json ./apps/app/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# --- runtime: source over the installed node_modules; run via tsx (no build) ---
FROM deps AS runtime
COPY . .
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# `COPY . .` lands as root; give `node` ownership of the source trees so the web
# role can create its `.next` build dir (and any runtime scratch) at start. Only
# the small source dirs are chowned — root-owned node_modules stays read-only.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && chown -R node:node /app/apps /app/packages
EXPOSE 3000 3001
# Drop from root: the public serve/worker/web roles run as the unprivileged
# `node` user that ships with the base image.
USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

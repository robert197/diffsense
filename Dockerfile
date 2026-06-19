# Multi-stage build for the diffsense monorepo. One image, three runtime roles
# (serve / worker / web) selected by $ROLE via the entrypoint (KTD7).

FROM node:22-slim AS base
RUN corepack enable
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
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 3000 3001
# Drop from root: the public serve/worker/web roles run as the unprivileged
# `node` user that ships with the base image.
USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

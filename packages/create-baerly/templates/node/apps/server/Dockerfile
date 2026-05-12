# Hand-rolled Dockerfile for {{appName}}.
# NOT a production template — no health probes, no graceful-shutdown
# polish beyond SIGTERM, no non-root user setup, no distroless / alpine
# base. Ticket 40 productizes a `baerly deploy --target=node` flow
# that extends this Dockerfile with the production polish.

# ---- Build stage ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# pnpm@10.31.0 matches package.json:packageManager.
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

# Workspace layout — copy manifests first for layer-cache hits on
# pnpm install when source changes without dep changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Frozen lockfile fails the build if pnpm-lock.yaml is stale.
RUN pnpm install --frozen-lockfile

# Copy source.
COPY apps apps/
COPY tsconfig.json baerly.config.ts ./

# ---- Runtime stage ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `tini` for proper PID-1 signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

COPY --from=build /app /app

# Production install — skip devDeps where possible.
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080
ENV PORT=8080

# `tsx` resolves the .ts entry directly; no build step needed for
# the entry. (A future version will pre-compile.)
RUN pnpm add -D tsx
ENTRYPOINT ["tini", "--", "pnpm", "-F", "server", "exec", "tsx", "src/server.ts"]

# Hand-rolled Dockerfile for the Phase 6 real-deploy gate.
# NOT a Phase 8 production template — no health probes, no
# graceful-shutdown polish beyond SIGTERM, no non-root user setup,
# no distroless / alpine base.

# ---- Build stage ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# pnpm@10.31.0 matches package.json:packageManager.
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

# Workspace layout — copy manifests first for layer-cache hits on
# pnpm install when source changes without dep changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/dev/package.json packages/dev/
COPY packages/adapter-node/package.json packages/adapter-node/
COPY packages/adapter-cloudflare/package.json packages/adapter-cloudflare/

# Frozen lockfile fails the build if pnpm-lock.yaml is stale.
RUN pnpm install --frozen-lockfile

# Now copy source and the gate entry.
COPY packages packages/
COPY src src/
COPY rolldown.config.ts tsconfig.json ./
COPY deploy/node/server-entry.ts deploy/node/

# Build the root bundle so dist/index.js exists for any downstream
# imports. The adapter packages are consumed via workspace symlinks
# at runtime — no separate build needed.
RUN pnpm build

# ---- Runtime stage ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `tini` for proper PID-1 signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages packages/
COPY --from=build /app/dist dist/
COPY --from=build /app/deploy/node deploy/node/

# Production install — skip devDeps. The adapter packages declare
# their runtime deps in their own package.json; pnpm wires the
# workspace symlinks.
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080
ENV PORT=8080

# `tsx` resolves the .ts entry directly; no build step needed for
# the gate entry. (Phase 8 will pre-compile.)
RUN pnpm add -D tsx
ENTRYPOINT ["tini", "--", "pnpm", "exec", "tsx", "deploy/node/server-entry.ts"]

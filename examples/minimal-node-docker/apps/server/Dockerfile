# Production Dockerfile emitted by `create-baerly --target=node`.
# Distroless final stage, non-root user, HEALTHCHECK via a Node
# script (distroless ships no wget/curl).

# ---- Build stage ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

# Manifests first for layer-cache hits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

# Source + compile.
COPY . .
RUN pnpm --filter server build

# Prune to production-only deps in a separate stage for copy-in.
RUN pnpm install --prod --frozen-lockfile --filter server

# ---- Runtime stage ----
FROM gcr.io/distroless/nodejs24-debian12 AS runtime
WORKDIR /app

# Distroless's `nonroot` user is UID 65532. We run as that.
USER nonroot:nonroot

# Copy compiled output + production dependencies + healthcheck.
COPY --from=build --chown=nonroot:nonroot /app/apps/server/dist apps/server/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/server/healthcheck.js apps/server/healthcheck.js
COPY --from=build --chown=nonroot:nonroot /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules node_modules

# OCI image labels — registries surface these.
LABEL org.opencontainers.image.title="minimal-node-docker"
LABEL org.opencontainers.image.description="Baerly app — vendorless document database."
LABEL org.opencontainers.image.source="https://github.com/your-org/minimal-node-docker"

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Node-script HEALTHCHECK — distroless ships no wget/curl.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "apps/server/healthcheck.js"]

# Distroless's entrypoint IS node; we pass the compiled server as
# the argument.
ENTRYPOINT ["node", "apps/server/dist/server.js"]

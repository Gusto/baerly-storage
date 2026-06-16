# Production Dockerfile emitted by `create-baerly --target=node --with=docker`.
# Distroless final stage, non-root user, HEALTHCHECK via a Node
# script (distroless ships no wget/curl).
#
# Runtime path: node --experimental-strip-types src/server/index.ts.
# No `tsc` emit at runtime — the server runs straight off TS source.
# The SPA bundle (vite build) lives under dist/client/ and is served
# by baerlyNode({ webRoot }).
#
# If you diverge and compile the server with `tsc -b` instead of
# strip-types, exclude `*.tsbuildinfo` from the build context (or run
# `tsc -b --force`): a stale tsbuildinfo copied in lets incremental
# `tsc -b` skip emit, and the container then crashes on a missing
# dist/server/*.js.

# Base images are tag-pinned (not digest-pinned) so this template
# stays fresh as new patch images ship. Once you vendor this file,
# pin to digests for reproducibility: `docker pull <image>` then
# `docker inspect --format='{{index .RepoDigests 0}}' <image>` and
# replace the tag with `@sha256:...`.

# ---- Build stage ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable
# pnpm version is driven by `packageManager` in package.json (pnpm 11.1.2).

# Manifest first for layer-cache hits.
COPY pnpm-lock.yaml package.json ./

RUN pnpm install --frozen-lockfile

# Source + build the SPA.
COPY . .
RUN pnpm build

# Prune to production deps for the runtime image.
RUN pnpm install --prod --frozen-lockfile

# ---- Runtime stage ----
FROM gcr.io/distroless/nodejs24-debian12 AS runtime
WORKDIR /app

# Distroless's `nonroot` user is UID 65532. We run as that.
USER nonroot:nonroot

# Copy the TS source, the project-root config, the SPA build, the
# healthcheck, the manifest, and the prune'd node_modules.
#
# baerly.config.ts is load-bearing: the server entrypoint does
# `import config from "../../baerly.config.ts"`, which resolves to the
# project root. Omit it and the container crashes on boot with an
# unresolved import.
COPY --from=build --chown=nonroot:nonroot /app/src src
COPY --from=build --chown=nonroot:nonroot /app/baerly.config.ts baerly.config.ts
COPY --from=build --chown=nonroot:nonroot /app/dist/client dist/client
COPY --from=build --chown=nonroot:nonroot /app/healthcheck.js healthcheck.js
COPY --from=build --chown=nonroot:nonroot /app/package.json package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules node_modules

# OCI image labels — registries surface these.
LABEL org.opencontainers.image.title="minimal-node"
LABEL org.opencontainers.image.description="Baerly app — vendorless document database."
LABEL org.opencontainers.image.source="https://github.com/your-org/minimal-node"

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Node-script HEALTHCHECK — distroless ships no wget/curl.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "healthcheck.js"]

# Distroless's entrypoint IS node; we pass --experimental-strip-types
# and the TS source path as args.
ENTRYPOINT ["node", "--experimental-strip-types", "src/server/index.ts"]

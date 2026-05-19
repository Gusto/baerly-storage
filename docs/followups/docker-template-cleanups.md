# `--with=docker` add-on: Dockerfile + `.dockerignore` cleanups

**Severity: MEDIUM. One of the two remaining sub-issues will break a
scaffolded user's build the first time they touch the wrong file.**

The opt-in Docker add-on at
`packages/create-baerly/templates/addons/docker/` ships into a
scaffolded user repo as part of `baerly-cli init --target=node
--with=docker`. One real bug and one cosmetic note:

## 1. `.dockerignore` excludes a path that doesn't exist; misses one that does

`packages/create-baerly/templates/addons/docker/.dockerignore:2`:

```
dist/server
```

`dist/server` is never written. The Dockerfile copies
`dist/client/` out of the build stage:

```dockerfile
COPY --from=build --chown=nonroot:nonroot /app/dist/client dist/client
```

A host-local `dist/client` from a prior run leaks into the build
context. Replace the entry with `dist`:

```
# Build artifacts: re-derive from the build stage, never from the host
dist
```

The Dockerfile reads `dist/client` out of the `build` stage, so
excluding the whole `dist/` from the host context is safe and
correct.

## 2. (Optional) No digest pinning on the base images

`Dockerfile:11` and `Dockerfile:29`:

```dockerfile
FROM node:24-bookworm-slim AS build
...
FROM gcr.io/distroless/nodejs24-debian12
```

Neither image is pinned by `@sha256:...`. Reproducibility-minded
shops will want a pin.

**Recommendation:** Do **not** ship a pinned digest in the
template — pinned digests in a scaffolded template rot the day
they're written and the next user who runs `baerly init` gets a
"manifest unknown" error. Better DX: leave the tags
unpinned and add a top comment telling vendoring users to pin
once they own the file:

```dockerfile
# Pin these once you vendor: `docker pull` then `docker inspect
# --format='{{index .RepoDigests 0}}' <image>` and replace the tag.
FROM node:24-bookworm-slim AS build
```

## Cross-references

- Sibling drift across CLAUDE.md / per-template AGENTS.md plus the
  Dockerfile pnpm pin was closed by `template-tooling-drift`
  (now landed; ticket deleted).

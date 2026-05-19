# `--with=docker` add-on: Dockerfile + `.dockerignore` cleanups

**Severity: MEDIUM. Two of the three sub-issues will break a
scaffolded user's build the first time they touch the wrong file.**

The opt-in Docker add-on at
`packages/create-baerly/templates/addons/docker/` ships into a
scaffolded user repo as part of `baerly-cli init --target=node
--with=docker`. Two real bugs and one cosmetic note:

## 1. pnpm version drift between Dockerfile and `packageManager`

`Dockerfile:14`:

```dockerfile
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate
```

Every scaffolded `package.json` declares
`"packageManager": "pnpm@11.1.2"`. The Dockerfile pin and the
manifest pin will drift again the next time `packageManager` moves.

**Fix:** Drop the explicit `prepare` literal. `corepack enable`
on its own honors `packageManager` from the project's
`package.json` automatically. Or, if a literal is desired for
build-cache stability, read it out of the manifest at build time.

```dockerfile
RUN corepack enable
# pnpm version is driven by packageManager in package.json
```

Note: pnpm 11 is intentional, not accidental — pnpm 11 fixed the
`onlyBuiltDependencies` → `allowBuilds` rename. Don't roll back
the Dockerfile to 10.x; align everything **up** to 11.1.2.

## 2. `.dockerignore` excludes a path that doesn't exist; misses one that does

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

## 3. (Optional) No digest pinning on the base images

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

- Memory: pnpm 11.1.2 is canonical
  (`project_pnpm11_ignored_builds_broken_on_main`).
- Sibling drift in CLAUDE.md / per-template AGENTS.md → see
  `template-tooling-drift.md`.

---
title: Add baerly to an existing Cloudflare Worker
audience: integrator
summary: One-command bolt-on for an existing `wrangler create` project — `pnpm create @gusto/baerly-storage@latest .` detects wrangler.jsonc, patches it, prints the worker-entry snippet.
last-reviewed: 2026-06-13
tags: [getting-started, cloudflare]
related: [../contributing/extending.md]
---

# Add baerly to an existing Cloudflare Worker

This is the path when you already have a Wrangler project (`wrangler
create`, an existing repo, etc.) and want to bolt baerly on. The same
command (`pnpm create @gusto/baerly-storage@latest .`) covers the fresh-scaffold case — it
dispatches based on what's already in the directory.

## The one-step

```sh
pnpm create @gusto/baerly-storage@latest .
```

`@gusto/create-baerly-storage` detects your `wrangler.jsonc`, patches it with an R2
binding and the `vars` baerly expects, seeds a `.dev.vars` with
a dev secret, adds `.dev.vars` to `.gitignore` if it isn't already
covered, appends `@gusto/baerly-storage` to your `package.json` dependencies,
runs your package manager's install, and prints the worker-entry
snippet for you to paste.

(`npm create baerly .`, `yarn create baerly .`, `bun create baerly .`
all work — the underlying package-manager dispatch picks the right
one.)

## What gets written (skip-if-exists / merge-if-present)

| File | What happens |
|---|---|
| `wrangler.jsonc` | Adds `r2_buckets: [{ binding: "BUCKET", bucket_name: <app> }]` if no entry named `BUCKET` exists. Merges `vars: { APP, TENANT }` — keys you've already set win. |
| `.dev.vars` | Created with `SHARED_SECRET=dev-shared-secret` for the shared-secret posture. Skipped if `.dev.vars` already exists. |
| `.gitignore` | Appends `.dev.vars` unless an equivalent pattern (`.env*.local`, `*.local`, `.env`) is already present. |
| `package.json` | Appends `@gusto/baerly-storage` to `dependencies` if not present. |
| `baerly.config.ts` | Written if absent. Pass `--force` to overwrite. |

## What does NOT get written

- `src/index.ts` — printed as a snippet you paste. baerly never
  auto-edits your Worker entry. Convex draws the same line: structured
  config is fair game; app code is yours.
- `wrangler` secrets — if you choose shared-secret auth,
  `wrangler secret put SHARED_SECRET` is yours to run before deploy.

## After the one-step

1. Paste the printed snippet into the path declared in
   `wrangler.jsonc:main` (typically `src/index.ts`), replacing the
   stock `wrangler create` handler.
2. `pnpm dev` (or `wrangler dev`) to boot. Verify liveness, then hit
   a concrete collection route. The bolt-on config ships `auth: "none"`,
   so no header is needed until you switch it:

   ```sh
   curl -fsS http://localhost:8787/v1/healthz
   curl -fsS http://localhost:8787/v1/c/tickets
   # if you set auth: "shared-secret", add the dev secret:
   #   curl -fsS -H 'Authorization: Bearer dev-shared-secret' \
   #     http://localhost:8787/v1/c/tickets
   ```

   Route shape is `/v1/c/:collection`; use a real collection name from
   `baerly.config.ts`. See
   [the cheat sheet](cheatsheet.md#http-wire-reach-for-curl-only-when-debugging).
3. Before deploy, choose production auth:

   - Cloudflare Access: keep browser auth in Access, configure
     `cloudflareAccess({ teamDomain, audienceTag, tenantPrefix })` in
     the Worker entry, and verify unauthenticated `/v1/c/tickets`
     fails closed. See [auth.md](auth.md#cloudflare-production).
   - Shared secret: set `auth: "shared-secret"` in
     `baerly.config.ts`, run `wrangler secret put SHARED_SECRET`, and
     verify the route fails without a bearer and succeeds with one.

   ```sh
   curl -i https://<worker-host>/v1/c/tickets
   curl -fsS -H "Authorization: Bearer $SHARED_SECRET" \
     https://<worker-host>/v1/c/tickets
   ```

   Then `wrangler deploy`.

## Re-running

`pnpm create @gusto/baerly-storage@latest .` is idempotent on existing wrangler projects.
Re-run it any time — every write is gated by detection, so a second
run with the same flags is a no-op. Use this to add a missing `vars`
key or to re-check the R2 binding after editing `wrangler.jsonc` by
hand.

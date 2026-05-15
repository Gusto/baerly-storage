# Followups: split-node-example

Branch: `worktree-split-node-example`. Replaces `examples/minimal-node/` with `node-railway` + `node-docker` and removes the `baerly deploy --target=node` / `baerly doctor --target=node` codepaths.

## Breaking CLI changes

- `--target=node` is no longer accepted by `create-baerly`. Users must pick `node-railway` or `node-docker`. Suggested error message in `packages/create-baerly/src/index.ts` flags both.
- `baerly deploy --target=node` and `baerly doctor --target=node` no longer exist. The dispatcher returns `InvalidConfig` for non-cloudflare targets with a message explaining that node variants self-deploy.

## Discovered during this work

- **`scaffold-eval` and `manual-e2e/node/` skeletons** still work against the renamed `node-docker` shape (no internal references to `minimal-node` in their source). No action needed.
- **`apps/web/` shell in both new examples** is dead weight (11-line static HTML, no JS, vite devDep). Acceptable for now; consider whether `node-railway` and `node-docker` should ship an SPA shell at all, or just be API-only scaffolds.

## Memory worth saving

- `runMaintenanceTick` operates per-collection, not per-app. The trailing segment of `currentJsonKey` is a collection name. Auto-deriving from `app`/`tenant` alone is fundamentally wrong; operator must supply `MAINTENANCE_KEY` or wire one cron per collection. See `packages/adapter-node/src/server.ts:352`.
- Scaffold sentinels must NOT exactly equal any target literal — collision causes `substituteText` to overwrite the target value. Use `minimal-railway` / `minimal-docker` (placeholder-shaped) rather than `node-railway` / `node-docker` (target-shaped). Pattern: see `minimal-cloudflare` where sentinel is `minimal-cloudflare` and target is `cloudflare`.

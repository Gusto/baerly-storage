# 03 — Scaffolded `package.json:scripts.dev` calls `baerly dev`

**One-liner.** Replace the two example apps' bespoke `dev`
scripts (`wrangler dev` for Cloudflare, `tsx watch src/server.ts`
for Node) with `baerly dev`, and add `@baerly/cli` as a
workspace devDep on each example so the new verb resolves.

**Estimated effort.** 0.5 day. **Risk.** Low — small,
mechanical, but verifies the end-to-end story.

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo, and
> the conventions referenced at the bottom. Note: ticket 01
> (`baerly dev` implementation) MUST land first.

## Why we're doing this

The point of `baerly dev` is to be the single day-1 + day-2 verb
users learn. If the scaffolded `package.json:scripts.dev` doesn't
invoke it, users never encounter the unified verb — they keep
typing `pnpm dev` and the underlying mechanism (wrangler vs tsx)
leaks back into the surface. Convex's `convex dev`, Prisma's
`prisma dev`, etc. work because the scaffolder pre-wires
`scripts.dev` to call the framework verb.

Specifically, after this ticket:

- `pnpm dev` in a freshly-scaffolded CF app → `baerly dev` →
  Node listener over `LocalFsStorage` on :3000. **No wrangler
  download required for first-touch.** A separate `pnpm dev:cf`
  script invokes `baerly dev --wrangler` for users who explicitly
  want CF parity.
- `pnpm dev` in a freshly-scaffolded Node app → `baerly dev` →
  same Node listener. (Today already uses `tsx watch src/server.ts`,
  which is roughly equivalent but bespoke.)

Both examples publish a clean, identical `dev` story.

## Current state

`examples/minimal-cloudflare/package.json` (root, runs at
`examples/minimal-cloudflare/`):
- `scripts.dev: "pnpm -F minimal-cloudflare-server dev"`
- `devDependencies: { "create-baerly": "workspace:*", "typescript": "^5.6.0" }`

`examples/minimal-cloudflare/apps/server/package.json`
(server-app, runs at `examples/.../apps/server/`):
- `name: "minimal-cloudflare-server"`
- `scripts.dev: "wrangler dev"`
- `scripts.deploy: "wrangler deploy"`
- `dependencies: @baerly/adapter-cloudflare, @baerly/server`
- `devDependencies: @cloudflare/workers-types, typescript, wrangler`

`examples/minimal-node/package.json` (root):
- `scripts.dev: "pnpm -F minimal-node-server dev"`
- `devDependencies: same as cloudflare root + typescript`

`examples/minimal-node/apps/server/package.json`:
- `name: "minimal-node-server"`
- `scripts.dev: "tsx watch src/server.ts"`
- `dependencies: @baerly/adapter-node, @baerly/protocol, @baerly/server, @xmldom/xmldom, aws4fetch`
- `devDependencies: @types/node, tsx, typescript`

`packages/create-baerly/src/scaffold.ts` rewrites workspace `*`
deps via the manifest. Per commit `103289c`, `workspace:*` →
`^X.Y.Z` rewrite already happens for `@baerly/*` packages at
scaffold time. Adding `@baerly/cli` as a workspace devDep on each
example will be rewritten the same way at scaffold time
(verify by reading
`packages/create-baerly/src/scaffold.ts` for the rewrite logic
before editing).

## Implementation steps

### Step 1. Add `@baerly/cli` devDep on the CF server

Edit `examples/minimal-cloudflare/apps/server/package.json`:

- Change `scripts.dev` from `"wrangler dev"` to `"baerly dev"`.
- Add `scripts.dev:wrangler` = `"baerly dev --wrangler"`. (This
  preserves the wrangler path for users who want CF parity. It
  shells out to `wrangler dev` under the hood; ticket 01 wires
  that branch.)
- Keep `scripts.deploy` unchanged (`"wrangler deploy"`).
- Add to `devDependencies`: `"@baerly/cli": "workspace:*"`.

### Step 2. Add `@baerly/cli` devDep on the Node server

Edit `examples/minimal-node/apps/server/package.json`:

- Change `scripts.dev` from `"tsx watch src/server.ts"` to
  `"baerly dev"`.
- (No `dev:wrangler` script — Node target doesn't support
  `--wrangler`.)
- Keep `scripts.build`, `scripts.start`, `scripts.typecheck`
  unchanged.
- Add to `devDependencies`: `"@baerly/cli": "workspace:*"`.
- Remove `tsx` from devDependencies **only if** no other script
  uses it. Currently only `dev` did; the `build` step runs `tsc`
  so `tsx` should be unused after this change. Re-verify by
  grepping `apps/server/package.json` for `tsx` after editing.

### Step 3. Re-run `pnpm install` at the repo root

`pnpm install` re-resolves the workspace graph. After install,
`pnpm -F minimal-cloudflare-server exec baerly` should resolve to
the workspace `@baerly/cli` (verify with
`pnpm -F minimal-cloudflare-server why @baerly/cli`).

### Step 4. Verify each example boots via `pnpm dev`

```sh
cd examples/minimal-cloudflare && pnpm dev   # → baerly dev → :3000
# In another shell:
curl -s -H "Authorization: Bearer dev-only-secret" \
     "http://localhost:3000/v1/since?app=minimal-cloudflare&tenant=default" | head -1
# Stop the server (Ctrl-C).

cd examples/minimal-node && pnpm dev   # → baerly dev → :3000
# Repeat the curl, then stop.

# CF parity (optional, requires wrangler login):
cd examples/minimal-cloudflare && pnpm run dev:wrangler   # → baerly dev --wrangler → wrangler dev
```

### Step 5. Update the scaffolder's manifest if needed

If the manifest at
`examples/minimal-{cloudflare,node}/.baerly/scaffold.json`
explicitly drops `@baerly/cli` as a devDep at scaffold time
(check the `dropDevDeps` array), remove `@baerly/cli` from that
list. The scaffolder should keep `@baerly/cli` so the rewritten
`^X.Y.Z` version lands in the user's `package.json`.

Verify by re-running `packages/create-baerly/src/scaffold.test.ts`
— the fixture assertions should still pass; if any of them assert
that `@baerly/cli` is **absent** in the scaffold output, update
them to assert it's present.

## Conventions to follow

- Keep `scripts.dev` consistent across both examples — the
  scaffolded user shouldn't have to memorize different verbs per
  target.
- `examples/README.md` doesn't need an edit; the per-example
  `README.md` does (each says "Run locally / `pnpm install / pnpm
  dev`" which remains accurate, but if either calls out `wrangler
  dev` or `tsx watch` by name in prose, update that line).
- Follow `docs/conventions/change-discipline.md` if it exists —
  this is a user-visible default-behavior change.
- No new dependencies in `examples/<name>/package.json` beyond
  `@baerly/cli`. Resist adding shims.

## Verification

```sh
# Static
pnpm verify

# Scaffold test (will fail if any fixture asserts absence of @baerly/cli)
pnpm -F create-baerly test

# Manual: each example boots via the new dev verb
cd examples/minimal-cloudflare && pnpm dev &
sleep 2 && curl -s http://localhost:3000/v1/since?app=minimal-cloudflare | head -1
kill %1

cd ../minimal-node && pnpm dev &
sleep 2 && curl -s http://localhost:3000/v1/since?app=minimal-node | head -1
kill %1

# Scaffold smoke (validates end-to-end after this lands)
pnpm -F create-baerly build
node packages/create-baerly/dist/index.js test-cf --target=cloudflare --json
cat test-cf/apps/server/package.json | grep -E '"dev":|baerly/cli'   # should show both
rm -rf test-cf

# Format
pnpm format:check examples/
```

Done when:
- Both examples boot via `pnpm dev` and respond on :3000.
- `pnpm -F create-baerly test` passes.
- A freshly-scaffolded project has `"@baerly/cli": "^X.Y.Z"` in
  `apps/server/devDependencies` and `"dev": "baerly dev"` in
  `apps/server/scripts`.

## Out of scope

- **Reading deploy commands from `baerly.config.ts` in the scaffold
  output.** The `scripts.deploy` in CF stays as `wrangler deploy`
  (or `baerly deploy` if that exists; verify before changing).
- **Auto-injecting a `dev:wrangler` script in the Node example.**
  Node target has no wrangler path.
- **Changing the helpdesk example.** It has its own custom server
  and reset script; not a scaffolder template, not in scope.
- **Removing the `tsx` devDep beyond the Node-example server.**
  `tsx` may be used elsewhere in the repo (root, other examples).
  Only touch the file you're editing.

## Conflict notes

- **Depends on**: ticket 01 (`baerly dev` command). This ticket
  changes scripts to invoke a verb that ticket 01 creates.
- **Blocks**: ticket 04 (pnpm pack flow includes a scaffold smoke
  that depends on these scripts being in place).
- **No file overlap** with ticket 00 (ADR), 01 (`packages/cli/src/`),
  or 02 (`packages/create-baerly/src/`).

## Pointers

- `examples/minimal-cloudflare/package.json` — root pnpm workspace.
- `examples/minimal-cloudflare/apps/server/package.json` — CF
  server (`scripts.dev`, deps).
- `examples/minimal-node/package.json` — root.
- `examples/minimal-node/apps/server/package.json` — Node server.
- `examples/minimal-{cloudflare,node}/.baerly/scaffold.json` —
  scaffold manifest (rename sentinels, dropDevDeps).
- `packages/create-baerly/src/scaffold.ts` — rewrite logic for
  `workspace:*` → `^X.Y.Z`.
- `packages/create-baerly/src/scaffold.test.ts` — fixture
  assertions that may need updating.

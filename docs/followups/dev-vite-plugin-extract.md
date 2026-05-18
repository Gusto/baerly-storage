# `@baerly/dev` ↔ `@baerly/adapter-node`: break the workspace cycle

**Severity: LOW. No runtime impact. pnpm warns at install time.**

The `d1293a6` commit ("refactor(server): move renderDevLanding
to @baerly/dev") closed a kernel-bundle leak by relocating
`renderDevLanding` + `DevLandingOptions` from `@baerly/server`
to `@baerly/dev`. To wire it up, both adapters gained
`"@baerly/dev": "workspace:*"` in their `dependencies`.

For `@baerly/adapter-cloudflare`, that edge is leaf-clean.
For `@baerly/adapter-node`, it closes a cycle:

- `@baerly/dev` → `@baerly/adapter-node`:
  `packages/dev/src/vite-plugin.ts:1` imports `createListener`
  from `@baerly/adapter-node`. This edge predates the
  dev-landing move — it's how `baerlyDev()` mounts the Baerly
  HTTP listener as Vite middleware in `examples/helpdesk/`.
- `@baerly/adapter-node` → `@baerly/dev` (new):
  `packages/adapter-node/src/server.ts` and
  `packages/adapter-node/src/baerly-node.ts` import
  `renderDevLanding` / `DevLandingOptions` from `@baerly/dev`.

`pnpm install` emits
`[WARN] There are cyclic workspace dependencies` but resolves
the graph cleanly. `pnpm verify`, `pnpm test`,
`pnpm test:adapter-node`, `pnpm test:adapter-cloudflare`,
`pnpm test:http-conformance`, and `pnpm build` all pass green
(verified at `d1293a6`). Tree-shaking is unaffected (both
packages set `"sideEffects": false`). The cycle is a smell,
not a defect.

The systematic fix is to remove the `dev → adapter-node`
edge by relocating `vite-plugin.ts` out of `@baerly/dev`.

---

## Why fix it at all

- pnpm tolerates workspace cycles but other tools in the JS
  ecosystem don't (yarn 1, some monorepo dep graphers, future
  pnpm major versions). Closing the cycle keeps the workspace
  portable.
- `@baerly/dev` is positioned as the "dev-environment helpers"
  package — `LocalFsStorage`, banner printers, ensure-table.
  Its `baerlyDev` Vite plugin doesn't fit that mental model:
  it's Node-server middleware. A package boundary mismatch
  becomes easier to fix the longer it's deferred.
- The `dev-landing.ts` move was correct; the cycle is the
  cost of putting `vite-plugin.ts` in the wrong package, not
  a cost of the dev-landing move. Closing it makes the
  dev-landing-relocate retroactively cycle-free.

---

## Action — pick one

**(a) [preferred] Move `vite-plugin.ts` into `@baerly/adapter-node` as a subpath export.**
The Vite plugin's job is "mount adapter-node's `createListener`
as Vite middleware." That belongs next to `createListener`.
Add `"./vite": { "types": "./src/vite-plugin.ts", "import":
"./src/vite-plugin.ts" }` to `packages/adapter-node/package.json`
exports. Move `packages/dev/src/vite-plugin.ts` →
`packages/adapter-node/src/vite-plugin.ts`. Update
`examples/helpdesk/vite.config.ts` (and any other importer)
from `@baerly/dev/vite` to `@baerly/adapter-node/vite`. Remove
`"@baerly/adapter-node"` from `@baerly/dev`'s `dependencies`.

Pros:
- Cycle gone — `@baerly/dev` becomes a leaf w.r.t. adapter-node.
- Vite plugin lives next to the listener it wraps.
- No new package to publish.

Cons:
- `@baerly/adapter-node` adds a `peerDependencies` entry for
  `vite` (or `peerDependenciesMeta.optional: true`), because
  Node-only consumers of the adapter shouldn't pull Vite.

**(b) Move `vite-plugin.ts` into a new leaf package `@baerly/dev-vite`.**
Keeps the symmetry of "dev helpers in `@baerly/dev`, Vite
glue in `@baerly/dev-vite`." Adds a private workspace
package (no publish footprint — they're all `private: true`
during pre-launch).

Pros:
- `@baerly/dev` stays a pure helper package with no Vite peerDep.
- Clear single-purpose package.

Cons:
- New package boilerplate (package.json, exports map,
  tsconfig).
- One more workspace edge for consumers to wire up.

(a) is the smaller, more consolidated diff. (b) is the more
ceremonious separation of concerns. The package roster
already includes `@baerly/dev`, `@baerly/adapter-node`,
`@baerly/adapter-cloudflare`, `@baerly/cli`,
`@baerly/create-baerly`, `@baerly/protocol`, `@baerly/server`
— adding a seventh-and-a-half (a leaf package whose only
file is `vite-plugin.ts`) buys little.

---

## Verification

After the workstream:

- `pnpm install` — no `cyclic workspace dependencies` warning.
- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass.
- `pnpm test:adapter-node` and `pnpm test:adapter-cloudflare`
  — both adapter cascades still pass; `GET /` still serves
  the dev landing when `opts.dev` is set.
- `pnpm dev:storage && pnpm --filter helpdesk dev` (or
  whatever the helpdesk example's dev command is) — the
  example still boots; the Vite plugin still proxies Baerly
  HTTP requests through to `createListener`.
- `grep -rn '"@baerly/adapter-node"' packages/dev/` returns
  zero hits (if option a) or `grep -rn 'vite-plugin' packages/dev/`
  returns zero hits (either option).

## Out of scope

The cycle itself is the only structural issue here. The
dev-landing move that introduced it is correct as shipped;
this followup doesn't revisit `renderDevLanding`'s location.
Other server-periphery cleanups (router options trim,
bearer-jwt trim, maintenance options trim, observability
scope) are tracked in sibling files under `docs/followups/`.

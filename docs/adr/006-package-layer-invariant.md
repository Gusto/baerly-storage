---
title: Package layer invariant
audience: adr
summary: ADR 006 — hand-maintained package import allow list, enforced by scripts/lint-package-layers.mjs.
last-reviewed: 2026-05-28
tags: [decision, adr]
related: [../../packages/protocol/src/index.ts, ../../scripts/lint-package-layers.mjs]
---

# 006 — Package layer invariant

## Status

Accepted.

## Context

[`CLAUDE.md`](../../CLAUDE.md) describes `@baerly/protocol` as
"pure modules; no I/O" — the load-bearing claim that lets the
kernel run unchanged on Workerd, in Node, and inside the browser
where applicable. The same file calls out that the storage
adapters (`@baerly/adapter-node`, `@baerly/adapter-cloudflare`)
live one layer above the kernel, and that `@baerly/server`
never reaches sideways to either of them.

Today those invariants are guarded only by reviewer attention,
the bundle-size budgets in
[`tests/integration/bundle-size.test.ts`](../../tests/integration/bundle-size.test.ts),
and `pnpm test:manual-e2e` blowing up on Workerd if something
Node-only leaked into the kernel. None of those gates fire at
edit time. A single `import { foo } from "@baerly/adapter-node"`
slipping into `packages/server/src/` is a Workerd-incompatible
regression the moment it lands — bundle-size catches it later
(if at all), and only a manual deploy round-trip catches it
definitively.

The package import graph today (production code only — `*.test.ts`
and `*.test-d.ts` excluded) is a hand-maintained allow list with
one Node-only cycle:

```
protocol            : (nothing)
server              : protocol
dev                 : protocol, server, adapter-node
adapter-node        : protocol, server, dev
adapter-cloudflare  : protocol, server, dev
client              : protocol, server
cli                 : protocol, server, dev, adapter-node, adapter-cloudflare, client
create-baerly-storage : protocol, server, cli
```

Two things to note about this graph:

- **`@baerly/dev` and `@baerly/adapter-node` form a 2-cycle.**
  Both edges exist today:
  - `dev → adapter-node` via
    [`packages/dev/src/vite-plugin.ts:5`](../../packages/dev/src/vite-plugin.ts)
    importing `baerlyNode` (the in-process Vite middleware uses the
    Node listener as its dev seam).
  - `adapter-node → dev` via
    [`packages/adapter-node/src/middleware/dev-landing.ts:1`](../../packages/adapter-node/src/middleware/dev-landing.ts)
    importing `renderDevLanding` as a runtime value (the Node
    server's "dev landing" GET handler).

  The cycle is Node-only — it cannot transitively pull anything into
  `@baerly/server` or `@baerly/protocol`, and it will never reach
  Workerd. Breaking it would require splitting `@baerly/dev` (e.g.
  moving `vite-plugin.ts` into `adapter-node`, or moving
  `renderDevLanding` to a sibling package that `dev` does not
  consume at value level). That is a separate refactor and is
  explicitly out of scope for this ADR.
- **`@baerly/server` imports nothing below `@baerly/protocol`.**
  That is the load-bearing constraint. Workerd compatibility is
  defined as "everything reachable from `@baerly/server`'s entry
  points runs under Workerd" — i.e. `protocol` runs under
  Workerd, and so does `server`. The `dev ↔ adapter-node` cycle
  sits above this line and does not threaten it.

Three options for enforcement:

- **Reviewer-only.** What we have. Cheapest until the gate
  misses, at which point the manual-e2e bounce-back is hours
  per round-trip.
- **TypeScript project references.** Would catch back-edges via
  cyclical refs but would not catch sibling imports
  (`adapter-node ↔ adapter-cloudflare`), and rewiring the existing
  `moduleResolution: "bundler"` setup for it is a much larger
  change than the problem warrants.
- **Regex linter on bare-specifier `@baerly/*` imports.** Cheap,
  one script, runs in `verify:agent` in milliseconds. Catches
  both back-edges and sibling-adapter imports. Source of truth
  for the allow list lives in this ADR; the executable mirror
  lives in
  [`scripts/lint-package-layers.mjs`](../../scripts/lint-package-layers.mjs).

## Decision

Adopt the regex linter. The hand-maintained package allow list is:

| Owner package | May import |
|---|---|
| `protocol` | (nothing — protocol must remain pure) |
| `server` | `protocol` |
| `dev` | `protocol`, `server`, `adapter-node` |
| `adapter-node` | `protocol`, `server`, `dev` |
| `adapter-cloudflare` | `protocol`, `server`, `dev` |
| `client` | `protocol`, `server` |
| `cli` | `protocol`, `server`, `dev`, `adapter-node`, `adapter-cloudflare`, `client` |
| `create-baerly-storage` | `protocol`, `server`, `cli` |

Self-imports (the owner package importing itself via its bare
specifier) are allowed. Anything not in the row is forbidden.

The script
[`scripts/lint-package-layers.mjs`](../../scripts/lint-package-layers.mjs)
walks `packages/*/src/**` (excluding `*.test.ts` and
`*.test-d.ts`), matches both bare (`@baerly/server`) and subpath
(`@baerly/server/http`) specifiers, classifies by package name,
and exits non-zero on any violation with a remediation hint.
Wired into `pnpm verify` and `pnpm verify:agent`.

## Consequences

- **The load-bearing constraint is now mechanically enforced.**
  Adding a back-edge into the protected layers (`protocol`
  importing `server`, `server` importing any adapter, or any
  unlisted cross-package import) fails `pnpm verify` at edit
  time. The previous guard chain (reviewer → bundle-size →
  manual-e2e) still exists as defence in depth, but the first
  gate is now seconds instead of hours.
- **No sibling adapter imports.** `adapter-node` and
  `adapter-cloudflare` cannot import each other; if a helper
  needs to be shared, it moves down into `@baerly/protocol`,
  `@baerly/server`, or `@baerly/dev` (in that order of
  preference: deeper is better because more consumers can
  reach it without violating the layer rule).
- **Future packages must amend `RULES`.** When a new
  `@baerly/*` package lands, the linter will silently accept
  any import it makes (the owner has no rule, so the loop
  skips it) — the bug surface is the *imported* side, where
  unrecognised owner packages mean their imports are not gated.
  The fix is to add the row to both this ADR and to the
  `RULES` table in the script in the same PR. There is no
  inference; the allow list is hand-maintained on purpose so
  that each new edge gets a deliberate review.
- **The `dev ↔ adapter-node` cycle is accepted.** Both edges
  exist today: `@baerly/dev`'s Vite plugin uses `baerlyNode` as
  the in-process listener for the dev middleware path, and
  `@baerly/adapter-node`'s `dev-landing` middleware uses
  `renderDevLanding` as a runtime value for the dev landing
  page. The cycle is Node-only and will never reach Workerd.
  Breaking it would require splitting `@baerly/dev` — either
  moving `vite-plugin.ts` into `adapter-node`, or moving
  `renderDevLanding` to a sibling package that `dev` does not
  consume at value level — and that is a separate refactor.
- **The lock is reversible with cost.** A future supersession
  ADR can rewrite the allow list (e.g. if `client` grows a
  legitimate need to import `dev`, or if the dev/adapter
  split is restructured). The script's `RULES` table moves
  in lockstep with the ADR; neither is the source of truth
  on its own.

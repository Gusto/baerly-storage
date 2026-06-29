---
title: Package layer invariant
audience: adr
doc_type: adr
summary: ADR 006 — hand-maintained package import allow list, enforced by scripts/lint-package-layers.mjs.
last-reviewed: 2026-06-14
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
- **Regex linter on `@baerly/*` imports + `node:`-builtin purity.**
  Cheap, one script, runs in `verify:agent` in milliseconds. Catches
  back-edges, sibling-adapter imports (static, dynamic `import()`,
  and relative cross-package), and Workerd-incompatible `node:`
  builtins in `protocol` / `server`. Source of truth for the allow
  list lives in this ADR; the executable mirror lives in
  [`scripts/lint-package-layers.mjs`](../../scripts/lint-package-layers.mjs).
- **A graph-based dependency tool** (`dependency-cruiser`, Nx
  `enforce-module-boundaries`, `eslint-plugin-boundaries`). These
  resolve the real module graph, so they see dynamic and relative
  edges natively and can forbid `node:` builtins and distinguish
  type-only edges out of the box. CLAUDE.md green-lights
  build-time/dev-tooling deps, so adopting one would be in-policy.
  **Not taken:** config-as-data for a graph tool is heavier than the
  ~120-line script for an 8-node graph that already has an in-process
  unit-test harness, and the gaps above close in a handful of lines
  in the existing idiom. Revisit at N>12 packages, or the first real
  dynamic-import need that the climb-out heuristic can't classify.

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
`*.test-d.ts`), matches bare (`@baerly/server`), subpath
(`@baerly/server/http`), **and dynamic** (`import("@baerly/server")`)
specifiers, **resolves relative cross-package imports**
(`../../adapter-cloudflare/src/...`) to their owning package,
classifies by package name, **and forbids Workerd-incompatible
`node:` builtins from `protocol` and `server`** (server allowlists
`node:async_hooks`, which Workerd supports under `nodejs_compat`).
It exits non-zero on any violation with a remediation hint. Wired
into `pnpm verify` and `pnpm verify:agent`.

The `node:`-purity gate is modelled as data on the same allow list:
each owner row carries an optional `allowNode` field
(`protocol: []`, `server: ["node:async_hooks"]`), and rows that leave
it undefined are Node-only by design and may import any builtin.
Relative cross-package detection matches the climb-out form
(`../../<name>/...`) and only fires when `<name>` is itself an
allow-list package — a relative import to a non-package sibling dir
is ignored. **Residual gaps (accepted):** a *dynamic-relative*
cross-package import (`import("../../adapter-cloudflare/...")`) is not
chased, and `import type` value-neutral edges are not distinguished
from value edges (the `node:` gate is the priority; type-only `node:`
imports are vanishingly rare in this kernel). Both are noted as
future refinements rather than overclaimed.

## Consequences

- **The load-bearing constraint is now mechanically enforced.**
  Adding a back-edge into the protected layers (`protocol`
  importing `server`, `server` importing any adapter, or any
  unlisted cross-package import) fails `pnpm verify` at edit
  time — and so does poisoning the kernel with a Node builtin
  (`import { createReadStream } from "node:fs"` in `protocol`),
  which the `node:`-purity gate is what makes literally true: the
  protocol-purity claim is no longer guarded only by reviewer
  attention + bundle budgets + a manual-e2e Workerd bounce-back.
  The previous guard chain (reviewer → bundle-size → manual-e2e)
  still exists as defence in depth, but the first gate is now
  seconds instead of hours.
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

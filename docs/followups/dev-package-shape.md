# `@baerly/dev`: narrow the public surface; remove CF-only assumptions

**Severity: MEDIUM. Four related fixes to the `@baerly/dev`
package — narrow the export surface, remove CF-flavored
hard-coding, gate the dev-only storage. Reviewable together;
same package, same intent.**

## 1. Public surface is broader than the consumers

`packages/dev/src/index.ts` exports `printDevBanner`,
`freeTierBudgetHint`, `renderDevLanding`, `LocalFsStorage`,
`ensureTable`, `baerlyDev`. Real consumers:

- `packages/cli/src/dev.ts` (in-repo CLI)
- `examples/helpdesk` (in-repo teaching fixture)
- one CF integration test, one Node integration test

Six exports for what's effectively two users — the CLI and one
example. `@baerly/dev` is internal infra dressed up as a
library.

**Fix:** Reduce the public surface to three:
`LocalFsStorage`, `ensureTable`, `baerlyDev` (the Vite plugin).
Move `printDevBanner` / `freeTierBudgetHint` / `renderDevLanding`
to a `@baerly/dev/internal` subpath (or to
`packages/cli/src/internal/`) since the CLI is in-repo and can
import from there directly.

The user-facing story stays: "use `@baerly/dev` for local dev
storage + Vite plugin." The CLI's banner + budget helpers stop
being part of any future-published surface.

## 2. `freeTierBudgetHint` hard-codes R2 in a vendorless codebase

`packages/dev/src/budget-hint.ts:2,20,25,28` references the R2
free-tier constants and emits R2-specific capacity hints
unconditionally. `baerly dev` consumes it without parameterising
on the user's storage flavor.

An AWS / Minio / GCS user sees Cloudflare-branded ops budgets
in their dev banner. Misleading and CF-flavored in a deliberately
storage-agnostic codebase.

**Fix — pick one:**

- **Parameterise on storage flavor.** Pass the detected backend
  (`r2-binding` / `s3-http` / `local-fs` / `memory`) into
  `freeTierBudgetHint`; emit the appropriate vendor's free-tier
  numbers, or "self-hosted / no free-tier ceiling" for
  `local-fs` and `memory`.
- **Drop the export and inline on CF-aware paths only.** Move
  the R2 budget hint into the CF-side dev banner code path. The
  Node banner stops mentioning free tiers entirely.

The first option preserves the helpful framing for users on
each backend; the second is the smaller surface.

## 3. `LocalFsStorage` has no runtime guard against accidental prod use

`packages/dev/src/local-fs.ts` constructor has no runtime
guard — only JSDoc warnings about cross-process TOCTOU.
`examples/helpdesk` uses it for a quasi-production-shaped server
(single Vite process). `packages/cli/src/copy.ts` mounts it on
`file://` URIs without checking.

A user copy-pasting the helpdesk pattern into a real deployment
gets data corruption under any concurrent writer — no runtime
warning fires.

**Fix — pick one:**

- **Runtime warn outside `NODE_ENV=test`.** One-time
  `console.warn` on instantiation:
  ```ts
  if (process.env.NODE_ENV !== "test" && !this.#warned) {
    console.warn("[baerly] LocalFsStorage is dev-only — not safe for production. Use an S3-compatible adapter instead.");
    this.#warned = true;
  }
  ```
- **Rename to `DevFsStorage`.** Self-documenting at every call
  site. More invasive (touches imports), but the intent is
  visible without runtime code.

Pair option A with option B for belt-and-braces. Or take option
B alone for the cleanest API.

## 4. `baerlyDev` Vite plugin is `LocalFsStorage`-only with no override

`packages/dev/src/vite-plugin.ts:~67` hard-codes
`new LocalFsStorage({ root: opts.dataDir })`. The verifier path
is similarly hard-wired to `sharedSecret`. An agent wanting Minio
in dev has to drop down to raw `createListener` from the Node
adapter.

**Fix — pick one:**

- **Accept overrides:** `baerlyDev({ storage?: Storage,
  verifier?: Verifier })`. Default behaviour unchanged; advanced
  users override. ~10 LoC.
- **Rename to `baerlyLocalFsDev`.** Honest about scope; users
  who need other backends use a different entry. More
  conservative API.

The first option is the user-affirming default. The second is
the "be honest about what we do" default. Both fix the
discoverability gap.

## Why bundle

All four touch `@baerly/dev`. All four are about "what does the
dev experience look like and what's it pretending to be." A
single PR keeps the surface decisions coherent.

## Cross-references

- `dev-vite-plugin-extract.md` already raises the workspace-cycle
  concern (`@baerly/dev` → `@baerly/adapter-node` →
  `@baerly/dev`); narrowing the public surface here doesn't fix
  the cycle but doesn't worsen it.
- F17 (`adapter-maintenance-shape-unify.md` if extracted) is
  loosely related — both touch how non-server packages re-export
  server kernel pieces.

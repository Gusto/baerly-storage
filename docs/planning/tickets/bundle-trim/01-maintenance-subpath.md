# 01 — `runScheduledMaintenance` → `baerly-storage/maintenance` subpath

**One-liner.** Promote `runScheduledMaintenance` and its sibling
exports (`NODE_PROFILE`, `CLOUDFLARE_FREE_TIER`,
`CLOUDFLARE_PAID_TIER`, plus the `MaintenanceArgs` /
`MaintenanceOptions` / `MaintenanceResult` types) to their own
subpath entry `@baerly/server/maintenance`, matching the existing
`/auth`, `/http`, `/observability` subpath pattern. Drop the
maintenance re-export block from the kernel barrel.

**Estimated effort.** ~0.75 day. **Risk.** Low — pure shuffle of
import paths; no runtime semantic change. `pnpm verify`
(`tsgo --noEmit`) catches every missed rename.

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo,
> and the conventions referenced at the bottom.

## Why we're doing this

The kernel barrel at `packages/server/src/index.ts` currently
re-exports `runScheduledMaintenance` and its profile constants:

```ts
// packages/server/src/index.ts:47-55
export {
  type MaintenanceArgs,
  type MaintenanceOptions,
  type MaintenanceResult,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  NODE_PROFILE,
  runScheduledMaintenance,
} from "./maintenance.ts";
```

Maintenance is an **operator concern** — a sweep loop that runs
on a cron trigger or out-of-band scheduler (Cloudflare Cron
Triggers, systemd timers, the `baerly admin compact` CLI). App
code that imports `Db` to do CRUD does not call
`runScheduledMaintenance`. By keeping these on the barrel, every
consumer of `Db` transitively pulls `maintenance.ts` →
`compactor.ts` + `gc.ts` + the observability subgraph
(`withObservability`) into their static-import closure.

The repo already follows the "subpath per concern" pattern for
auth (`@baerly/server/auth`), the HTTP router
(`@baerly/server/http`), and observability primitives
(`@baerly/server/observability`). Adding a `/maintenance` entry
fits that pattern exactly. The lib is not yet published, so
consumer import-path churn is contained to this monorepo.

As a side effect, `dist/index.js` should shrink by however many
bytes the maintenance subgraph contributes. The exact savings
are measured in ticket 03; this ticket does NOT touch the
bundle-size budgets.

## Current state

### Library

- **`rolldown.config.ts`** (verified, lines 1-15):

  ```ts
  import { defineConfig } from "rolldown";
  import { dts } from "rolldown-plugin-dts";

  export default defineConfig({
    input: {
      index: "packages/server/src/index.ts",
      auth: "packages/server/src/auth/index.ts",
      http: "packages/server/src/http/index.ts",
      observability: "packages/server/src/observability/index.ts",
    },
    external: ["vitest", "@fast-check/vitest", "@vitest/expect"],
    output: {
      dir: "dist",
      format: "esm",
      sourcemap: true,
    },
    plugins: [dts({ tsgo: true })],
  });
  ```

  Needs a fifth entry: `maintenance:
  "packages/server/src/maintenance.ts"`.

- **`packages/server/package.json`** (verified, the `exports`
  and `publishConfig.exports` blocks):

  ```json
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    },
    "./auth": {
      "types": "./src/auth/index.ts",
      "import": "./src/auth/index.ts"
    },
    "./http": {
      "types": "./src/http/index.ts",
      "import": "./src/http/index.ts"
    },
    "./observability": {
      "types": "./src/observability/index.ts",
      "import": "./src/observability/index.ts"
    }
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      },
      "./auth": {
        "types": "./dist/auth.d.ts",
        "import": "./dist/auth.js"
      },
      "./http": {
        "types": "./dist/http.d.ts",
        "import": "./dist/http.js"
      },
      "./observability": {
        "types": "./dist/observability.d.ts",
        "import": "./dist/observability.js"
      }
    }
  }
  ```

  Each block needs a `./maintenance` entry mirroring `./auth`.

- **`packages/server/src/index.ts:47-55`** — the maintenance
  re-export block (delete it):

  ```ts
  export {
    type MaintenanceArgs,
    type MaintenanceOptions,
    type MaintenanceResult,
    CLOUDFLARE_FREE_TIER,
    CLOUDFLARE_PAID_TIER,
    NODE_PROFILE,
    runScheduledMaintenance,
  } from "./maintenance.ts";
  ```

- **`packages/server/src/maintenance.ts`** — already exports its
  own surface (the barrel re-exports it from there). After this
  ticket, this file becomes the subpath entry directly. The
  existing top-level `export`s on `MaintenanceArgs`,
  `MaintenanceOptions`, `MaintenanceResult`, `CLOUDFLARE_FREE_TIER`,
  `CLOUDFLARE_PAID_TIER`, `NODE_PROFILE`, and
  `runScheduledMaintenance` are exactly what `@baerly/server/maintenance`
  will resolve. Spot-check that these are top-level `export`
  statements (not just `function runScheduledMaintenance() ...`
  declarations that would also need an explicit export).

  Also note the JSDoc `@example` at line 79 currently shows:

  ```ts
  /**
   * ...
   * @example
   * import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server";
   * ...
   */
  ```

  The import path needs updating to `@baerly/server/maintenance`
  so IDE hover matches the new path.

### Consumers (six files)

Each block below shows the **current** import on the listed
line(s) and what it needs to become. Where the block mixes
maintenance-only symbols with retained-barrel symbols, split
into two imports.

**`bench/compactor-loop.ts:14`** (single line, all moves):

```ts
// Current
import { NODE_PROFILE, runScheduledMaintenance, type MaintenanceResult } from "@baerly/server";

// After
import { NODE_PROFILE, runScheduledMaintenance, type MaintenanceResult } from "@baerly/server/maintenance";
```

**`bench/load-harness/runner/compact.ts:18-23`** (multi-line,
all moves):

```ts
// Current
import {
  runScheduledMaintenance,
  NODE_PROFILE,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
} from "@baerly/server";

// After
import {
  runScheduledMaintenance,
  NODE_PROFILE,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
} from "@baerly/server/maintenance";
```

**`tests/integration/phase5-end-to-end.test.ts:51`** (mixed —
split):

```ts
// Current
import { Db, NODE_PROFILE, runScheduledMaintenance, ServerWriter } from "@baerly/server";

// After
import { Db, ServerWriter } from "@baerly/server";
import { NODE_PROFILE, runScheduledMaintenance } from "@baerly/server/maintenance";
```

**`packages/adapter-node/src/server.ts:10-26`** (mixed — split
out `NODE_PROFILE` + `runScheduledMaintenance`):

```ts
// Current
import {
  CATEGORY,
  Db,
  type DevLandingOptions,
  MAX_BODY_BYTES,
  NODE_PROFILE,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createRouter,
  errorEnvelope,
  getLogger,
  mapError,
  observableStorage,
  renderDevLanding,
  runScheduledMaintenance,
} from "@baerly/server";

// After (this ticket — T02 will further split out observability symbols later)
import {
  CATEGORY,
  Db,
  type DevLandingOptions,
  MAX_BODY_BYTES,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createRouter,
  errorEnvelope,
  getLogger,
  mapError,
  observableStorage,
  renderDevLanding,
} from "@baerly/server";
import { NODE_PROFILE, runScheduledMaintenance } from "@baerly/server/maintenance";
```

**`packages/adapter-cloudflare/src/worker.ts:2-17`** (mixed —
split out `CLOUDFLARE_FREE_TIER` + `CLOUDFLARE_PAID_TIER` +
`runScheduledMaintenance`):

```ts
// Current
import {
  CATEGORY,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  Db,
  type DevLandingOptions,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createRouter,
  errorEnvelope,
  getLogger,
  observableStorage,
  renderDevLanding,
  runScheduledMaintenance,
} from "@baerly/server";

// After (this ticket — T02 will further split out observability symbols later)
import {
  CATEGORY,
  Db,
  type DevLandingOptions,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createRouter,
  errorEnvelope,
  getLogger,
  observableStorage,
  renderDevLanding,
} from "@baerly/server";
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  runScheduledMaintenance,
} from "@baerly/server/maintenance";
```

**`packages/cli/src/admin/compact.ts:33-39`** (multi-line, all
moves):

```ts
// Current
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  NODE_PROFILE,
  runScheduledMaintenance,
  type MaintenanceOptions,
} from "@baerly/server";

// After
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  NODE_PROFILE,
  runScheduledMaintenance,
  type MaintenanceOptions,
} from "@baerly/server/maintenance";
```

### Docs

Only one doc has an import-line example for a moved symbol:

- **`packages/server/src/maintenance.ts:79`** — JSDoc `@example`
  currently writes
  `import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server";`.
  Update to `from "@baerly/server/maintenance";` so IDE hover
  matches the new path.

Other docs (`docs/architecture.md`, `docs/features.md`,
`docs/observability.md`, `docs/cost-model.md`,
`docs/operating/backups.md`, `CLAUDE.md`, the various
`AGENTS.md` files) mention `runScheduledMaintenance`,
`NODE_PROFILE`, `CLOUDFLARE_FREE_TIER`, etc. **by name** but
not via an `import` line — so no changes needed there. Verify
with a grep at the start of the implementation:

```sh
grep -rnE 'from "@baerly/server"' docs/ CLAUDE.md examples/*/AGENTS.md examples/*/README.md
```

If any new doc references appear, update them to match.

## Implementation steps

### Step 1. Add the rolldown entry

Edit `rolldown.config.ts`. Add `maintenance` after `observability`:

```ts
input: {
  index: "packages/server/src/index.ts",
  auth: "packages/server/src/auth/index.ts",
  http: "packages/server/src/http/index.ts",
  maintenance: "packages/server/src/maintenance.ts",
  observability: "packages/server/src/observability/index.ts",
},
```

(Alphabetical ordering for legibility; not required by the
bundler.)

### Step 2. Add the package.json exports entry

Edit `packages/server/package.json`. Insert a `./maintenance`
entry in both `exports` and `publishConfig.exports`, mirroring
the `./auth` entry's shape:

```json
"exports": {
  ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
  "./auth": { "types": "./src/auth/index.ts", "import": "./src/auth/index.ts" },
  "./http": { "types": "./src/http/index.ts", "import": "./src/http/index.ts" },
  "./maintenance": { "types": "./src/maintenance.ts", "import": "./src/maintenance.ts" },
  "./observability": { "types": "./src/observability/index.ts", "import": "./src/observability/index.ts" }
},
"publishConfig": {
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./auth": { "types": "./dist/auth.d.ts", "import": "./dist/auth.js" },
    "./http": { "types": "./dist/http.d.ts", "import": "./dist/http.js" },
    "./maintenance": { "types": "./dist/maintenance.d.ts", "import": "./dist/maintenance.js" },
    "./observability": { "types": "./dist/observability.d.ts", "import": "./dist/observability.js" }
  }
}
```

(Match the file's existing formatting — the actual JSON in the
file uses one-key-per-line indented form; preserve that.)

### Step 3. Delete the maintenance re-export block from the barrel

Edit `packages/server/src/index.ts`. Delete lines 47-55 (the
nine-line `export { ... } from "./maintenance.ts";` block).
Leave the surrounding `export`s untouched — T02 handles the
observability re-export block at lines 61-88; T01 must not
touch that.

After your edit, line 47 onwards should jump from whatever
preceded the deleted block straight to the next existing
export (`migrate`, `observability`, etc., depending on line
numbers that may shift after deletion). Verify with `git diff
packages/server/src/index.ts` that only the maintenance block
was removed.

### Step 4. Verify `maintenance.ts` re-exports its surface

The maintenance subpath entry is `packages/server/src/maintenance.ts`
itself. Its current top-level exports must include everything
the barrel used to re-export:

```sh
grep -nE '^export ' packages/server/src/maintenance.ts
```

Expected to find top-level `export`s for at least:
`MaintenanceArgs`, `MaintenanceOptions`, `MaintenanceResult`,
`CLOUDFLARE_FREE_TIER`, `CLOUDFLARE_PAID_TIER`, `NODE_PROFILE`,
`runScheduledMaintenance`. If any of these are declared at the
top level without an `export` keyword (e.g., `const
NODE_PROFILE = ...` without `export`), promote them. The barrel
re-export from `./maintenance.ts` succeeded because they're
already exported — but verify.

### Step 5. Update the JSDoc example

Edit `packages/server/src/maintenance.ts:79` (the `@example`
block). Change:

```ts
 * import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server";
```

To:

```ts
 * import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server/maintenance";
```

### Step 6. Retarget the six consumer imports

Apply the edits described in **Current state → Consumers**
above. Use the Edit tool's `old_string` / `new_string` for each
block exactly as shown — preserve the existing import ordering
within each block (alphabetical or otherwise) so reformat-on-
save doesn't add noise to the diff.

After each edit, sanity-check with:

```sh
grep -nE 'runScheduledMaintenance|NODE_PROFILE|CLOUDFLARE_FREE_TIER|CLOUDFLARE_PAID_TIER|MaintenanceArgs|MaintenanceOptions|MaintenanceResult' \
  <file> | head
```

The grep should show the symbols in `@baerly/server/maintenance`
import blocks only.

### Step 7. Audit-grep for any consumer not listed in this ticket

Run:

```sh
grep -rnE '\brunScheduledMaintenance\b|\bNODE_PROFILE\b|\bCLOUDFLARE_FREE_TIER\b|\bCLOUDFLARE_PAID_TIER\b|\bMaintenanceArgs\b|\bMaintenanceOptions\b|\bMaintenanceResult\b' \
  bench tests packages examples manual-e2e \
  --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.mjs" \
  | grep 'from "@baerly/server"' \
  | grep -v '/maintenance"'
```

This must return **zero hits**. If it returns hits, those are
import sites missed by the implementation steps above — add
them to the rename and re-verify.

### Step 8. Build + verify

```sh
pnpm install         # in case the new exports entry needs re-linking
pnpm build           # confirm `dist/maintenance.js` is produced
ls dist/maintenance.js dist/maintenance.d.ts  # both should exist
pnpm verify          # tsgo --noEmit + oxlint; catches every missed rename
```

If `pnpm verify` reports any TS errors, they're missed imports —
fix and re-run.

### Step 9. Commit

One commit, conventional-commits style:

```
refactor(server): move maintenance to its own subpath entry

Promotes runScheduledMaintenance + profile constants
(NODE_PROFILE, CLOUDFLARE_FREE_TIER, CLOUDFLARE_PAID_TIER) and
their types to @baerly/server/maintenance, matching the
existing /auth, /http, /observability subpath pattern.
Maintenance is an operator concern (cron sweeps, `baerly admin
compact`) — app code doing CRUD doesn't need it on the kernel
barrel.

Retargets consumers in bench/, tests/, examples/, packages/.
No runtime semantic change.

Refs docs/followups/first-touch-dx.md item 2.
```

## Conventions to follow

- **`.ts` extension on relative imports.** Already pervasive
  in the repo; oxlint's `import/extensions` rule enforces it.
  The new subpath spec is `"@baerly/server/maintenance"` — a
  bare module specifier, no extension.
- **Don't touch the bundle-size budgets.** That's T03's job;
  the BUDGETS table stays with its current `skip: true` flags
  after T01 + T02 merge. T03 measures the post-merge bundle
  and updates the table.
- **Don't add new dependencies.** The repo is intentionally
  thin (`aws4fetch`, `idb-keyval`, `@xmldom/xmldom`,
  `hono`, `@logtape/logtape`). This ticket adds zero deps.
- **Atomic commit.** One `refactor(server)` commit for the
  whole ticket; do not split into "library" vs "consumers" vs
  "docs" commits.

## Verification

Run from the ticket subagent's worktree root before reporting
done:

```sh
pnpm install
pnpm build
ls dist/maintenance.js dist/maintenance.d.ts            # both exist
pnpm verify                                              # exit 0
pnpm test                                                # all pass (bundle-size still skip: true)
# Sanity grep:
grep -rnE '\brunScheduledMaintenance\b|\bNODE_PROFILE\b|\bCLOUDFLARE_FREE_TIER\b|\bCLOUDFLARE_PAID_TIER\b|\bMaintenanceArgs\b|\bMaintenanceOptions\b|\bMaintenanceResult\b' \
  bench tests packages examples manual-e2e \
  --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.mjs" \
  | grep 'from "@baerly/server"' \
  | grep -v '/maintenance"'
# Expected: zero hits.

# Adapter conformance, requires `pnpm dev:storage` up in another shell:
pnpm dev:storage    # if not already running
pnpm test:adapters  # adapter-node + adapter-cloudflare
```

All commands must succeed before reporting done.

## Out of scope

- **Bundle-size budget changes.** That's T03's job. The
  BUDGETS table at `tests/integration/bundle-size.test.ts:47-69`
  stays exactly as-is in this ticket. `skip: true` flags
  remain on `index.js` and `http.js`.
- **Touching the observability re-export block** at
  `packages/server/src/index.ts:61-88`. That's T02's job.
  Disjoint line range from T01's deletion.
- **Adding `maintenance.js` to the BUDGETS table.** T03 adds
  that row after measuring the actual size of the new entry.
- **Renaming or refactoring `maintenance.ts` itself.** It's
  already the subpath entry as written; just verify its
  top-level exports.
- **Touching `docs/architecture.md`, `docs/features.md`, etc.**
  Those mention `runScheduledMaintenance` by name in prose,
  not via import-line examples. No path-string update needed
  in those files.

## Conflict notes

- **T02 also edits `packages/server/src/index.ts`.** Disjoint
  line ranges: T01 = lines 47-55, T02 = lines 61-88. If a
  merge conflict arises, the safe resolution is the union of
  both deletions.
- **T01 also retargets `packages/adapter-node/src/server.ts`
  and `packages/adapter-cloudflare/src/worker.ts`.** T02 will
  further split the observability symbols out of those same
  import blocks. T01's post-edit state has the observability
  symbols still on `@baerly/server`; T02's diff then moves
  them. The merge order is irrelevant — but the same import
  block may be reformatted by both subagents. Read the diff
  after each merge to confirm no scope creep.

## Pointers

- `rolldown.config.ts:5-9` — entry-point map.
- `packages/server/package.json` — `exports` + `publishConfig.exports`.
- `packages/server/src/index.ts:47-55` — the maintenance
  re-export block to delete.
- `packages/server/src/maintenance.ts:79` — JSDoc `@example`
  with the old import path.
- Subpath pattern reference: `packages/server/src/auth/index.ts`,
  `packages/server/src/http/index.ts`,
  `packages/server/src/observability/index.ts`.
- Bundle-size test (do not touch): `tests/integration/bundle-size.test.ts:47-69`.
- Followup tracking this work:
  `docs/followups/first-touch-dx.md:67-86`.

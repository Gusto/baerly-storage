# 02 — Drop observability re-exports from the kernel barrel

**One-liner.** Delete the 23 observability re-exports from
`packages/server/src/index.ts:61-88`. Consumers reach the same
symbols via the existing `@baerly/server/observability` subpath.
Removes a redundant API surface and lets the kernel barrel
stop carrying operator-side observability primitives.

**Estimated effort.** ~0.5 day. **Risk.** Low — pure shuffle of
import paths; no runtime semantic change. `pnpm verify`
(`tsgo --noEmit`) catches every missed rename.

---

> **Self-contained.** You don't need to consult any planning
> notes or chat logs. Everything you need is in this file, the
> repo, and the conventions referenced at the bottom.

## Why we're doing this

The kernel barrel at `packages/server/src/index.ts` currently
re-exports 23 observability symbols from
`./observability/index.ts`:

```ts
// packages/server/src/index.ts:61-88
export {
  type CategoryName,
  type FlushCanonicalLineOptions,
  type FriendlyLogLevel,
  type MetricsSnapshot,
  type MetricsSummary,
  type ObservabilityConfig,
  type ObservabilityContext,
  type ObservabilityContextInit,
  type ObservationRow,
  type SerializedError,
  type Unit,
  CATEGORY,
  RequestScopedMetricsRecorder,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  decideSample,
  flushCanonicalLine,
  getCurrentContext,
  getEffectiveSampleRate,
  getLogger,
  observableStorage,
  peekContext,
  runWithContext,
  serializeError,
  withObservability,
} from "./observability/index.ts";
```

All of these are operator-side primitives:
`configureObservability` (called once at boot),
`RequestScopedMetricsRecorder` (the per-request recorder),
`flushCanonicalLine` / `withObservability` (canonical-line
emission), `observableStorage` (the storage decorator),
`getLogger` + `CATEGORY` (logger handles). App code doing
`db.table().insert()` does not call any of these.

The repo already exposes `@baerly/server/observability` as a
dedicated subpath entry (see `packages/server/package.json` and
`rolldown.config.ts`). Re-exporting the same surface from the
barrel is just two surfaces for the same symbols — every
addition to observability needs to be propagated in both places,
and every consumer who reaches for them has two paths to choose
from.

By dropping the barrel re-exports, the canonical path becomes
`@baerly/server/observability` and `dist/index.js` no longer has
to keep observability statically reachable for barrel consumers
that don't otherwise pull it in.

The lib is not yet published, so consumer import-path churn is
contained to this monorepo.

As a side effect, `dist/index.js` may shrink (depending on
whether `runScheduledMaintenance` is also moved off the barrel —
see T01). The exact savings are measured in ticket 03; this
ticket does NOT touch the bundle-size budgets.

## Current state

### Library

- **`packages/server/src/index.ts:61-88`** — the observability
  re-export block (delete it). The block is **27 lines** (line
  61 = `export {`, line 88 = `} from "./observability/index.ts";`).
  Leave the surrounding `export`s untouched. The block to
  delete is the one quoted in **Why we're doing this** above.

- **`packages/server/package.json`** already has the
  `./observability` subpath entry in both `exports` and
  `publishConfig.exports`. No change needed there.

- **`packages/server/src/observability/index.ts`** is the
  subpath entry — its top-level `export`s already cover the 23
  symbols. No change needed.

### Consumers (6 known files; grep for more at execute time)

The 23 symbols that move (split each consumer's import block
where mixed):

- **Types (11):** `CategoryName`, `FlushCanonicalLineOptions`,
  `FriendlyLogLevel`, `MetricsSnapshot`, `MetricsSummary`,
  `ObservabilityConfig`, `ObservabilityContext`,
  `ObservabilityContextInit`, `ObservationRow`,
  `SerializedError`, `Unit`.
- **Values (15):** `CATEGORY`, `RequestScopedMetricsRecorder`,
  `alsAwareRecorder`, `configureObservability`,
  `createObservabilityContext`, `decideSample`,
  `flushCanonicalLine`, `getCurrentContext`,
  `getEffectiveSampleRate`, `getLogger`, `observableStorage`,
  `peekContext`, `runWithContext`, `serializeError`,
  `withObservability`.

(26 total in the re-export block; the 23-count drops the three
that aren't on this list. Trust the re-export block at lines
61-88 as authoritative; if any symbol there isn't in the
implementation steps below, add it.)

Known consumer sites from `grep -rn 'from "@baerly/server"'`:

**`packages/adapter-node/src/server.ts:10-26`** (mixed — split
out observability symbols):

```ts
// State after T01 (T01 will already have removed NODE_PROFILE +
// runScheduledMaintenance to /maintenance — assume T01 lands first
// or merge order doesn't matter):
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

// After T02
import {
  Db,
  type DevLandingOptions,
  MAX_BODY_BYTES,
  createRouter,
  errorEnvelope,
  mapError,
  renderDevLanding,
} from "@baerly/server";
import {
  CATEGORY,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  getLogger,
  observableStorage,
} from "@baerly/server/observability";
```

**`packages/adapter-cloudflare/src/worker.ts:2-17`** (mixed —
split out observability symbols):

```ts
// State after T01:
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

// After T02
import {
  Db,
  type DevLandingOptions,
  createRouter,
  errorEnvelope,
  renderDevLanding,
} from "@baerly/server";
import {
  CATEGORY,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  getLogger,
  observableStorage,
} from "@baerly/server/observability";
```

**`tests/integration/observability.test.ts:51-60`** (all
observability — retarget the whole block):

```ts
// Current
import {
  Db,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  flushCanonicalLine,
  observableStorage,
  runWithContext,
  type ObservabilityContext,
} from "@baerly/server";

// After
import { Db } from "@baerly/server";
import {
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  flushCanonicalLine,
  observableStorage,
  runWithContext,
  type ObservabilityContext,
} from "@baerly/server/observability";
```

**`examples/minimal-cloudflare/apps/server/src/worker.ts:21`**
(type-only, retarget):

```ts
// Current
import type { FriendlyLogLevel } from "@baerly/server";

// After
import type { FriendlyLogLevel } from "@baerly/server/observability";
```

**`examples/minimal-node/apps/server/src/server.ts:16`**
(type-only, retarget):

```ts
// Current
import type { FriendlyLogLevel } from "@baerly/server";

// After
import type { FriendlyLogLevel } from "@baerly/server/observability";
```

**`examples/helpdesk-cloudflare/apps/server/src/worker.ts:12`**
(type-only, retarget):

```ts
// Current
import type { FriendlyLogLevel } from "@baerly/server";

// After
import type { FriendlyLogLevel } from "@baerly/server/observability";
```

### Docs

No doc files reference the 23 observability symbols in an
`import` line — they mention symbols by name only. Verify with
a grep at execute time:

```sh
grep -rnE 'from "@baerly/server"' docs/ CLAUDE.md examples/*/AGENTS.md examples/*/README.md
```

If any line imports an observability symbol from `@baerly/server`,
update it to `@baerly/server/observability`.

## Implementation steps

### Step 1. Delete the observability re-export block from the barrel

Edit `packages/server/src/index.ts`. Delete lines 61-88 (the
27-line `export { ... } from "./observability/index.ts";` block).

If T01 has not yet landed at the time you do this, the line
numbers above are correct relative to the file's pre-T01 state.
If T01 has already landed and deleted lines 47-55, your
observability block has moved up by 9 lines (now lines 52-79).
**Find the block by its content, not its line number** — search
for `from "./observability/index.ts";` and delete the
surrounding `export {` block.

Leave the surrounding `export`s untouched: the maintenance
block (if still present) belongs to T01; the auth block and
other re-exports must remain. Verify with `git diff
packages/server/src/index.ts` that only the observability
block was removed.

### Step 2. Retarget the six known consumer imports

Apply the edits described in **Current state → Consumers**
above. Use the Edit tool's `old_string` / `new_string` for each
block.

**For `packages/adapter-node/src/server.ts` and
`packages/adapter-cloudflare/src/worker.ts`:** the post-T01
state of these blocks is what you edit. If T01 has not landed
in your worktree when you start (your worktree was branched
off `bundle-trim` before T01 merged), the pre-T01 state
includes `NODE_PROFILE` / `runScheduledMaintenance` /
`CLOUDFLARE_FREE_TIER` / `CLOUDFLARE_PAID_TIER`. Don't touch
those — leave them where they are; T01's merge will retarget
them.

You're only responsible for the observability symbols
(`CATEGORY`, `ObservabilityConfig`, `alsAwareRecorder`,
`configureObservability`, `getLogger`, `observableStorage`).
Split those out into a separate `@baerly/server/observability`
import. The maintenance symbols stay on `@baerly/server` for
now; T01's merge will move them.

**For `tests/integration/observability.test.ts`:** the whole
multi-line block at lines 51-60 (after the `from "@baerly/protocol"`
block) retargets except for `Db`, which stays on
`@baerly/server`.

**For the three example files:** single-line type imports.
Just change the source.

### Step 3. Audit-grep for any consumer not listed in this ticket

Run:

```sh
grep -rnE '\bCategoryName\b|\bFlushCanonicalLineOptions\b|\bFriendlyLogLevel\b|\bMetricsSnapshot\b|\bMetricsSummary\b|\bObservabilityConfig\b|\bObservabilityContext\b|\bObservabilityContextInit\b|\bObservationRow\b|\bSerializedError\b|\bUnit\b|\bCATEGORY\b|\bRequestScopedMetricsRecorder\b|\balsAwareRecorder\b|\bconfigureObservability\b|\bcreateObservabilityContext\b|\bdecideSample\b|\bflushCanonicalLine\b|\bgetCurrentContext\b|\bgetEffectiveSampleRate\b|\bgetLogger\b|\bobservableStorage\b|\bpeekContext\b|\brunWithContext\b|\bserializeError\b|\bwithObservability\b' \
  bench tests packages examples manual-e2e \
  --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.mjs" \
  | grep 'from "@baerly/server"' \
  | grep -v '/observability"'
```

This must return **zero hits**. If it returns hits, those are
import sites missed by step 2 — add them to the rename and
re-verify.

(Heads-up: the `Unit` and `serializeError` patterns may
false-positive against unrelated `Unit` / `serializeError`
identifiers in the codebase. The `| grep 'from "@baerly/server"'`
filter removes those — the second grep is specifically
"imported from the kernel barrel" — so the result is precise.)

### Step 4. Build + verify

```sh
pnpm build           # confirm dist/index.js + dist/observability.js still produced
pnpm verify          # tsgo --noEmit + oxlint; catches every missed rename
```

If `pnpm verify` reports TS errors, they're missed imports —
fix and re-run.

### Step 5. Commit

One commit, conventional-commits style:

```
refactor(server): drop observability re-exports from kernel barrel

Removes the 23-symbol observability re-export block from
packages/server/src/index.ts. Consumers reach the same symbols
via @baerly/server/observability, which already exists as the
canonical subpath. Two surfaces for the same symbols was just
maintenance debt — observability is an operator concern, not
an app-code one.

Retargets consumers in bench/, tests/, examples/, packages/.
No runtime semantic change.

Refs docs/followups/first-touch-dx.md item 2.
```

## Conventions to follow

- **`.ts` extension on relative imports.** Already pervasive
  in the repo; oxlint's `import/extensions` rule enforces it.
  The new subpath spec is `"@baerly/server/observability"` —
  a bare module specifier, no extension.
- **Don't touch the bundle-size budgets.** That's T03's job;
  the BUDGETS table stays with its current `skip: true` flags
  after T01 + T02 merge.
- **Don't add new dependencies.**
- **Atomic commit.** One `refactor(server)` commit for the
  whole ticket.

## Verification

Run from the ticket subagent's worktree root before reporting
done:

```sh
pnpm install
pnpm build                                                # dist/observability.js still produced
pnpm verify                                                # exit 0
pnpm test                                                  # all pass (bundle-size still skip: true)

# Sanity grep — must return zero hits:
grep -rnE '\bCategoryName\b|\bFlushCanonicalLineOptions\b|\bFriendlyLogLevel\b|\bMetricsSnapshot\b|\bMetricsSummary\b|\bObservabilityConfig\b|\bObservabilityContext\b|\bObservabilityContextInit\b|\bObservationRow\b|\bSerializedError\b|\bUnit\b|\bCATEGORY\b|\bRequestScopedMetricsRecorder\b|\balsAwareRecorder\b|\bconfigureObservability\b|\bcreateObservabilityContext\b|\bdecideSample\b|\bflushCanonicalLine\b|\bgetCurrentContext\b|\bgetEffectiveSampleRate\b|\bgetLogger\b|\bobservableStorage\b|\bpeekContext\b|\brunWithContext\b|\bserializeError\b|\bwithObservability\b' \
  bench tests packages examples manual-e2e \
  --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.mjs" \
  | grep 'from "@baerly/server"' \
  | grep -v '/observability"'

# Adapter conformance, requires `pnpm dev:storage` up:
pnpm dev:storage
pnpm test:adapters                                         # adapter-node + adapter-cloudflare
```

All commands must succeed before reporting done.

## Out of scope

- **Bundle-size budget changes.** T03's job. The BUDGETS table
  at `tests/integration/bundle-size.test.ts:47-69` stays
  exactly as-is in this ticket.
- **Touching the maintenance re-export block** at
  `packages/server/src/index.ts:47-55`. That's T01's job.
- **Reorganising `packages/server/src/observability/`.** The
  subpath entry already exists and exports what we need.
  Don't touch it.
- **Dropping the auth re-exports** from the barrel. Auth
  presets are config-time and app-side; the barrel re-export
  is justified.
- **Touching docs that mention observability symbols in prose.**
  No path-string update needed — only `import` lines move.

## Conflict notes

- **T01 also edits `packages/server/src/index.ts`.** Disjoint
  line ranges: T01 = lines 47-55 (pre-edit), T02 = lines 61-88
  (pre-edit). If both subagents work from the same `bundle-trim`
  base, line 61 in T02's view shifts to line 52 after T01's
  merge (or vice versa); resolve by deleting both blocks
  (union).
- **T01 also retargets `packages/adapter-node/src/server.ts`
  and `packages/adapter-cloudflare/src/worker.ts`.** T02
  further splits those same import blocks. Read the diff
  after each merge to confirm no scope creep — both subagents
  should have left non-target symbols untouched.

## Pointers

- `packages/server/src/index.ts:61-88` — the observability
  re-export block to delete.
- `packages/server/src/observability/index.ts` — the subpath
  entry; consumers retarget here.
- `packages/server/package.json` — `./observability` entry
  already present in both `exports` and `publishConfig.exports`.
- `rolldown.config.ts` — `observability` entry already
  present.
- Bundle-size test (do not touch): `tests/integration/bundle-size.test.ts:47-69`.
- Followup tracking this work:
  `docs/followups/first-touch-dx.md:67-86`.

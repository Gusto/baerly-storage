# Maintenance: trim the options surface to what callers actually set

**Severity: MEDIUM. No behaviour change in production.**

`packages/server/src/{maintenance,compactor,gc}.ts` carry an
options surface — three named profiles, `skipCompact`/`skipGc`
flags, six knobs on `CompactOptions`/`RunGcOptions` — that no
production caller hand-tunes. The CF Worker, the Node adapter,
the CLI, and the test suite all pass either a profile constant or
a single override (the CLI's `--min-entries`).

After this cleanup:

- One maintenance profile (`CLOUDFLARE_FREE_TIER`), not three.
- `compactOnce` / `gcOnce` replace `runScheduledMaintenance + skipCompact + skipGc`.
- The public `CompactOptions`/`RunGcOptions` shapes carry only what callers
  actually set (`minEntriesToCompact`, `signal`, `metrics`) — the
  unbounded-cap knobs and the test-only `now` injector move off the
  public type.

Coherent workstream — bundle or split as convenient. Sections 1
and 2 are coupled by the cron handler in
`packages/adapter-cloudflare/src/worker.ts:412-428`; do them
together.

---

## 1. Drop `NODE_PROFILE`; reduce to one named profile

`packages/server/src/maintenance.ts:158-179` defines three
profiles. Compared against the engine defaults
(`packages/server/src/compactor.ts:181`'s `DEFAULT_MIN_TO_COMPACT
= 100`, etc.):

| Profile | `maxEntriesPerRun` | `minEntriesToCompact` | `maxMarksPerRun` | `maxSweepsPerRun` |
|---|---|---|---|---|
| `CLOUDFLARE_FREE_TIER` | 20 | 50 | 20 | 10 |
| `CLOUDFLARE_PAID_TIER` | 2000 | 100 *(default)* | 1000 | 500 |
| `NODE_PROFILE` | 100_000 | 100 *(default)* | 100_000 | 1000 |

`NODE_PROFILE` exists only to set caps so high the compactor /
GC short-circuit (the compactor returns early when
`maxEntriesPerRun > liveTail`). The CLI `admin compact`
re-uses `NODE_PROFILE` as the default. `CLOUDFLARE_PAID_TIER` is
similar — only three of four knobs differ from defaults, and the
profile is selected by env var (`env.CF_TIER === "paid"` in
`packages/adapter-cloudflare/src/worker.ts:412`).

**Action — pick one:**

- **(a) [preferred]** Delete `NODE_PROFILE` and
  `CLOUDFLARE_PAID_TIER`. The CF cron handler keeps
  `CLOUDFLARE_FREE_TIER` for the free-tier even/odd alternation
  (see section 2); paid-tier callers pass `{}` (use defaults).
  Node adapter (`packages/adapter-node/src/server.ts:697`) and
  CLI (`packages/cli/src/admin/compact.ts`) also pass `{}`.
- **(b)** Keep all three but rename to make the asymmetry explicit
  (`CLOUDFLARE_FREE_TIER` = real budgets, others = "default-ish").

(a) is the smaller diff and the more honest API.

---

## 2. Replace `skipCompact`/`skipGc` with `compactOnce` / `gcOnce`

`packages/server/src/maintenance.ts:43,45` declare:

```ts
readonly skipCompact?: boolean;
readonly skipGc?: boolean;
```

`MaintenanceResult` at `maintenance.ts:57-62` discriminates:

```ts
readonly compact: CompactResult | null;
readonly gc: RunGcResult | null;
// JSDoc: "null iff options.skipCompact === true"
```

Consumers:

- `packages/adapter-cloudflare/src/worker.ts:423-424`:
  ```ts
  const skipCompact = !isPaid && minute % 2 !== 0;
  const skipGc      = !isPaid && minute % 2 === 0;
  ```
  Drives free-tier minute-parity alternation.
- `packages/cli/src/admin/compact.ts:80-110, 166-169, 194-195`:
  exposes `--skip-compact` / `--skip-gc` flags with a
  mutually-exclusive guard.
- `tests/integration/maintenance.test.ts:63-92` and
  `maintenance.budget.test.ts:119,159` exercise the branches.

The shape is "either of two functions, dispatched on a flag." A
direct API would expose both functions and let callers pick.

**Action:**

- Add `compactOnce(args, options)` and `gcOnce(args, options)`
  to `@baerly/server` — thin wrappers around `compact` and
  `runGc` with the canonical-line scope.
- `runScheduledMaintenance` keeps its "do both" shape but loses
  `skipCompact` / `skipGc`. `MaintenanceResult` loses the `null`
  arms (both children always run).
- CF worker calls `compactOnce` on odd minutes, `gcOnce` on even
  minutes (paid tier runs `runScheduledMaintenance`).
- CLI `admin compact --skip-compact` becomes `baerly admin gc`;
  `admin compact --skip-gc` is plain `admin compact`. (See
  G13 — the `--skip-*` UX trap.)
- Update tests to call the new entry points directly.

---

## 3. Trim `CompactOptions` / `RunGcOptions`

`packages/server/src/compactor.ts:130-161` (`CompactOptions`) and
`packages/server/src/gc.ts:69-109` (`RunGcOptions`) expose:

| Option | Production setters | Test setters |
|---|---|---|
| `CompactOptions.maxEntriesPerRun` | profile constants only | yes |
| `CompactOptions.minEntriesToCompact` | profile constants + CLI `--min-entries` | yes |
| `CompactOptions.signal` | adapter plumbing | yes |
| `CompactOptions.metrics` | adapter plumbing | yes |
| `RunGcOptions.maxMarksPerRun` | profile constants only | yes |
| `RunGcOptions.maxSweepsPerRun` | profile constants only | yes |
| `RunGcOptions.graceMillis` | **none** | yes (sets `0` for fast tests) |
| `RunGcOptions.now` | **none** | yes (clock injection) |

JSDoc on `RunGcOptions.now` (`gc.ts:90-94`) explicitly says
"Clock injection for tests."

**Action:**

- Move `maxEntriesPerRun`, `maxMarksPerRun`, `maxSweepsPerRun`,
  `graceMillis` out of the public `CompactOptions` / `RunGcOptions`
  shapes. With section 1's collapse, the only remaining production
  setter is `CLOUDFLARE_FREE_TIER` — inline its values as
  `compact()` / `runGc()` parameters, or hoist them into a small
  `cloudflareFreeTierMaintenance()` wrapper exposed alongside
  `compactOnce` / `gcOnce`.
- Keep `minEntriesToCompact` — `baerly admin compact --min-entries`
  is a real production override (`admin/compact.ts:197`).
- Keep `signal` and `metrics` — adapter plumbing.
- Move `now` to a symbol-keyed test-only seam (e.g.,
  `Symbol.for("@baerly/server/test-now")`) or a separate
  `runGcForTesting` entry point. The public type loses `now`.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass, including
  `tests/integration/maintenance.test.ts`,
  `maintenance.budget.test.ts`, `compactor.test.ts`, `gc.test.ts`.
- `pnpm test:adapter-cloudflare` — confirms the CF cron handler's
  new `compactOnce` / `gcOnce` dispatch still alternates correctly.
- `pnpm test:adapter-node` — confirms the Node adapter's
  `runMaintenanceTick` path (which calls `runScheduledMaintenance`)
  still produces both `compact` and `gc` results.

## Out of scope

This workstream is purely about the maintenance options surface
and the CF-cron alternation hack. The three nested `withObservability`
wrappers (one canonical line per tick), the adapter-side
observability ceremony duplication, the `CATEGORY` table trim, and
the kernel `picocolors` dependency are tracked in the observability
workstream.

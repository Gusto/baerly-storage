# 02 — Add `--min-entries <N>` override to `baerly admin compact`

**One-liner.** Today `baerly admin compact` silently no-ops on any
bucket whose live log tail is below the active profile's
`minEntriesToCompact` (50 / 100 / 100); add a CLI flag that overrides
the threshold for one invocation so operators can force a compact pass
on a small bucket for verification, testing, or demo purposes.

## Estimated effort & risk

- **Effort:** 0.5 days. One file gains a flag (~10 lines), the
  threading is a one-line merge into the `MaintenanceOptions` object,
  one new test case proves the override path, one CLAUDE.md line
  gets updated.
- **Risk:** Low. The flag is purely additive — when absent, behavior
  is byte-identical to today. Validation is defensive (positive
  integer parse + bound check). No changes to the compactor /
  maintenance kernel; the existing `CompactOptions.minEntriesToCompact`
  field already accepts an override.

## Self-contained banner

This ticket is intentionally self-contained. **You do NOT need to
read `.claude/research/`** or any phase doc to implement it. Inputs
are this file plus the repo (`packages/`, `CLAUDE.md`).

## Why we're doing this

The DX gap. Running `baerly admin compact` against a bucket with 12
log entries today emits an `ok` envelope but **no work happened** —
`result.compact.written === false` with `skippedReason:
"below-min-threshold"`. The three shipping profiles set
`minEntriesToCompact` at 50 (`cloudflare-free`), 100
(`cloudflare-paid`), and 100 (`node`); there is no CLI surface to
lower that bound.

So an operator who wants to verify the maintenance loop on a fresh
bucket has to either (a) hand-seed 50+ entries — burning wall-clock
and Class A ops on something they already know works — or (b) edit
`packages/server/src/maintenance.ts`, rebuild, re-test. Neither is
acceptable for a "DX is the top priority" repo.

Adding `--min-entries <N>` solves the gap with one flag. Semantics:

- Override `minEntriesToCompact` for **this invocation only**.
- Does **not** mutate the profile object or persist anywhere.
- Validated to be a positive integer; missing → keep the profile's
  default; zero or negative → `InvalidConfig` (exit 1).

After this ticket lands, the verification flow becomes:

```sh
pnpm exec baerly admin compact \
  --bucket=file://./.baerly-data \
  --app=helpdesk --tenant=helpdesk-demo --table=tickets \
  --profile=node --min-entries=10 --json
```

and the operator sees `compact.written: true` with a real
`entries_folded` number on a 12-entry bucket.

## Current state

All file paths are repo-relative.

### Existing flag definitions

`packages/cli/src/admin/compact.ts:44-88` — the `COMPACT_ARGS` block:

```ts
const COMPACT_ARGS = {
  bucket: {
    type: "string",
    required: true,
    description: "Bucket URI (s3://<bucket>[/<prefix>], file:///<abs>, memory://<bucket>)",
    valueHint: "bucket-uri",
  },
  app: {
    type: "string",
    required: false,
    description: "Application name segment (defaults to baerly.config.ts, then 'app').",
    valueHint: "app",
  },
  tenant: {
    type: "string",
    required: false,
    description: "Tenant name segment (defaults to baerly.config.ts, then 'tenant').",
    valueHint: "tenant",
  },
  table: {
    type: "string",
    required: true,
    description: "Collection (table) name.",
    valueHint: "name",
  },
  profile: {
    type: "string",
    required: false,
    default: "node",
    description: "Maintenance profile: cloudflare-free | cloudflare-paid | node.",
    valueHint: "cloudflare-free|cloudflare-paid|node",
  },
  "skip-gc": {
    type: "boolean",
    description: "Run compact only (skip GC).",
  },
  "skip-compact": {
    type: "boolean",
    description: "Run GC only (skip compact).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;
```

### Known-keys allowlist (defence-in-depth)

`packages/cli/src/admin/compact.ts:92-102`:

```ts
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "profile",
  "skip-gc",
  "skip-compact",
  "json",
  "_",
]);
```

Any flag not in this set throws `BaerlyError("InvalidConfig", "baerly
admin compact: unknown flag --<name>")` at `compact.ts:144`. This is
the explicit "no silent typo acceptance" guard — when adding the new
flag, you must add it to this set too.

### How the profile object flows into the kernel

`packages/cli/src/admin/compact.ts:104-108`:

```ts
const PROFILES: Record<string, MaintenanceOptions> = {
  "cloudflare-free": CLOUDFLARE_FREE_TIER,
  "cloudflare-paid": CLOUDFLARE_PAID_TIER,
  node: NODE_PROFILE,
};
```

`compact.ts:147-171` — the call into the kernel:

```ts
const profile = PROFILES[args.profile];
// … validation …
const options: MaintenanceOptions = {
  ...profile,
  ...(args["skip-gc"] === true && { skipGc: true }),
  ...(args["skip-compact"] === true && { skipCompact: true }),
};
const result = await runScheduledMaintenance(
  { storage: bucket.storage, currentJsonKey },
  options,
);
```

This is the *one* threading site. The new flag lands here as another
spread into `options.compact`.

### Profile shapes the override needs to merge into

`packages/server/src/maintenance.ts:34-57` — `MaintenanceOptions`:

```ts
export interface MaintenanceOptions {
  /** Forwarded to `compact()` when the compaction phase runs. */
  readonly compact?: CompactOptions;
  /** Forwarded to `runGc()` when the GC phase runs. */
  readonly gc?: RunGcOptions;
  readonly skipCompact?: boolean;
  readonly skipGc?: boolean;
  readonly signal?: AbortSignal;
  readonly metrics?: MetricsRecorder;
}
```

`packages/server/src/maintenance.ts:160-181` — the three profiles:

```ts
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 20, minEntriesToCompact: 50 },
  gc: { maxMarksPerRun: 20, maxSweepsPerRun: 10 },
};
export const CLOUDFLARE_PAID_TIER: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 2000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 1000, maxSweepsPerRun: 500 },
};
export const NODE_PROFILE: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 100_000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 100_000, maxSweepsPerRun: 1000 },
};
```

`packages/server/src/compactor.ts:131-161` — `CompactOptions`:

```ts
export interface CompactOptions {
  readonly maxEntriesPerRun?: number;
  /**
   * Minimum log-tail length to compact. Skips work when there are
   * fewer than this many live entries past the last snapshot.
   * Default 100.
   */
  readonly minEntriesToCompact?: number;
  readonly signal?: AbortSignal;
  readonly metrics?: MetricsRecorder;
}
```

`packages/server/src/compactor.ts:231` — the read site:

```ts
const minToCompact = options.minEntriesToCompact ?? DEFAULT_MIN_TO_COMPACT;
```

This already does the right thing: a per-invocation override wins
over the field's default. So all the CLI has to do is pass the value
through.

### How another CLI subcommand validates a numeric flag

Every numeric flag in `packages/cli/src/` declares `type: "string"`
and `Number.parseInt`s in the handler — citty's `"number"` kind is
not in use here. The established template is
`packages/cli/src/admin/migrate.ts`'s `--target-version`: flag
declared at lines 73-78, validated at lines 173-184. The validator
uses `Number.parseInt` + `Number.isFinite` + `Number.isInteger` + a
range check + a `String(parsed) === raw.trim()` round-trip (which
rejects `"1.5"`, `"01"`, `"abc"`). Copy this idiom; do not introduce
a parallel one.

### Existing CLI test scaffold

`packages/cli/src/admin/compact.test.ts` — the suite the new test
joins. Key helpers and templates: `seedRows(storage, count)` at
38-48 (drives `ServerWriter`), `captureStream` at 50-65 (stdout /
stderr capture), the 200-row happy-path test at 80-114 (template
for the new test), the unknown-flag test at 203-213 (template for
proving `KNOWN_KEYS` is updated). Uses `LocalFsStorage` over
`mkdtemp` — no infra, ~30 ms per test.

### CLAUDE.md verification-matrix row

`CLAUDE.md` line 67 (the `admin compact` row):

```
| `pnpm -F @baerly/cli build && pnpm exec baerly admin {compact,fsck,migrate} ...` | maintenance surface: `admin compact` manually triggers one `runScheduledMaintenance` pass (compact + GC, profile-selectable); `admin fsck` walks ... | seconds | ✅ no infra |
```

The description for `admin compact` needs a one-clause addition
mentioning `--min-entries` as the small-bucket escape hatch.

## Implementation steps

Execute in this order. Steps 1-3 ship the flag; step 4 documents it
in the help text; step 5 adds a regression test; step 6 updates
CLAUDE.md.

### Step 1 — Declare the flag in `COMPACT_ARGS`

**File:** `packages/cli/src/admin/compact.ts`.

Add this entry to the `COMPACT_ARGS` object between `"skip-compact"`
and `json` (alphabetical-ish ordering matches the existing block):

```ts
"min-entries": {
  type: "string",
  required: false,
  description:
    "Override the active profile's minEntriesToCompact for this invocation only. "
    + "Useful for verifying / testing / demoing compaction on a small bucket "
    + "(profiles default to 50–100 entries). Must be a positive integer.",
  valueHint: "int",
},
```

Use `type: "string"` and parse it as an integer in the handler — see
`admin migrate`'s `--target-version` for the established pattern. The
description copy mentions the use case explicitly so `--help` reads as
"who is this for", not "what does this do".

### Step 2 — Add the flag name to `KNOWN_KEYS`

**File:** `packages/cli/src/admin/compact.ts:92-102`.

Insert `"min-entries"` into the set (the order does not matter but
keep it next to the related compact knobs for skimmability):

```ts
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "profile",
  "min-entries",        // ← new
  "skip-gc",
  "skip-compact",
  "json",
  "_",
]);
```

This is load-bearing: without this edit, passing `--min-entries=10`
would be rejected at line 144 as an "unknown flag" before validation
runs. The "unknown flag" test at lines 203-213 of the test file
proves the guard fires; failing to update `KNOWN_KEYS` here would
also fail that test indirectly via your own new test (step 5).

### Step 3 — Validate and thread the override

**File:** `packages/cli/src/admin/compact.ts` (the `handleCompact`
function, lines 139-206).

Add a parse + validate block right after the profile lookup at line
153 and before the `skip-gc / skip-compact` mutual-exclusion check
at line 154:

```ts
const minEntriesOverride = args["min-entries"];
let minEntriesToCompact: number | undefined;
if (typeof minEntriesOverride === "string" && minEntriesOverride.length > 0) {
  const parsed = Number.parseInt(minEntriesOverride, 10);
  if (
    !Number.isFinite(parsed)
    || !Number.isInteger(parsed)
    || parsed <= 0
    || String(parsed) !== minEntriesOverride.trim()
  ) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin compact: --min-entries must be a positive integer (got ${JSON.stringify(minEntriesOverride)})`,
    );
  }
  minEntriesToCompact = parsed;
}
```

Then merge the override into the `options` object at the existing
`options` block (lines 163-167). Replace:

```ts
const options: MaintenanceOptions = {
  ...profile,
  ...(args["skip-gc"] === true && { skipGc: true }),
  ...(args["skip-compact"] === true && { skipCompact: true }),
};
```

with:

```ts
const options: MaintenanceOptions = {
  ...profile,
  ...(minEntriesToCompact !== undefined && {
    compact: {
      ...profile.compact,
      minEntriesToCompact,
    },
  }),
  ...(args["skip-gc"] === true && { skipGc: true }),
  ...(args["skip-compact"] === true && { skipCompact: true }),
};
```

The nested spread `...profile.compact` preserves the profile's
`maxEntriesPerRun` (and any future fields) — the override is
surgical, replacing only `minEntriesToCompact`. Order matters: the
override block must come **after** `...profile` so its `compact`
key wins, and **before** `skipCompact` so the user gets an
`InvalidConfig` if they pass `--min-entries=10 --skip-compact`
together. (The combination is not a hard error — `--skip-compact`
just makes `--min-entries` a no-op — so let it through; the
mutual-exclusion guard at line 154 only fires for `--skip-gc +
--skip-compact`.)

### Step 4 — Reflect the flag in the file-top JSDoc

**File:** `packages/cli/src/admin/compact.ts:13-23` (the
`Args:` block at the top of the file).

Add a line for the new flag, keeping the existing two-space alignment:

```ts
 * Args:
 *   --bucket            Required. Bucket URI.
 *   --app               Default "app" (or `baerly.config.ts`).
 *   --tenant            Default "tenant" (or `baerly.config.ts`).
 *   --table             Required. Collection name.
 *   --profile           "cloudflare-free" | "cloudflare-paid" | "node".
 *                       Default "node".
 *   --min-entries       Override the profile's `minEntriesToCompact`
 *                       for this invocation only (positive integer).
 *                       Use to force a compact pass on a small bucket
 *                       during verification, testing, or demos.
 *   --skip-gc           Run compact only.
 *   --skip-compact      Run GC only.
 *   --json              JSON envelope.
```

The citty `--help` output is built from `description`, not the
JSDoc — but both must stay in sync. Both edits are required.

### Step 5 — Add a regression test

**File:** `packages/cli/src/admin/compact.test.ts`.

Append two new `test(...)` cases inside the existing
`describe("baerly admin compact — CLI smoke", ...)` block (after
line 213, before the closing `});`):

```ts
test("--min-entries=10 forces compact on a 12-row bucket below NODE_PROFILE's 100 default", async () => {
  await provision(storage);
  await seedRows(storage, 12);

  const stdout = captureStream(process.stdout);
  let exitCode: number;
  try {
    exitCode = await runCompact([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--profile=node",
      "--min-entries=10",
      "--skip-gc",
      "--json",
    ]);
  } finally {
    stdout.restore();
  }
  expect(exitCode).toBe(0);
  const envelope = JSON.parse(stdout.captured.join("").trim()) as {
    result: { compact: { written: boolean; entries_folded: number } | null };
  };
  expect(envelope.result.compact).not.toBeNull();
  if (envelope.result.compact === null) throw new Error("unreachable");
  expect(envelope.result.compact.written).toBe(true);
  expect(envelope.result.compact.entries_folded).toBe(12);
});

test.each(["0", "-5", "abc", "1.5"])(
  "--min-entries=%s is rejected with InvalidConfig (exit 1)",
  async (badValue) => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--profile=node",
        `--min-entries=${badValue}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
    expect(stderr.captured.join("")).toContain("--min-entries");
  },
);
```

The two tests pin down:

1. **The override fires** (12 rows + `--min-entries=10` → `written: true`).
2. **Bad values rejected** (`0` / negative / non-numeric / fractional
   all hit the same positive-integer guard).

The flag-absence default ("no-op on 12 rows under node") is already
covered by the existing `--skip-compact` test at lines 116-141, which
seeds 50 rows under NODE_PROFILE (still below the 100 default) and
asserts `compact === null` only because of `--skip-compact`. If you
want a dedicated assertion, copy that test and drop the `--skip-compact`
flag — but it's redundant with the kernel's own coverage in
`packages/server/src/compactor.test.ts`.

### Step 6 — Update CLAUDE.md verification matrix

**File:** `CLAUDE.md` (line 67, the `admin compact` row).

Change the description from:

```
`admin compact` manually triggers one `runScheduledMaintenance` pass (compact + GC, profile-selectable);
```

to:

```
`admin compact` manually triggers one `runScheduledMaintenance` pass (compact + GC, profile-selectable; `--min-entries=<N>` lowers the per-invocation `minEntriesToCompact` for small-bucket verification);
```

Keep the rest of the row identical.

### Step 7 — Sanity-check by hand

Build the CLI and run it against `examples/helpdesk/`'s
`LocalFsStorage` root (the worktree-name of this ticket is
`verify-helpdesk-cost-model` — the helpdesk fixture is the canonical
small-bucket test bed):

```sh
pnpm -F @baerly/cli build

# 1) Default (no --min-entries) on the helpdesk fixture — expect no-op.
pnpm exec baerly admin compact \
  --bucket=file://examples/helpdesk/.baerly-data \
  --app=helpdesk --tenant=helpdesk-demo --table=tickets \
  --profile=node --skip-gc --json | jq '.result.compact'
# → { "written": false, "skipped_reason": "below-min-threshold", ... }

# 2) Override — expect work to happen.
pnpm exec baerly admin compact \
  --bucket=file://examples/helpdesk/.baerly-data \
  --app=helpdesk --tenant=helpdesk-demo --table=tickets \
  --profile=node --skip-gc --min-entries=2 --json | jq '.result.compact'
# → { "written": true, "entries_folded": <n>, ... }
```

Both outputs land in the PR description. The before/after diff is
the proof of the user-visible change.

## Conventions to follow

Pulled forward from `CLAUDE.md` and
`docs/contributing/conventions/`; do not link out.

- **Imports are relative with explicit `.ts` extensions.** New code in
  `packages/cli/src/admin/` follows the existing pattern:
  `import { BaerlyError } from "@baerly/protocol";`,
  `import { ... } from "../config.ts";`, etc. No baseUrl, no
  extensionless paths.
- **Errors are `BaerlyError`.** The validation throw must use
  `new BaerlyError("InvalidConfig", "...")` — that maps to exit
  code 1 via the existing `errorToExitCode` function at
  `compact.ts:110-114`. Do not throw plain `Error`; the catch
  at `compact.ts:198-205` would route it to exit 2 (`Unknown`).
- **Error messages name the flag.** `migrate.ts:181` does this:
  `"baerly admin migrate: --target-version must be a non-negative
  integer (got ...)"`. Mirror the format so the operator's terminal
  output points them directly at the bad input.
- **No new dependencies.** The numeric parse uses
  `Number.parseInt` / `Number.isFinite` — both global. No
  `commander`, no `yargs`. (The repo uses `citty` already.)
- **No silent typo acceptance.** The `KNOWN_KEYS` allowlist is
  load-bearing; don't bypass it.
- **Test runner is vitest.** Import from `"vitest"`, not `"node:test"`
  or `"bun:test"`. The new tests live in
  `packages/cli/src/admin/compact.test.ts` next to their existing
  peers.
- **Pre-launch posture: no compat aliases.** Per
  `docs/contributing/conventions/change-discipline.md`, this is a
  *new* flag — there's nothing to deprecate. Keep it simple.
- **JSDoc on the `Args:` block.** The file-top JSDoc enumerates every
  flag (lines 13-23 of compact.ts). When you add the CLI flag, you
  also add the JSDoc bullet in step 4. Both must stay in sync.

## Verification

Each command is the gate that says "done." Run from the worktree
root.

### Typecheck + lint

```sh
pnpm verify
```

Expected: exit 0. The new code compiles under tsgo and passes
oxlint.

### CLI unit tests

```sh
pnpm test packages/cli/src/admin/compact.test.ts
```

Expected: exit 0. The original 6 tests plus the 2 added in step 5
(the second one is `test.each`-driven across 4 bad values) all pass.
Runtime stays under ~1s — `LocalFsStorage` only, no infra.

### Full default test pass

```sh
pnpm test
```

Expected: exit 0. Other admin-CLI tests are unchanged.

### Manual before/after

```sh
pnpm -F @baerly/cli build

# BEFORE: no-op on a 12-row bucket under NODE_PROFILE.
pnpm exec baerly admin compact --bucket=file://./.baerly-data \
  --app=helpdesk --tenant=helpdesk-demo --table=tickets \
  --profile=node --skip-gc --json | jq '.result.compact'
# { "written": false, "skipped_reason": "below-min-threshold", ... }

# AFTER: --min-entries=10 lets work happen.
pnpm exec baerly admin compact --bucket=file://./.baerly-data \
  --app=helpdesk --tenant=helpdesk-demo --table=tickets \
  --profile=node --skip-gc --min-entries=10 --json | jq '.result.compact'
# { "written": true, "entries_folded": 12, ... }
```

Both snippets land in the PR description.

### Help text spot check

```sh
pnpm exec baerly admin compact --help
```

Expected: a `--min-entries <int>` line appears, carrying the step-1
description. Confirms citty picked the new flag up.

## Out of scope

The following are intentionally deferred. Each names where it lives.

- **`--max-entries-per-run` override.** Symmetric upper-bound flag.
  Add when someone wants it; a follow-up ticket in this directory.
- **`--gc-max-marks` / `--gc-max-sweeps` overrides.** Same shape,
  for the GC half. Defer until needed.
- **Persisting overrides into `baerly.config.ts`.** Per-invocation
  is the intended surface; persistent config is a separate ticket.
- **Cron callers adopting the same shape.** Cron handlers already
  get `MaintenanceOptions.compact.minEntriesToCompact` directly via
  the `@baerly/server/maintenance` import — they pass the field
  themselves, no CLI plumbing needed.
- **Surveying other `admin` subcommands** (`fsck`, `migrate`,
  `dump`, `restore`, `rebuild-index`) for similar DX gaps. Separate
  ticket; this one is scoped to `compact`.
- **Promoting to a citty `type: "number"` flag.** The repo's
  established pattern is `type: "string"` + in-handler parse (see
  `migrate.ts:73-78`); switching wholesale is a separate refactor.

## Pointers

Repo paths with line numbers. External URLs are deliberately absent.

- **Compact CLI source (the file you edit)** —
  `packages/cli/src/admin/compact.ts`. Flag block 44-88;
  `KNOWN_KEYS` 92-102; profile map 104-108; handler 139-206;
  citty command 209-219; programmatic entry `runCompact` 226-236.
- **Compact CLI tests (the file you extend)** —
  `packages/cli/src/admin/compact.test.ts`. `provision` 29-36;
  `seedRows` 38-48; `captureStream` 50-65; existing 200-row happy
  path 80-114; `--skip-compact` test 116-141; `--skip-gc` test
  143-168; bad-profile test 170-187; unknown-flag test 203-213.
- **Numeric-flag idiom to mirror** —
  `packages/cli/src/admin/migrate.ts:73-78` (flag), 173-184
  (validate).
- **Maintenance kernel options** —
  `packages/server/src/maintenance.ts:28-57` (`MaintenanceArgs` +
  `MaintenanceOptions`).
- **The three shipping profiles** —
  `packages/server/src/maintenance.ts:160-181`.
- **Compactor options + the field your override sets** —
  `packages/server/src/compactor.ts:131-161` (`CompactOptions`),
  231 (`const minToCompact = options.minEntriesToCompact ??
  DEFAULT_MIN_TO_COMPACT;`), 181 (`DEFAULT_MIN_TO_COMPACT = 100`).
- **CLI output helpers** —
  `packages/cli/src/output.ts:24` (`setJsonMode`), 46
  (`emitError`), 59 (`emitSuccess`).
- **CLAUDE.md verification matrix row** —
  `CLAUDE.md` line 67.
- **Change-discipline ("ship the smallest coherent slice")** —
  `docs/contributing/conventions/change-discipline.md:17-22`.
- **Test conventions** —
  `docs/contributing/conventions/tests.md` (read before adding
  tests).

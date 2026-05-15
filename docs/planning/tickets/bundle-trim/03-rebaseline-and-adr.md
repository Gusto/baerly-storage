# 03 — Re-baseline bundle-size budgets + close followup

**One-liner.** With T01 + T02 landed, re-measure each closure
under `dist/`, add a `maintenance.js` row to the BUDGETS table,
adjust `index.js` and `http.js` thresholds to the new measured
floors with a small headroom, drop the `skip: true` flags, and
close out the open followup item.

**Estimated effort.** ~0.25 day. **Risk.** Low — measurement,
table edit, and a doc status flip. No source code changes.

---

> **Self-contained.** You don't need to consult any planning
> notes or chat logs. Everything you need is in this file, the
> repo, and the conventions referenced at the bottom.

## Why we're doing this

Two budgets in `tests/integration/bundle-size.test.ts` are
currently gated with `skip: true`:

- `dist/index.js` gz=104010 / budget=102400 (+1.57% over)
- `dist/http.js` raw=276493 / budget=256000 (+8%), gz=79420 /
  budget=73728 (+7.7%)

Tickets T01 + T02 (which must merge before T03 runs):

- T01 moved `runScheduledMaintenance` and its profile constants
  to `@baerly/server/maintenance`. As a side effect, the
  maintenance + observability subgraph no longer reaches
  `dist/index.js` via the barrel's maintenance re-export.
- T02 dropped the 23 observability re-exports from the kernel
  barrel. App consumers of the barrel that don't otherwise
  pull observability now skip it.

Both moves likely shrink `dist/index.js`. `dist/http.js` is
unaffected — the router directly imports `getLogger`, `CATEGORY`,
and `serializeError` at `packages/server/src/http/router.ts:43`,
which is load-bearing (observability runs at every request
boundary by design). So `http.js` very likely still exceeds the
old budget. That's not a regression — it's the kernel's actual
floor for any HTTP work.

Final step: measure the post-T01-T02 closure sizes, add the new
`maintenance.js` budget row, adjust `index.js` and `http.js`
thresholds to the measured floor plus a small headroom band,
drop the `skip: true` flags, update the explanatory comment at
the top of the file, and flip the followup status to resolved.

The user has explicitly chosen "obvious structural wins + honest
re-baseline" over "chase the bytes." This ticket honors that.

## Current state

### The BUDGETS table to update

`tests/integration/bundle-size.test.ts:33-69`:

```ts
interface Budget {
  /** Entry filename under `dist/`. */
  entry: string;
  /** Max unminified bytes for the entry's transitive closure. */
  raw: number;
  /** Max gzipped bytes for the entry's transitive closure. */
  gz: number;
  /**
   * Skip this entry's check pending follow-up. Tracked in
   * `docs/followups/first-touch-dx.md`.
   */
  skip?: boolean;
}

const BUDGETS: readonly Budget[] = [
  { entry: "index.js", raw: 350 * 1024, gz: 100 * 1024, skip: true },
  { entry: "auth.js", raw: 34 * 1024, gz: 12 * 1024 },
  { entry: "http.js", raw: 250 * 1024, gz: 72 * 1024, skip: true },
  { entry: "observability.js", raw: 100 * 1024, gz: 36 * 1024 },
];
```

After this ticket:

- A `maintenance.js` row exists (new entry produced by T01's
  rolldown change).
- `skip: true` flags are gone.
- `index.js` and `http.js` thresholds reflect the measured
  post-trim floor + ~5% headroom.

### The closure measurement primitive

`tests/integration/bundle-size.test.ts:76-99` defines
`collectClosure` + `measureClosure`. These are what the test
itself uses; the new thresholds must be measured the same way
so the numbers are apples-to-apples.

```ts
// Static-import specifiers only. Dynamic `import(...)` is intentionally
// excluded — code reachable only via dynamic import is a separate
// budget concern.
const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

function collectClosure(entryAbs: string, seen: Set<string>): void {
  if (seen.has(entryAbs)) return;
  seen.add(entryAbs);
  const src = readFileSync(entryAbs, "utf8");
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1]!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    collectClosure(resolve(dirname(entryAbs), spec), seen);
  }
}

function measureClosure(entry: string): { raw: number; gz: number; files: string[] } {
  const distDir = resolve(__dirname, "../../dist");
  const entryAbs = resolve(distDir, entry);
  if (!existsSync(entryAbs)) {
    throw new Error(`dist/${entry} missing — run \`pnpm build\` before \`pnpm test\``);
  }
  const seen = new Set<string>();
  collectClosure(entryAbs, seen);
  const files = [...seen].toSorted();
  const raw = files.reduce((sum, f) => sum + statSync(f).size, 0);
  const gz = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  return { raw, gz, files: files.map((f) => f.replace(`${distDir}/`, "")) };
}
```

To get the new numbers without committing measurement code,
the implementer can run a one-shot Node script that imports
the same logic (see step 1 below).

### The explanatory comment block (also needs updating)

`tests/integration/bundle-size.test.ts:6-31` contains the
historical rationale for the budgets. It references "ADR-0001"
and a plan file at `~/.claude/plans/foamy-strolling-wirth.md`,
but **ADR-0001 does not exist as a file** in this repo — the
`docs/adr/README.md` index explicitly notes "Numbering has gaps
from earlier ADRs that were merged into their natural homes."

The plan file in `~/.claude/plans/` is also outside this repo
(it's the orchestrator's local notes, not committed). Both
references are stale. As part of this ticket, replace the
references with the actual current rationale (which lives
right here, in this comment block).

### The followup item to close

`docs/followups/first-touch-dx.md:67-86` is the open backlog
item this entire workstream resolves. Specifically:

```
2. **Re-tighten bundle-size budgets for `index.js` and `http.js`.**
   The 2026-05-14 baseline on local `main` exceeds the configured
   budgets in `tests/integration/bundle-size.test.ts`:
   ...
   Suggested cleanup: either trim the closure (re-evaluate
   LogTape footprint in `observability-*.js`; consider lazy-loading
   the maintenance loop out of the kernel barrel) or bump the
   budgets to match the new floor with an ADR-0001 update. Once the
   number lands, remove the `skip: true` flags. **Status:** open
```

Update **Status: open** → **Status: resolved**, with a one-line
note linking to the integration branch tip commit.

## Implementation steps

### Step 1. Measure the new closures

The previous tickets have changed import paths and added a
fifth rolldown entry. Build fresh artifacts:

```sh
pnpm install
pnpm build
ls dist/{index,auth,http,observability,maintenance}.js     # all five exist
```

Then measure each entry the way `measureClosure` does. The
simplest path is an inline Node one-liner that mirrors the
test's logic — run from the repo root:

```sh
node --input-type=module -e "
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^\"']*?from\s*[\"']([^\"']+)[\"']/g;
const distDir = resolve('dist');
const collect = (entryAbs, seen) => {
  if (seen.has(entryAbs)) return;
  seen.add(entryAbs);
  const src = readFileSync(entryAbs, 'utf8');
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    collect(resolve(dirname(entryAbs), spec), seen);
  }
};
for (const entry of ['index.js','auth.js','http.js','observability.js','maintenance.js']) {
  const seen = new Set();
  collect(resolve(distDir, entry), seen);
  const files = [...seen].toSorted();
  const raw = files.reduce((s, f) => s + statSync(f).size, 0);
  const gz = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  console.log(\`\${entry}: raw=\${raw}, gz=\${gz}, files=\${files.length}\`);
}
"
```

Capture the output. You'll get five lines like:

```
index.js: raw=NNN, gz=NNN, files=N
auth.js: raw=NNN, gz=NNN, files=N
http.js: raw=NNN, gz=NNN, files=N
observability.js: raw=NNN, gz=NNN, files=N
maintenance.js: raw=NNN, gz=NNN, files=N
```

(Don't commit this script — it's measurement, not test code.
The test already does the same measurement at run time.)

### Step 2. Pick thresholds

For each entry, the new threshold is `measured × 1.05` (5%
headroom) rounded up to the next reasonable round number
(typically the next KiB multiple). For `maintenance.js`
(a new entry — no prior baseline), use `measured × 1.10`
(10% headroom — slightly more slack since maintenance is
sensitive to changes in compactor/gc code paths).

Round numbers chosen for legibility: prefer expressions like
`110 * 1024`, `350 * 1024`, etc., matching the existing
table's style. Don't write the raw byte values — the existing
table writes thresholds as `<N> * 1024`.

If `measured.raw <= 350 * 1024` AND `measured.gz <= 100 * 1024`
for `index.js`, **keep the existing thresholds** (350 / 100
KiB) and just drop `skip: true`. Don't tighten the budget — a
budget that has just enough headroom is fragile.

If `measured.raw > 350 * 1024` OR `measured.gz > 100 * 1024`,
bump to `measured × 1.05` rounded up.

Same logic for `http.js` (existing thresholds 250 / 72 KiB);
expected outcome: still over, so bump to measured + ~5%.

### Step 3. Update the BUDGETS table

Edit `tests/integration/bundle-size.test.ts:47-69`. The new
table should look like (with NNN replaced by your computed
KiB multipliers):

```ts
const BUDGETS: readonly Budget[] = [
  // Full barrel: kernel + http + auth. After T01 (maintenance
  // moved to /maintenance subpath) and T02 (observability
  // re-exports dropped from the barrel), the barrel no longer
  // statically pulls maintenance or observability for app code
  // that only wants `Db`. ~NNN KiB raw.
  { entry: "index.js", raw: NNN * 1024, gz: NNN * 1024 },
  // Just the five auth verifier factories. Adding a sixth grows
  // this budget, not the kernel's.
  { entry: "auth.js", raw: 34 * 1024, gz: 12 * 1024 },
  // hono/tiny-backed HTTP router + long-poll/since helpers +
  // observability middleware. Observability is load-bearing at
  // every request boundary (canonical-line emission,
  // structured logging, per-request metrics), so the request
  // path carries an observability baseline cost that can't be
  // shifted to a subpath. ~NNN KiB raw.
  { entry: "http.js", raw: NNN * 1024, gz: NNN * 1024 },
  // Observability primitives — ObservabilityContext, the
  // request-scoped MetricsRecorder, LogTape config + sinks,
  // canonical line flush, observableStorage decorator. LogTape
  // itself accounts for the bulk; a smaller direct-stdout sink
  // could trim further but is deferred.
  { entry: "observability.js", raw: 100 * 1024, gz: 36 * 1024 },
  // Maintenance loop — compactor + GC + sweep driver. Pulls
  // compactor.ts + gc.ts + the observability subgraph
  // transitively (every work unit runs under withObservability).
  // Operator-side; not part of the kernel barrel as of T01.
  // ~NNN KiB raw.
  { entry: "maintenance.js", raw: NNN * 1024, gz: NNN * 1024 },
];
```

**No `skip: true` flags remain.**

(Leave the `auth.js` and `observability.js` rows unchanged
unless their measured numbers have drifted past the existing
thresholds. Measure to confirm — they were under budget at the
pre-T01-T02 baseline and should remain so.)

### Step 4. Update the explanatory comment block

Edit `tests/integration/bundle-size.test.ts:6-31`. Replace the
stale references to ADR-0001 and the local plan file with the
actual rationale. The block currently reads:

```ts
// ADR-0001 motivates the vendorless choice on bundle weight: this lib
// ships into a user's app bundle, so every byte we add is a byte they
// pay. Ticket 37 added five auth-preset verifiers to the
// kernel barrel, pushing the unminified bundle from ~168 KiB to
// ~213 KiB. Rather than just bump the budget, we split the surface
// into subpath entrypoints (`baerly-storage/auth`, `baerly-storage/http`)
// so consumers who don't need them don't pay for them — and we budget
// each entrypoint independently. See ADR-0001 and the plan in
// `~/.claude/plans/foamy-strolling-wirth.md` for the rationale.
// ...
```

Replace with:

```ts
// Bundle weight matters because this lib ships into a user's app
// bundle — every byte we add is a byte they pay. To keep barrel
// consumers from paying for code they don't reach, we split the
// surface across subpath entrypoints (`baerly-storage/auth`,
// `baerly-storage/http`, `baerly-storage/maintenance`,
// `baerly-storage/observability`) and budget each entrypoint's
// transitive closure independently.
//
// The barrel (`baerly-storage`) carries the kernel surface (`Db`,
// `ServerWriter`, query/table helpers, schema, indexes) plus the
// auth presets. Maintenance (`runScheduledMaintenance`, profile
// constants) and observability primitives are NOT on the barrel
// as of 2026-05 — operator-side code reaches them via their
// subpath entries.
//
// `http.js` and (transitively) `index.js` carry a baseline
// observability cost that can't be shifted to a subpath:
// `packages/server/src/http/router.ts` directly calls
// `getLogger`/`CATEGORY` at the request boundary for structured
// logging, and the maintenance work units use `withObservability`.
// The thresholds below reflect that floor.
```

(Keep the rest of the comment block — `Budget` interface
explanation, the raw vs. gz nuance, the "8–15% above measured"
guidance — intact. Only the top paragraph changes.)

If the existing comment block also says "Budgets are set ~8–15%
above the measured size on the refactor branch" — leave that as
historical context. The thresholds set by this ticket use 5%
headroom for the existing entries (tighter — the lib is more
mature than at the refactor) and 10% for the new
`maintenance.js` entry.

### Step 5. Close out the followup item

Edit `docs/followups/first-touch-dx.md:67-86`. Replace
**Status: open** with **Status: resolved**. Add a one-line
note citing the resolution. The end of item 2 currently reads:

```
   ... Once the
   number lands, remove the `skip: true` flags. **Status:** open
```

Change to:

```
   ... Once the
   number lands, remove the `skip: true` flags. **Status:**
   resolved 2026-05-14 via tickets `bundle-trim/01-03` —
   maintenance moved to its own subpath, observability
   re-exports dropped from the barrel, and the remaining
   delta re-baselined.
```

(Update the date to the actual ticket-landing date if it
differs from 2026-05-14.)

Also update the doc's `last-reviewed:` frontmatter date and,
if the file's `status:` says `open`, evaluate whether all
items are now resolved — if both items 1 (publish workstream)
and 2 (bundle-size) are resolved, set the file's status to
`closed`. If item 1 is still open, leave the file `status:
open`.

### Step 6. Run the test with no skips

```sh
pnpm test -- --reporter=verbose tests/integration/bundle-size.test.ts
```

All four (now five) tests must pass. Expected output:

```
✓ dist/index.js closure stays within budget
✓ dist/auth.js closure stays within budget
✓ dist/http.js closure stays within budget
✓ dist/observability.js closure stays within budget
✓ dist/maintenance.js closure stays within budget
```

Zero skips. If a test fails, the measured-vs-threshold math
was off — re-measure and adjust the threshold.

### Step 7. Commit

One commit, conventional-commits style:

```
test(bundle-size): re-baseline budgets + add maintenance.js row

T01 + T02 reduced what the kernel barrel statically pulls.
Re-measured each entry's closure under dist/ and:
- Added a maintenance.js budget row (new entry from T01).
- Updated index.js + http.js thresholds to the measured
  floor + 5% headroom.
- Dropped the `skip: true` flags from both.
- Rewrote the file-top comment to reflect the current
  subpath split and the observability baseline that the
  request path carries by design.
- Flipped docs/followups/first-touch-dx.md item 2 to
  Status: resolved.
```

## Conventions to follow

- **Don't introduce a measurement script as a checked-in
  tool.** The test itself measures; a separate script would
  duplicate that. Use the one-liner in step 1 ephemerally.
- **Round thresholds to the nearest KiB multiple.** Matches
  the existing table's `N * 1024` style. Don't commit raw
  byte values.
- **5% headroom for existing entries, 10% for new ones.**
  Tight enough to catch regressions, loose enough that
  routine code changes don't flake.
- **Don't create a new ADR for this re-baseline.** The user
  scoped this as a small change. The test file's comment
  block is the canonical doc.

## Verification

```sh
pnpm install
pnpm build                                                   # all five entries
pnpm verify                                                  # exit 0
pnpm test                                                    # all pass, zero `skip: true`
grep -nE '\bskip:\s*true\b' tests/integration/bundle-size.test.ts
# Expected: zero hits.

grep -A1 'Status:' docs/followups/first-touch-dx.md | head
# Expected: item 2 shows "Status: resolved".

pnpm format:check                                            # exit 0
```

All commands must succeed before reporting done.

## Out of scope

- **Replacing `@logtape/logtape`.** The user explicitly
  rejected this as ambition-chasing for a small regression.
- **Per-source byte attribution tooling.** Same rationale.
- **Creating a new ADR.** The test file's comment block
  carries the rationale; an ADR is overkill for a
  re-baseline.
- **Tightening unrelated budgets** (`auth.js`,
  `observability.js`). Only re-measure to confirm they still
  pass; don't tighten unless they've drifted past their
  existing thresholds.
- **Tightening the closure walk** (`STATIC_IMPORT_RE`).
  Works as-is.

## Pointers

- `tests/integration/bundle-size.test.ts:6-31` — explanatory
  comment block to rewrite.
- `tests/integration/bundle-size.test.ts:47-69` — BUDGETS
  table to update.
- `tests/integration/bundle-size.test.ts:76-99` — closure
  walker + measureClosure semantics to mirror in the
  one-shot script.
- `docs/followups/first-touch-dx.md:67-86` — followup item
  to close.
- `docs/adr/README.md` — confirms there is no ADR-0001 file
  to update; numbering has gaps from earlier ADRs merged
  into their natural homes.
- Subpath entries that justify the new floor:
  `packages/server/src/http/router.ts:43` (router uses
  `getLogger`/`CATEGORY`), `packages/server/src/maintenance.ts:26`
  / `compactor.ts:52` / `gc.ts:65` (work units use
  `withObservability`).

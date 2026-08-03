---
title: Bench harnesses
audience: coder
summary: The bench harnesses under bench/, plus the shared statistics library in bench/measurement/. When to run each, how to read results, DuckDB analysis pattern, and green-light criteria.
last-reviewed: 2026-08-02
tags: [bench, performance, cost-model]
related: ["../docs/about/cost-model.md", "../tests/integration/maintenance-e2e.test.ts"]
---

# Bench harnesses

Two harnesses live under `bench/`:

| Harness | What it measures | When to run |
|---|---|---|
| `bench/r2-contention.ts` | CAS-storm 412/429 rates on one `current.json`; validates the idle-reader bound on the wire | When changing `packages/server/src/writer.ts`, coordination primitives, or retry policy |
| `bench/load-harness/` | Object-storage ops + bytes per logical `Db` operation across seven workload presets; validates the workload cost model. `--variant=node-gcs` (gated on `GCS=1` + `credentials/gcs.json`) is the source of the measured GCS write-amp behind the GCS row in [docs/about/cost-model.md](../docs/about/cost-model.md#cost-vs-scale-table) | When changing storage layout, manifest cache TTLs, or compaction profile — run before/after a perf-shaped PR |
| `bench/fold-cost.ts` | CPU + peak-heap cost of ONE compaction fold (the unsliceable snapshot rebuild) vs. snapshot bytes and snapshot row count; Phase 2 evidence for raising the snapshot ceilings `C` / `E` on a more capable host. No infra (MemoryStorage). MEASURES ONLY — changes no constant. | When validating / revisiting the snapshot-rebuild cost model in [docs/about/graduation.md](../docs/about/graduation.md) |
| `bench/measurement/fold-ceiling-probe-run.ts` | How far above today's `C` / `E` a fold still fits each host profile's CPU + memory budget, at 2× / 4× / 7× safety margins. Reuses the `fold-cost.ts` fixture verbatim so cells stay comparable to its frozen baseline. No infra (MemoryStorage). MEASURES ONLY. **No checked-in baseline yet** — its sampling and axis-aggregation methodology is unresolved; read the caveats in the section below before promoting any output. | When revisiting whether `C` / `E` can be raised on a more capable host |
| `bench/maintenance-backlog.ts` | Maintenance backlog (live log-tail entries + bucket object count + snapshot-over-ceiling minutes) vs. write rate, per trigger (in-band write-tick / scheduled cron) and profile (cf-free / node); Phase 2 evidence for whether FREE-RATE maintenance keeps up within the ~30 writes/min M-size envelope. Verdict is per-axis (tail + objects) then combined. No infra (MemoryStorage). MEASURES ONLY — changes no constant. | When validating / revisiting whether the per-host maintenance profile (`MAINTENANCE_PROFILE_CF_FREE` vs `MAINTENANCE_PROFILE_NODE`) is justified |
| `bench/amortized-write-cost.ts` | Amortized BILLABLE Class A ops (PUT+LIST; DeleteObject is $0) per logical write, INCLUDING in-band maintenance (folds + GC), across workload shapes × profile (cf-free / node). Source of truth for the write-amp constants in the cost CLI + the effective-write-amp claim in docs/about/cost-model.md. No infra (MemoryStorage). MEASURES ONLY. | When revisiting the write-amplification claim or the cost-CLI projection |
| `bench/write-amp-stress.ts` | STRESS variant of `amortized-write-cost.ts`: drives pathological churn workloads (100%-update tiny set, unbounded insert growth, 500-doc full rewrite) under aggressive in-band maintenance to find the PEAK billable Class A ops per logical write. Tracks `peak_billable_class_a_per_write` (single-writer; the route past ~4× is a CAS-retry storm, governed by the throughput ceiling, not measured here). Backs the "peaks ~4×, never reaches the retired >6 trigger" claim. No infra (MemoryStorage). MEASURES ONLY. Baseline at `docs/spec/attachments/amortized-write-cost-stress-baseline.json`. | When revisiting whether the retired `write-amp > 6` graduation trigger could ever fire |
| `bench/collection-fanout.ts` | Storage op cost of `discoverCollections` (LIST count) + full `admin usage` scan (LIST + GET count) vs. N collections under one tenant prefix, measured via a counting Storage proxy on MemoryStorage. No infra. MEASURES ONLY — re-derives the collections/tenant fan-out limit. A checked-in baseline lives at `docs/spec/attachments/collection-fanout-baseline.json`. | When revisiting the collections/tenant fan-out limit in docs/about/graduation.md or docs/about/workload-fit.md |
| `bench/measurement/` | Not a harness — the shared measurement **library** the harnesses above build on. `statistics.ts` holds the algorithm-tagged summaries (quantiles, MAD, three bootstraps, two binomial upper bounds, OLS via Householder QR), each carrying its algorithm tag and every parameter that determined the number. `storage-journal.ts` and `storage-factory.ts` hold the recording and isolation seam: a timer-free `Storage` decorator producing an ordered operation journal plus an exact namespace journal, and a per-attempt backend lease whose cleanup authority is one in-memory instance, one `mkdtemp` root, or an explicit key list. `fold-ceiling-probe.ts` is the pure half of the fold-ceiling probe. All pure; no infra — the directory's one script is `fold-ceiling-probe-run.ts` (`pnpm bench:fold-ceiling`). | When a bench emits a `p95`, a confidence interval, or a regression coefficient; or when it needs a recorded, disposable backend rather than a shared one |

Both require `pnpm dev:storage` (Minio `:9102` + Toxiproxy `:9104`)
for the Minio-backed variants. Neither is a per-PR CI gate. The
in-process counting proxy in
`tests/integration/maintenance-e2e.test.ts` and the randomized
cascade in `tests/integration/randomized.test.ts` are the
correctness gates that run on every PR.

## bench/r2-contention.ts

Three scenarios (S1 / S2-idle / S3-toxic), each driven separately:

```sh
pnpm bench:r2 --scenario=S2-idle --pollers=10 --duration-s=20
```

The canonical idle-reader gate is **S2-idle**: M pollers read
`current.json` every 2 seconds with no writers. The bound is
**< 1 Class A op / poller / hour** — a healthy idle reader stays on
the `get` path and never issues a `list`, `put`, or `delete`. A
violation prints a clear stderr message and exits 1.

Writes one JSON file per run to `bench/results/`; prints a one-line
summary to stdout. See `bench/r2-contention.ts` (head comment) for
full scenario semantics. The cost-model bound mirrors the in-process
gate in `tests/integration/maintenance-e2e.test.ts`.

## bench/load-harness/

Seven workload presets driven through the public `Db.table(...)` API
on four storage backends (memory / local-fs / node-minio / node-gcs)
with four manifest-cache modes (cold / metadata-warm / data-warm /
tiny-cache). Each run writes one JSON file to `bench/results/load/`.

```sh
# Smoke check — memory backend, default preset, small scale
pnpm bench:load --preset=recent-first-crud --records=1000 --ops=1000

# Minio backend (requires pnpm dev:storage to be running)
pnpm bench:load:minio --preset=recent-first-crud

# Real GCS bucket (requires GCS=1 + credentials/gcs.json; the eval
# bucket is shared bring-your-own — always pass a unique --app so
# the run's cleanup() sweeps only its own app/<app>/ prefix).
# Keep the scale small: the shared eval bucket sustains only sub-1
# write/s under this harness, so larger --records/--ops (e.g. 200/400)
# can run for many minutes without completing.
GCS=1 pnpm bench:load:gcs --preset=recent-first-crud --records=15 \
  --ops=30 --seed=42 --app=bench-gcs-$(uuidgen)

# Full sweep — all presets × variants × cache modes
pnpm bench:load:matrix
```

The headline number is **S3 GETs per `list-recent` on the
`recent-first-crud` preset, 100k records, hot tenant, node-minio,
metadata-warm cache**. Optimize against this number when changing
storage layout or manifest cache policy.

### Result JSON

One file per run; the canonical shape is `type RunResult` in
`bench/load-harness/cli.ts`. Every field is non-optional except
`run.backend_details`. File names follow the pattern:

```
bench/results/load/<preset>-<variant>-<cache-mode>-<timestamp>.json
```

Matrix runs write to a timestamped subdirectory:

```
bench/results/load/matrix-<timestamp>/<preset>-<variant>-<cache-mode>-<ts>.json
```

### Analysis: DuckDB

Install DuckDB once (`brew install duckdb`), then query across all
result files:

```sql
SELECT run.preset, run.cache_mode, run.variant,
  derived.get_per_op, derived.bytes_read_per_op,
  latency_ms.by_op.list_recent.p95
FROM read_json_auto('bench/results/load/*.json')
WHERE run.preset = 'recent-first-crud'
  AND run.cache_mode = 'metadata-warm'
ORDER BY run.timestamp DESC LIMIT 20;
```

For a matrix sweep run, point at the timestamped subdirectory:

```sql
SELECT run.preset, run.cache_mode, run.variant,
  derived.get_per_op, derived.class_a_per_tenant_per_hour
FROM read_json_auto('bench/results/load/matrix-20260512T120000/*.json')
ORDER BY derived.get_per_op DESC;
```

DuckDB accepts glob patterns without braces; see
<https://duckdb.org/docs/data/json/overview.html> for the full
`read_json_auto` reference.

### Presets

| Preset | Primary table | Workload shape |
|---|---|---|
| `recent-first-crud` | `notes` | Notes-app shape; recent-first reads dominate. Idle subworkload must satisfy the < 1 Class A op / tenant / hour gate. Headline preset. |
| `one-hot-tenant` | `notes` | 80/20 tenant skew: one hot tenant absorbs 80% of traffic. Stresses per-`current.json` contention and metadata-warm cache value. |
| `update-heavy-messy-log` | `items` | 50% updates over a small record set; 30% of records absorb 80% of update ops. Stresses log-tail growth and write-amplification post-compact. |
| `hot-tenant-compaction-debt` | `items` | One hot tenant seeded then flooded with inserts before queries run. Reveals query-pre-compact vs query-post-compact cost delta. |
| `many-tiny-apps` | `notes` | 1000 tenants each with 50–200 records; uniform traffic. Worst case for manifest cache: every tenant brings a cold `current.json` miss. |
| `rag-document-store` | `documents` | RAG document-store shape: `list-recent` + `filtered-list` reads dominate. Stresses cross-table read patterns and manifest layout per table. |
| `chat-conversation-store` | `messages` | Chat-conversation shape: append-heavy with recent-window context reads. Stresses the log path's read-recent pattern and `list-recent` semantics. |

Every preset is reproducible: same `--seed`, `--records`, and
`--ops` produce the same dataset and op stream.

### Phase isolation

Each run executes five phases in this order:

```
seed → ingest → query-pre-compact → compact → query-post-compact
```

Storage counters (`CountingStorage.reset()` + `snapshot()`) reset at
each phase boundary, so the result JSON's `compaction` block reflects
compaction work alone — never the preceding ingest. The `derived`
block aggregates across all phases; per-phase breakdown requires
querying the runner internals directly. See
`bench/load-harness/runner/` for the phase-boundary implementations.

### Snapshot vs. materialized view

The bench compares raw-log (un-compacted) versus snapshot + live-tail
(post-compaction). Baerly does not have a separate materialized-view
feature. If a future reader sees "with view" in a comparison, they
are reading the wrong document.

### Cost model

Raw counts in the JSON feed the cost model offline. The bench
deliberately does not bake pricing into output — region and provider
pricing change faster than the harness does. For per-line-item rates,
the cost-model's write-amplification meter (distinct from
`compaction.bytes_ratio` below — that is a within-compaction
output/input ratio, this meter is the storage-engine-literature
definition), and compression posture, see
[docs/about/cost-model.md](../docs/about/cost-model.md).

The key derived fields:

- `derived.get_per_op` — S3 GETs per logical `Db` operation (Class B
  cost driver).
- `derived.put_per_op` — S3 PUTs per logical op (Class A cost driver).
- `derived.class_a_per_tenant_per_hour` — Class A ops (PUT + LIST +
  DELETE) per tenant per hour, measured during the `query-post-compact`
  phase only. The bound is **< 1**; the in-process gate
  asserts exactly 0.
- `compaction.bytes_ratio` — bytes written by compaction divided
  by bytes read by compaction. Typical values are `<= 1` because
  compaction collapses many log-entry writes into a single
  snapshot; values approaching `1` (or `> 1`) indicate compaction
  isn't gaining ground and warrant investigation. Note this is
  NOT write amplification in the storage-engine-literature sense
  (which is total bytes written / logical bytes written and is
  always `>= 1`); this is a within-compaction
  output/input ratio.

## bench/measurement/

The one place a bench summarizes numbers. `statistics.ts` is a pure
library — not runnable, no I/O, no clock read, and one import: the
repository's canonical Mulberry32 PRNG.

`fold-ceiling-probe.ts` sits alongside it and splits the same way: the
module itself is pure and has no module-scope side effects, and
`fold-ceiling-probe-run.ts` is the runnable half wired to
`pnpm bench:fold-ceiling`. Its own section is below.

Every function returns its result **tagged**: the algorithm identifier
plus every parameter that determined the number — seed, resample count,
confidence, inclusion unit, statistic selector, design columns. A study
therefore cannot emit a bare `p95` or `confidence_interval` whose
definition has to be reconstructed later from prose.

`STATISTICS_ALGORITHMS` is the closed vocabulary:

| Tag | Returns |
|---|---|
| `quantile-nearest-rank-v1` | One-indexed `ceil(q*n)` over the ascending sort |
| `quantile-r7-v1` | Hyndman–Fan type 7 (R's `quantile` default) |
| `mad-from-median-v1` | Median absolute deviation, **raw** — no 1.4826 normal-consistency constant |
| `bootstrap-percentile-v1` | Percentile-interval bootstrap of a selectable statistic |
| `paired-ratio-bootstrap-v1` | Resamples complete pairs; median of per-pair ratios |
| `stratified-paired-difference-bootstrap-v1` | Resamples within each stratum, preserving stratum counts |
| `clopper-pearson-zero-failure-upper-v1` | Exact one-sided upper bound at zero observed failures |
| `wilson-one-sided-upper-v1` | Wilson score upper limit; the caller supplies `z` |
| `ols-qr-v1` | Least squares via Householder QR, no normal equations, no pivoting |

Three properties are load-bearing and easy to erode:

- **Expected values live in `STATISTICS_TEST_VECTORS`, as data.** The
  tests read their numbers from that constant and nowhere else, so a
  changed expectation necessarily moves the hash taken over it. Do not
  "simplify" a test back to inline literals.
- **Every emitted number is `-0`-normalized**, echoed caller parameters
  included. The canonical JSON these results feed rejects `-0` rather
  than normalizing it, and `-0` clears both `Number.isInteger(v) && v >= 0`
  and `!(v < 0)` untouched.
- **The module supplies algorithms only.** Sample counts, thresholds,
  retry rules, and candidate-admission policy are study-owned and
  always arrive as caller parameters. `wilson-one-sided-upper-v1`
  validates `(confidence, z)` against a table rather than deriving `z`,
  because deriving it would add an untagged tenth algorithm.

`ols-qr-v1` reports `condition_estimate` and never acts on it. The rank
gate is taken on the column-equilibrated QR diagonal, so it is
independent of column units and column order, but it still detects
deficiency rather than degree: a merely near-collinear design passes it
and returns coefficients that are numerically meaningless. A study that
reads those coefficients as physics must preregister a bar on
`condition_estimate`.

```sh
pnpm vitest run bench/measurement/statistics.test.ts
```

### storage-journal.ts — what a run did, without a clock

`wrapJournaledStorage` decorates any `Storage` and records two things.
The **operation journal** is ordered: method, key, the request options
that change semantics, PUT byte length and SHA-256, the result or error
class, and an attempt id. The **namespace journal** is exact — key and
byte-length state assembled from benchmark-owned provisioning plus
observed PUT/DELETE outcomes, with zero LIST calls spent to maintain it.

Timing is deliberately absent: no wall-clock field, no clock or timer
call, and no runtime import beyond the global Web Crypto digest. Tests
pin all three, the last two by reading the module's own source. That
keeps a semantics comparison free of clock noise and keeps the module
loadable outside Node.

Three behaviours to know before you consume a snapshot:

- **`snapshotOperations()` throws on non-quiescence.** A dispatched but
  unsettled row raises `JournalNotQuiescentError` rather than being
  omitted, because journal equality is the primary consumer and two
  silently-truncated lists compare equal to each other.
  `snapshotSettledOperations()` is the explicit opt-out.
- **`list` allocates its index at the first `next()`,** not at the call,
  so it rides a different clock from get/put/delete. A test pins the
  resulting interleaving rather than hiding it — any downstream
  comparator has to normalize for it.
- **An ambiguous PUT/DELETE failure marks that key uncertain,** so
  orphan accounting fails closed after a lost acknowledgement. The
  parallel `uncertainty` array carries the classification, the operation
  index, and whether the signal was already aborted at dispatch.

`billingClassOf` implements the [cost-model](../docs/about/cost-model.md)
definition — puts and lists bill, DELETE is $0. That is one definition,
not a resolution: a test records all three live and mutually
inconsistent definitions in the tree as evidence for their owner. Note
it counts `Storage` calls, not billable requests, so against a remote
backend that paginates or retries inside one call it understates Class A.

### storage-factory.ts — one disposable backend per attempt

`StorageFactory` provisions a fresh journaled backend; `StorageLease`
owns removing it. Cleanup authority is the point of the module, and it
is narrow by construction: a single in-memory instance, the single
`mkdtemp` directory the factory created, or an explicit key list.
Nothing here can delete a bucket, a parent directory, or a prefix.
Exact-key cleanup issues one DELETE per sorted, de-duplicated key, never
a LIST, and does not stop at the first failure.

`create()` turns a provisioning error into a structured
`{ status: "failed", failure }` rather than rejecting. Read that as a
statement about **provisioning** — the memory factory wraps its whole
body, while the local-fs factory wraps only the `mkdtemp` that can
actually fail; `new LocalFsStorage()` and `makeLease()` sit outside its
`try` because neither has a throw path (the former is a `resolve()` on a
string, the latter takes an already-branded `AttemptId`). Adding a
`catch` around them would ship an arm no test can reach, which is the
same reason `isWithinCleanupAuthority` is exported instead of inlined. If
either ever gains a throw path, widen the `try` then — and note the
`mkdtemp` directory is already created by that point, so the widened
catch has to remove it.

`cleanup()` is memoized, flips the lease to `cleaned` on first call
regardless of outcome, and reports `clean` / `partial` / `failed` naming
every failed target.

`withStorageLease(factory, work)` is the runner. It samples
`pendingOperationCount()` **before** cleanup and reports it on both
settled arms: a non-zero value means `work` abandoned an in-flight
operation and the backend was torn out from under it. It neither throws
nor waits on that — throwing would mask the work's own error, and there
is no safe general way to await an operation the caller abandoned — so
treat a result carrying `pending_operations_at_cleanup > 0` as invalid.

```sh
pnpm vitest run bench/measurement/storage-journal.test.ts \
  bench/measurement/storage-factory.test.ts
```

## bench/fold-cost.ts

A no-infra microbench (MemoryStorage) that measures the cost of ONE
compaction fold — the **unsliceable snapshot rebuild** — as a function
of two axes the cost model separates:

- **snapshot size in bytes** (JSON parse / stringify / SHA-256), and
- **snapshot row count** (per-entry parse / merge / serialize).

```sh
pnpm bench:fold-cost
```

Each grid point seeds a fresh `MemoryStorage` with a `current.json` + a
prior snapshot of an exact (rows × bytes/doc) shape + a fixed log tail,
then runs the real `compact()` once (whole tail in a single pass —
`minEntriesToCompact: 1`, large `maxEntriesPerRun`) so the measured cost
is the rebuild, not a sliced drain. The bytes axis brackets the
graduation.md cost-model table (64 KB / 256 KB / 512 KB / 1 MB / 5 MB);
the rows axis sweeps row count from 256 up past the current `E = 2048`
to 16 384 at tiny bytes/doc to isolate per-entry CPU.

**Measurement.** CPU is `process.cpuUsage()` user+system delta (ms) —
not wall-clock, because folds are CPU-bound on Workers and MemoryStorage
makes I/O ~free. Peak memory is a 1 ms sampler on
`process.memoryUsage().heapUsed`, peak-minus-start. Each point is warmed
then measured over N iterations; the JSON reports the **median only** for
both axes. min/max are deliberately omitted — a GC inside a fold can drop
heapUsed below the start mark (flooring the sampled-peak min to a
misleading 0) and a GC CPU spike is an outlier the median absorbs, so
neither carries signal in a checked-in reference. The byte-axis pad is a
single repeated-char string, so absolute byte numbers are a mild lower
bound vs. heterogeneous real docs; the linear shape is the portable
signal.

One timestamped JSON per run lands in `bench/results/fold-cost/`
(gitignored); a checked-in reference baseline lives at
[`docs/spec/attachments/fold-cost-baseline.json`](../docs/spec/attachments/fold-cost-baseline.json).
The JSON records each cell's `{rows, snapshot_bytes, cpu_ms_median,
peak_bytes_median, peak_over_snapshot, iterations}` plus a
`modelled_reference` block (the graduation.md `11 ms/MB`, `C`, and
provisional `E`) so a future reader can compare measured-vs-modelled and
find where the CPU / memory budget of a target host intersects the grid
— the input to raising `C` / `E` on paid.

This bench **measures only**: it never moves `C`, `E`, or any constant.
Re-sizing the ceilings off these numbers is an explicitly deferred later
phase.

## bench/measurement/fold-ceiling-probe.ts

Extends `fold-cost.ts` past today's ceilings: for each host profile
(cf-free / cf-paid / node) and each safety margin (2× / 4× / 7×), how
large could `C` and `E` be before the fold stops fitting the profile's
CPU and memory budget? Reuses `bench/lib/fold-fixture.ts` verbatim —
same seed, same tail, same measurement definitions — so its cells are
directly comparable to the frozen `fold-cost` baseline, and the runner
prints an overlap check against that baseline as a calibration signal.

```sh
BAERLY_SUBJECT_COMMIT=$(git rev-parse HEAD) pnpm bench:fold-ceiling
```

Takes minutes. **Run it on an otherwise-idle machine** — a contended run
produces a non-monotonic CPU column, and the large cells discard a high
fraction of peak samples to GC (see the flooring note under `fold-cost.ts`
above). Set `BAERLY_FOLD_CEILING_CELLS=<record.json>` to re-derive a
record from an existing run's cells without re-measuring; everything in
the record except `cells` is a pure function of them.

One timestamped JSON per run lands in `bench/results/fold-ceiling/`
(gitignored). **There is deliberately no checked-in baseline yet.** Three
methodology issues have to be resolved, and the grid re-run on a quiesced
machine, before any output of this probe is promoted to
`docs/spec/attachments/` or cited anywhere:

- **No minimum usable-sample floor.** `runCell` keeps the filtered median
  whenever _any_ sample survives `isPeakSampleUsable`, so a cell that
  discarded 7 of its 9 iterations reports a median over 2 samples with
  nothing in the record marking it as thin. The filter is also one-sided:
  it drops fully-floored samples and keeps partially-floored ones.
- **`largestSustainable` aggregates with `Math.max`.** That answers "the
  largest row count for which _some_ tested configuration fits", where a
  safety ceiling wants "…for which _all_ tested configurations fit". A
  cross-axis cell can credit a row count whose own rows-axis cell fails
  the same budget.
- **`binding_axis` is derived from an axis-mixed sort.** Rows-axis cells
  are byte-small but allocation-expensive, so they sort early and win
  `firstMiss`, letting one scalar annotate two independent verdicts.

Also read `todayHeadroom` with care: `nearestAtOrBelow` falls back to the
lowest cell when none is at or below the limit, and no bytes-axis cell
currently lands under `C` (the smallest measures 532300 against a 524288
ceiling), so "at today's `C`" is reported from a cell ~1.5% above it.

This probe **measures only**: it never moves `C`, `E`, or any constant.

## bench/maintenance-backlog.ts

A no-infra probe (MemoryStorage) that answers the Phase 2 question: **does
FREE-RATE maintenance keep up within the ~30 writes/min/collection M-size
envelope, or does the backlog grow without bound?** The "paid Workers are
throttled at the free maintenance rate" motivation rests on whether
free-rate maintenance actually FAILS to keep up — this bench measures it,
per trigger.

```sh
pnpm bench:maintenance-backlog
```

baerly has exactly two maintenance triggers, and they behave very
differently with respect to write rate — the bench measures BOTH as
separate scenarios:

- **in-band write-tick** (the sanctioned default): maintenance ticks on
  EVERY write via the writer's post-CAS `runBoundedMaintenance` dispatch.
  Each tick can fold up to `maxFoldEntriesPerPass` (20 on CF-free), so it
  intuitively keeps up unless the fold defers (snapshot over the `C`-byte
  or `E`-row ceiling) or GC sweep can't keep up with orphan production.
- **scheduled / cron** (opt-in): one `runScheduledMaintenance` tick per
  simulated minute, alternating compact (even minute) / GC (odd minute) —
  the CF even/odd-minute cron pattern. A compact tick folds ~20 entries
  while the workload produces `rate` entries/minute, so this is the
  trigger where free-rate counts can fall behind.

**Simulated time.** `writes/min` is the knob; a "minute" is a unit that
maps to `rate` real `Db` writes driven through the real `Writer` — there
is **no wall-clock claim** (the bench runs in seconds). The rate grid is
`{10, 30, 60, 120}` (30 = the documented M-size ceiling; 10 brackets
below, 60 / 120 bracket 2× / 4× above). Each rate runs under CF-free
(`MAINTENANCE_PROFILE_CF_FREE`, the subject) and Node
(`MAINTENANCE_PROFILE_NODE`, ~10× the per-pass caps, the comparison arm).

**GC grace.** Production GC waits 7 days (`GC_GRACE_PERIOD_MILLIS`) before
sweeping an orphan, so object-count drain is invisible in a few-second
bench. Like `maintenance-profile-equivalence.test.ts`, this bench uses the
`gcGraceMillis: 0` test seam so a marked orphan is sweepable the same
pass — modelling the drain **ceiling** (does sweep throughput keep up with
orphan production `p`?), not the 7-day-delayed production timing.

The JSON records, per (trigger, rate, profile) cell, a per-axis verdict —
`tail_verdict` and `objects_verdict` (each `bounded` / `growing`) — plus a
combined `verdict` (`bounded` ONLY IF both axes are bounded; otherwise
`growing (tail)` / `growing (objects)` / `growing (tail+objects)`, naming
the axis that grows) and the per-minute backlog trajectory
(`live_tail_entries`, `object_count`, `snapshot_bytes`, `snapshot_rows`,
`snapshot_over_ceiling`). The two axes use the same first-third-vs-last-third
framing with one deliberate difference: the **tail** axis is first-vs-last
(it starts near steady state), while the **objects** axis is
mid-third-vs-last-third with an additive `grew > working_set` floor and no
1.5× ratio gate — `object_count` ramps from 0 on a cold bucket (so the
first third is unrepresentative warm-up) and a slow monotonic climb that
never plateaus is a genuine unbounded GC-drain backlog even below 1.5×. One
timestamped JSON per run lands in `bench/results/maintenance-backlog/`
(gitignored); a representative baseline (full trajectories for the bounded
exemplar plus every `growing` cell, summaries for the clearly-bounded rest)
lives at
[`docs/spec/attachments/maintenance-backlog-baseline.json`](../docs/spec/attachments/maintenance-backlog-baseline.json).

**Verdict (baseline run).** In-band keeps up at every rate on **both**
profiles and **both axes** — the tail is a bounded sawtooth AND the object
count plateaus (~143–171), because the write-tick GC sweep keeps up with
orphan production. Scheduled is where free-rate maintenance falls behind,
and the per-axis split tells the honest story: scheduled CF-free is
`growing (objects)` already at 10/min (its large fold slice drains the tail
but the object count climbs) and `growing (tail+objects)` at 30 / 60 / 120.
**Scheduled Node is `growing (objects)` at 30 and 60** — the tail drains to
zero every other minute (so a tail-only verdict would mislabel it
`bounded`), but the object count climbs monotonically (~62→381 at 30/min,
~121→2082 at 60/min) because the alternating compact/GC cron can't sweep
orphans fast enough; only at 120/min does its tail also fall behind
(`growing (tail+objects)`). This is consistent with the GC drain-rate
invariant (`gcMaxSweeps / gcInterval = 10/4 ≥ p`, graduation.md §7.1): the
in-band object counts stay bounded because the write-tick GC sweep keeps
up, while the scheduled growth is partly a **fold** (compact) backlog and
partly a **GC-drain** (objects) backlog the one-word tail verdict used to
hide. The bench **measures only**: it reports this as Phase 2 evidence and
makes no call about changing any profile or constant.

## Green-light criteria

The bench gate is met when ALL of the following hold:

1. `pnpm bench:load:matrix` runs all seven presets on memory +
   local-fs + node-minio in under 10 minutes total wall-clock time.
2. The headline number — GETs per `list-recent`, `recent-first-crud`
   preset, 100k records, hot tenant, node-minio, metadata-warm cache
   — is logged with a baseline run; subsequent runs are comparable.
3. The idle bound (`< 1 Class A op / tenant / hour`) holds
   under `recent-first-crud`'s idle-reader subworkload, observable
   in the result JSON's `derived.class_a_per_tenant_per_hour` field.
4. Result files are DuckDB-queryable via
   `read_json_auto('bench/results/load/*.json')` using the analysis
   pattern above.
5. This README and `CLAUDE.md` both describe the two-harness split.

Explicitly NOT a green-light criterion: a per-PR CI gate. The bench
is run by humans hill-climbing storage layout, cache TTLs, and
compaction profiles. The in-process counting proxy
(`tests/integration/maintenance-e2e.test.ts`) and the randomized
cascade (`tests/integration/randomized.test.ts`) are the CI-level
gates that already serve the per-PR role.

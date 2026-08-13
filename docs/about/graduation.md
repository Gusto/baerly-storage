---
title: Graduation thresholds
audience: operator
summary: Operator runbook for a collection at or past a limit — map the symptom, pick the graduation path, and set the env var or move hosts.
last-reviewed: 2026-08-09
tags: [operations, cost, capacity, graduation]
related: [cost-model.md, workload-fit.md, thesis.md, "../spec/scale-ceilings.md", "../adr/002-ephemeral-coordination.md"]
---

# Graduation thresholds

Graduation is what you do when a collection or workload crosses one of
the documented bounds of the workload envelope — a scale event, not a
maturity one. [workload-fit.md](workload-fit.md#scale-at-a-glance)
defines that envelope; this page is the runbook for acting on it.

The threshold concept is **the fold**: the moment maintenance turns many
small committed writes into one refreshed snapshot. That makes reads
cheap again, but the snapshot rebuild still has to fit in one host turn.
The tail is the newer log entries not yet in that snapshot.
baerly-storage slices the tail, but it still rebuilds the whole snapshot
in one pass. Graduation starts when that rebuild no longer fits the
host's CPU, subrequest, or memory budget.

Watch `snapshot_bytes` and `snapshot_rows`. `baerly inspect` reports
them, and they also live on `current.json`. When write-tick maintenance
defers because either ceiling trips, it bumps
`db.compaction.deferred_total` and may emit a rate-limited
`console.warn` naming the dimension.

Two of the triggers below are cost lines rather than capacity ones: an
advisory at sustained ~100 writes/min account-wide, surfaced by
`baerly cost`, and a hard trigger at 50M Class A ops/mo sustained over
7 days. Both appear in the decision table with the values to compare
against;
[cost-model.md § Cost-side graduation signals](cost-model.md#cost-side-graduation-signals)
owns the meters and the dollar figures behind them.

Those two are **account-wide aggregate** write rates, because Class A is
billed per account. They are distinct from the per-collection
~30 writes/min contention ceiling in
[the workload envelope](workload-fit.md#scale-at-a-glance).

## Decision table

Start with these read-only checks:

```sh
baerly inspect \
  --bucket=s3://<bucket> \
  --app=<app> \
  --tenant=<tenant> \
  --collection=<collection>

baerly admin usage \
  --target=node \
  --bucket=s3://<bucket> \
  --app=<app> \
  --tenant=<tenant>
```

| Symptom | Check | Threshold | Action |
| --- | --- | --- | --- |
| `db.compaction.deferred_total` or defer `console.warn` on Cloudflare free | Warning names bytes vs. rows; `baerly inspect` reports `snapshot_bytes` / `snapshot_rows` | `snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E` (cf-free: `C = 512 KB`, `E = 2048`) | If bytes tripped, upgrade to Workers Paid and set `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which moves `C` to 8 MiB; raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` past that only to a cap the isolate can rebuild. If rows tripped, the same profile switch moves `E` to 32,768. `E` has no env override, but it is per host profile, so moving to a larger profile raises it. |
| Same defer on Node | Warning text plus `snapshot_bytes` / `snapshot_rows` from `baerly inspect` | Node ships `C = 32 MiB`, `E = 65,536`; check the host has RAM for old snapshot + new snapshot + tail | If bytes tripped, raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above 32 MiB, sized by `C ≈ heap / 10`; expect one inline write-latency spike. If rows tripped, Node already has the largest shipped `E` and there is no env override — split or graduate the collection. |
| GC-managed object count grows while writes are steady | Prefix inventory + logs + `admin fsck` | Stale-log/orphan-snapshot sweep throughput no longer keeps up with their production | Reduce contention, split the hot collection, or graduate the workload. Growth under `content/` is diagnosed separately: stop legacy writers, then dispose of the inert prefix manually. |
| Sustained hot collection | `admin usage` | ~30 logical writes/min/collection | Graduate to D1/Postgres; this is the workload ceiling. |
| Tenant data keeps growing | `admin usage` / bucket inventory | >10 GB/tenant (R2 free-tier storage line; see [cost-model.md](cost-model.md)) or ~100 collections/tenant (soft fan-out guideline; see [workload-fit.md](workload-fit.md#scale-at-a-glance)) | Review graduation cost; neither line is enforced by the protocol. |
| `baerly cost` prints advisory note | `baerly cost` | ~100 writes/min account-wide (provider-agnostic; 8.64M Class A/mo / ~$34/mo R2 object-storage ops, 12.96M / ~$65/mo S3), advisory only; see [cost-model.md](cost-model.md#ops-vs-cost-tradeoff) | Compare object storage's low operator burden against a managed DB. Hard trigger: 50M/mo (~580 writes/min / ~$221/mo R2; ~460 writes/min on Node). |

### How to read the output

`baerly inspect` reports the current snapshot key, `live_log_tail`,
`materialised_rows`, `snapshot_bytes`, and `snapshot_rows`.
`baerly admin usage` reports writes/min against the M-size ceiling: the
~30 writes/min/collection workload line.

For compaction, compare the **snapshot**, not the tail:

- `snapshot_bytes` against `C`;
- `snapshot_rows + maxFoldEntriesPerPass` against `E`; and
- `db.compaction.deferred_total` plus the rate-limited `console.warn`
  for the portable operator signal.

`C` and `E` are not one shared pair of numbers: each host profile ships
its own, sized to that host's measured wall. Look up the values for the
host you are on in
[the per-tier table](../spec/scale-ceilings.md#per-tier-bounds) before
comparing.

Some metric sinks preserve the byte-vs-row label on
`db.compaction.deferred_total`; the warning text always names it. A
large tail alone is not a graduation signal because it drains in slices.
Compare the snapshot against
[the auto-maintained ceiling](../spec/scale-ceilings.md#the-auto-maintained-snapshot-ceiling)
and [the per-tier table](../spec/scale-ceilings.md#per-tier-bounds).

## Graduation triggers

A persistently deferring fold means different things on different hosts.
Disambiguate before you act.

### The symptom: erosion, not a cliff

When a collection persistently defers its fold, data is not lost. The
symptoms are:

- **Reads get gradually slower.** Each read replays an ever-growing log
  tail on top of the stale snapshot: N extra GETs, with N climbing by
  one for every write since the last successful fold.
- **The bucket grows.** Unfolded log entries accumulate as objects and
  bytes because the fold that would collapse them never completes.
- **A warning appears.** `wrangler tail`, Vercel logs, or Node logs show
  a `console.warn` naming the collection and the byte-vs-row dimension.
  It is rate-limited by `current.json.last_warned_seq`, roughly once per
  `MAINTENANCE_WARN_INTERVAL_WRITES = 1000` writes. The defer path also
  bumps `db.compaction.deferred_total`.

### The drain-rate safety invariant

The GC-managed stale-log and orphan-snapshot population stays bounded
only while sweep throughput keeps up with production of those candidates:

> **`WRITE_TICK_GC_MAX_SWEEPS / WRITE_TICK_GC_INTERVAL` (= 10/4) ≥
> GC-managed orphan-production rate `p`.**

While that holds, stale logs and orphan snapshots drain and their object
count stays bounded. This invariant does not bound live log growth behind
a deferred fold or inert objects under the legacy `content/` prefix.

Two things upstream of the sweep can bind before sweep throughput does,
and neither is fixed by raising the sweep rate:

- **Mark coverage.** The one budgeted mark phase whose LIST window can
  stall on undeletable keys carries a persisted rotation cursor in
  `gc/pending.json` (`log_scan_cursor`). Without it, that phase can
  starve and the candidate never enters the ledger for the sweep budget
  to spend itself on.
- **Ledger depth.** `GC_MAX_PENDING_CANDIDATES` bounds how many
  candidates are in flight at once, across `stale-log` and
  `orphan-snapshot` together, and each cohort waits out
  `GC_GRACE_PERIOD_MILLIS` before it can be swept. (A legacy
  `orphan-content` entry on a v0.6.0 ledger counts against the same
  cap, but is evicted on sight rather than waiting out the grace
  period — see the eviction arm in `gc.ts`.) On a large accumulated
  backlog that ceiling — not the sweep budget — is what paces
  reclamation.

Folds continually make sub-floor log entries stale, while replaced or
CAS-losing snapshot publishes leave orphan snapshots. Under
above-envelope churn, those candidates can become eligible faster than
GC sweeps them. Growth in those prefixes is the signal; the protocol does
not silently lose data.

If bucket inventory instead shows growth under `content/`, do not treat it
as GC lag. Check for v0.6.0 nodes still writing during a mixed rollout, or
for a restore/raw copy that preserved a legacy content prefix. Quiesce the
legacy writers first, then follow the manual disposal guidance in
[Backups](../guide/backups.md#legacy-content-cleanup). Current GC never marks or deletes
those objects, so a restored legacy prefix can remain large without
violating the drain-rate invariant above.

### Which graduation?

Map the signal before acting:

- **Cloudflare free byte defer:** upgrade tier and set
  `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which moves `C` to 8 MiB. Only
  override `C` beyond that if you have sized it to memory.
- **Node byte defer:** raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above
  the 32 MiB node default, sized by `C ≈ heap / 10`.
- **Row defer:** `E` has no env override, but it is per host profile —
  move to a larger profile (2,048 → 32,768 → 65,536) to raise it. At
  node's 65,536, split or graduate.
- **Hot collection or tenant-scale signal:** graduate the workload to
  D1/Postgres.

A deferred fold alone does not mean "move to Postgres."

> **Cron does not help Cloudflare free.** Maintenance ticks on the write
> path. The opt-in `runScheduledMaintenance` SDK is useful for explicit
> maintenance windows, but a scheduled Worker has the same ~10 ms CPU
> limit as a request handler. A fresh budget per tick is not a larger
> budget. The levers are Workers Paid, a Node host, or a smaller cap.

### 1. Off Cloudflare free → Cloudflare paid

**Threshold:** the auto-maintained snapshot ceiling at the cf-free
values: ~512 KB snapshot / ~100-500 docs, or `E = 2048` rows, whichever
trips first —
`snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E`.

**What you'll observe:** slower reads, a growing bucket, and a
`console.warn` naming bytes vs. rows.

**What to do:** upgrade to Cloudflare Workers Paid (about $5/mo; 30 s
CPU vs. free's ~10 ms), then set `BAERLY_MAINTENANCE_PROFILE=cf-paid`.
That alone moves `C` to 8 MiB and `E` to 32,768 and compaction resumes;
there is no env override to set for the common case. On paid, CPU stops
being the practical wall and Worker memory (~128 MB) becomes the limit —
which is why the paid ceiling is 8 MiB rather than "tens of MB"
([why that number](../spec/scale-ceilings.md#per-tier-bounds)). If you
override `C` past the profile value, size it to memory, not CPU; see
[Operations plane](#operations-plane-env-vars).

### 2. On serverful Node: raise the env var

When the warning names bytes, this is not a tier graduation. A Node host
has no per-request CPU wall; the ceiling is host RAM, and the node
profile already ships `C = 32 MiB` — the top of the measured grid, not
a measured wall, so a host with headroom can go further. Raise
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, scaling by `C ≈ heap / 10`
([where that rule comes from](../spec/scale-ceilings.md#what-is-shipped-vs-estimated));
the fold completes on the next write, with one inline
write-latency spike. If the warning names
rows, the env var will not help: `E` has no override, and node already
runs the largest shipped value (65,536).

### 3. Paid serverless → serverful Node

**Threshold:** a snapshot approaches the cf-paid ceiling — **8 MiB** of
snapshot, or 32,768 rows.

**What you'll observe:** on paid Cloudflare, folds start running into
the ~128 MB Worker memory limit. The fold cannot hold the old snapshot,
new snapshot, and log tail resident at once. CPU is still fine.

**What to do:** move the collection to a long-lived Node host, which
selects the node profile automatically (`C = 32 MiB`, `E = 65,536`),
then raise the env cap as above if the host has the heap for it, or wait
for chunked snapshots. The current
snapshot format is single-level (one L9 snapshot replaces the prior) and
is forward-compatible with a future multi-level L0..L9 scheme that folds
incrementally without a wire change.

### Tail churn is not a graduation signal

A small, heavily updated collection, such as 50 docs receiving constant
updates, can build a large tail that collapses to a handful of `_id`s.
Under the prior unsliceable-fold model, that large tail could trip the
ceiling. It no longer does.

The tail is sliced by `maxFoldEntriesPerPass`, so a large tail drains
over many write ticks. Each CF-free pass folds about 20 entries into the
small snapshot, and the snapshot stays small. Tail length alone does
not defer; only the snapshot axis (`C` bytes / `E` rows) defers.

### 4. Off baerly-storage → Postgres: the workload envelope

Triggers 1-3 ask whether one collection's fold fits one host. This asks
whether write throughput or total scale still belongs on baerly-storage.

**Threshold:** any envelope axis crossed — ~30 logical
writes/min/collection, >10 GB/tenant stored, or ~100 collections/tenant.
[workload-fit.md § Scale at a glance](workload-fit.md#scale-at-a-glance)
defines the envelope and what each axis means; none of the three is
enforced by the protocol.

**What you'll observe:** `baerly admin usage` grades each collection
against the write line. The other two axes have no runtime signal — a
tenant is a key prefix, so bucket inventory is what tells you.

**What to do:** graduate the workload to D1/Postgres, regardless of
deployment tier. For Postgres, use `baerly export --target=postgres`.
For why the envelope is drawn where it is, see
[workload-ceiling](thesis.md#workload-ceiling); for the adjacent cost
lines, see
[cost-model.md](cost-model.md#cost-side-graduation-signals).

## Operations plane (env vars)

Maintenance has two configuration planes:

- **Application authoring:** `defineConfig`, `baerlyNode`, and the
  `.d.ts` surface expose no maintenance config. App authors do not tune
  folds.
- **Operations / control plane:** env vars set out-of-band by an
  operator or platform. This plane is empty by default; use it only
  after deciding which graduation path applies. Do not put these vars in
  `defineConfig`, `baerlyNode`, or any `.d.ts`; they are not part of the
  application contract.

| Env var | Effect | When to set it |
| --- | --- | --- |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Overrides static snapshot ceiling `C`, whatever the active profile's value is (512 KB cf-free, 8 MiB cf-paid, 32 MiB node). Raises `S_max = C`, letting larger snapshot rebuilds pass the gate. Must be a positive number: zero or negative throws on every request that reads it — including a Cloudflare health probe, since the free-tier ceiling warning reads this var before `/v1/healthz` short-circuits. An empty or non-numeric value (e.g. `""`, `"8mb"`) is ignored and falls back to the profile default instead of throwing. | On a large Node host, after confirming the host can rebuild that snapshot (`C ≈ heap / 10`). On Cloudflare, prefer the profile switch first. |
| `BAERLY_MAINTENANCE_PROFILE` | Cloudflare-only. Accepts `cf-free` (default) or `cf-paid`. `cf-paid` raises fold-entry and GC cadence/mark/sweep caps to Node values, using the paid 10,000-subrequest budget, **and** selects the paid ceilings `C = 8 MiB` / `E = 32,768`. This is the only way to raise `E` on Cloudflare. | On Cloudflare Paid, after upgrading the plan tier, to recover per-pass throughput and the paid ceilings. Do not set on Node; Node selects its own profile, and its ceilings, automatically. |
| `BAERLY_MAINTENANCE_DISABLE` | Kill switch; disables in-band fold/GC phases while preserving bounded `tail_hint` refresh. Accepts a closed, case-insensitive vocabulary only: `""` / `"0"` / `"false"` (not disabled, the default) or `"1"` / `"true"` (disabled). Any other value throws on every request that reads it instead of being silently accepted — on Node and Cloudflare alike, `/v1/healthz` and `/v1/spec` are unaffected since they're served before this var is read. | Diagnostics, or to stop fold attempts on a deferring collection while you plan graduation. |

There is no env var for `E`. It is a kernel constant, not
adapter-threaded — but there are three of them, one per profile (2,048 /
32,768 / 65,536), so the profile in effect is what sets it. Selecting a
larger profile is the supported way to raise `E`.

**Cloudflare caveat: size the cap to the isolate.** Raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above what a CF isolate can rebuild
can create a killed-rebuild loop: the gate passes, the rebuild runs in
`ctx.waitUntil`, the isolate is killed by CPU or memory, no in-band
backoff fires, and the next write tries again.

On the free profile, the CF adapter `console.warn`s once at handler init
when `BAERLY_MAINTENANCE_MAX_FOLD_BYTES > CF_FREE_MAX_SAFE_FOLD_BYTES`
(1 MiB), the largest snapshot a free isolate can one-shot rebuild under
the ~10 ms budget. It stays silent on `cf-paid`, whose own ceiling is
already 8x that bound and whose wall is memory rather than CPU. There is
still no runtime metric for the kill itself.
Watch the snapshot key and object count from `baerly inspect`; a
snapshot key that never advances while `live_log_tail` grows is a
rebuild that keeps not landing.

Safe remedies, in order:

- **Cloudflare Paid:** raises CPU limits; `BAERLY_MAINTENANCE_PROFILE=cf-paid`
  then applies ceilings already sized to the ~128 MB memory wall rather
  than the 30 s CPU budget. Any further override is sized to memory too.
- **Serverful Node:** no per-request CPU/subrequest cap; bounded by host
  RAM, and the node profile is selected automatically. Raise the env cap
  above 32 MiB only with heap to spare.
- **Chunked snapshots:** future multi-level L0..L9 rebuilds would avoid
  holding the whole snapshot resident. Not shipped.

## How to raise a limit

| Limit | How to raise it | Notes |
| --- | --- | --- |
| Static fold-byte ceiling `C` (512 KB cf-free / 8 MiB cf-paid / 32 MiB node) | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` env var | Set out-of-band in the deploy environment; takes effect on the next write tick. Size to what the host can rebuild — `C ≈ heap / 10`. |
| Static fold-row ceiling `E` (2,048 cf-free / 32,768 cf-paid / 65,536 node) | Move to a larger host profile: `BAERLY_MAINTENANCE_PROFILE=cf-paid` on Cloudflare, or a Node host (automatic) | No env var sets `E` directly. Node's 65,536 is the largest shipped value; past it, split or graduate the collection. |
| Cloudflare free CPU / subrequest wall (~10 ms CPU, 50 subrequests) | Cloudflare plan upgrade (free → paid), then `BAERLY_MAINTENANCE_PROFILE=cf-paid` | Paid raises CPU to 30 s default (up to 5 min); subrequest limit lifts to 10,000/request by default, raisable to 10M, changed 2026-02-11. The profile switch also moves `C`/`E` to the paid ceilings, so `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` is only needed to go past 8 MiB. A finer-grained per-platform `cpuLimit` declaration was evaluated and measured unnecessary: the in-band write tick keeps up to ~3x the rate envelope under stress on free, so it is not built. |
| Per-collection commit scope (one ordered log per collection; no cross-collection atomicity) | Cannot be increased; protocol invariant | The write hotspot is the next numbered `log/<seq>` create for one collection. Cross-collection atomicity is not offered. |
| Snapshot and legacy-content hash addressing | Cannot be increased; protocol invariant | Snapshot filenames embed full SHA-256, and current readers recompute the body hash before accepting a snapshot. Legacy content filenames use 128-bit truncated SHA-256 and collisions were never runtime-verified; the objects are now inert and nothing reads or reclaims them, so the truncation carries no remaining safety obligation. |

`E` is in this map, but with a different lever: it is a kernel constant
per profile rather than an env-var knob, so the profile is what raises
it.

## See also

- [workload-fit.md](workload-fit.md#scale-at-a-glance) — the published
  envelope this page triggers on, and whether the app fitted in the
  first place.
- [cost-model.md](cost-model.md) — Class A ops, write-amp, stored bytes,
  and the cost meters behind the two cost triggers.
- [scale-ceilings.md](../spec/scale-ceilings.md) — why `C`, `E`, and the
  per-tier walls are the numbers they are. Read it when a threshold here
  is challenged rather than acted on.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is named
  and why graduation is the success path.
- [adr/002-ephemeral-coordination.md](../adr/002-ephemeral-coordination.md)
  — why graduation is mechanical: there is no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the handoff to
  Postgres.

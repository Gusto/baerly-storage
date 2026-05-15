---
title: Bench harnesses
audience: coder
summary: Two bench harnesses under bench/ — r2-contention.ts and load-harness/. When to run each, how to read results, DuckDB analysis pattern, and green-light criteria.
last-reviewed: 2026-05-12
tags: [bench, performance, cost-model]
related: ["../docs/about/cost-model.md", "../tests/integration/phase5-end-to-end.test.ts"]
---

# Bench harnesses

Two harnesses live under `bench/`:

| Harness | What it measures | When to run |
|---|---|---|
| `bench/r2-contention.ts` | CAS-storm 412/429 rates on one `current.json`; validates the idle-reader bound on the wire | When changing `packages/server/src/server-writer.ts`, coordination primitives, or retry policy |
| `bench/load-harness/` | S3 ops + bytes per logical `Db` operation across seven workload presets; validates the workload cost model | When changing storage layout, manifest cache TTLs, or compaction profile — run before/after a perf-shaped PR |

Both require `pnpm dev:storage` (Minio `:9102` + Toxiproxy `:9104`)
for the Minio-backed variants. Neither is a per-PR CI gate. The
in-process counting proxy in
`tests/integration/phase5-end-to-end.test.ts` and the randomized
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
gate in `tests/integration/phase5-end-to-end.test.ts`.

## bench/load-harness/

Seven workload presets driven through the public `Db.table(...)` API
on three storage backends (memory / local-fs / node-minio) with four
manifest-cache modes (cold / metadata-warm / data-warm / tiny-cache).
Each run writes one JSON file to `bench/results/load/`.

```sh
# Smoke check — memory backend, default preset, small scale
pnpm bench:load --preset=recent-first-crud --records=1000 --ops=1000

# Minio backend (requires pnpm dev:storage to be running)
pnpm bench:load:minio --preset=recent-first-crud

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
write-amplification meter, and compression posture, see
[docs/about/cost-model.md](../docs/about/cost-model.md).

The key derived fields:

- `derived.get_per_op` — S3 GETs per logical `Db` operation (Class B
  cost driver).
- `derived.put_per_op` — S3 PUTs per logical op (Class A cost driver).
- `derived.class_a_per_tenant_per_hour` — Class A ops (PUT + LIST +
  DELETE) per tenant per hour, measured during the `query-post-compact`
  phase only. The bound is **< 1**; the in-process gate
  asserts exactly 0.
- `compaction.write_amplification` — bytes written by compaction /
  bytes read by compaction.

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
(`tests/integration/phase5-end-to-end.test.ts`) and the randomized
cascade (`tests/integration/randomized.test.ts`) are the CI-level
gates that already serve the per-PR role.

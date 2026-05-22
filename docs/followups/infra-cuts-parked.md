# Followups: contributor-infra cuts

### I1. `bench/r2-contention*` matrix

**Brief's claim:** 1660 LoC of sweep-matrix + interpreter +
sigkill harness for "should we ship on R2?" — already answered.

**Why parked:** `phase5-end-to-end.test.ts` validates the
cost-model bound on every PR via a counting-storage proxy, but
*on the wire* validation lives only here. Delete after launch
preflight runs.

### I2. `bench/load-harness/` 7 presets, 3 corpora

**Brief's claim:** ~3k LoC, no published baseline, hasn't been
re-run since May.

**Why parked:** Same logic as I1. The load harness exists to
catch tail-latency regressions; "haven't run it" ≠ "won't run
it." After launch, freeze one preset + one backend + one cache
mode, delete the rest.

### I5–I20. Misc test/build infra

`since-options.test.ts`, `resolve-ts.mjs` + `register-hooks.mjs`,
`bench/{compactor-loop,metrics,storage,types,toxiproxy}.ts`,
`bench/storage.test.ts`, `baerly-copy-minio.test.ts`,
`export-smoke.test.ts` (Postgres dep), `vitest.config.ts` glob
consolidation, coverage harness, `consistency.ts` `eval()` use,
`phase5-crash-fuzz` vs `index-crash-fuzz` scope split,
`examples/*/smoke.test.ts` glob, `extract-bench-calibration.ts`
+ `fetch-bench-fixtures.sh`.

**Why parked:** Each is real but each is a single-test or
single-glob fix. None is on the critical path for first-touch
DX. Batch into a "contributor-infra trim" branch after launch.

---

## When unparking

Three conditions reasonable to wait for:

1. Launch preflight (`pnpm eval:run -- --app todo --trials 3`)
   has run. → unblocks I3.
2. R2-contention bound holds against current code. → unblocks
   I1 + I7.
3. Load-harness baseline is recorded. → unblocks I2 + I20.

After those run: dispatch one subagent per cluster (bench,
eval, test-glob, build-script), each tasked with deletion +
verification that `pnpm verify` + `pnpm test` stay green.

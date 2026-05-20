# Followups: contributor-infra cuts (parked)

**Source: 2026-05-19 analyst triage (I1–I20).** Parked per user
direction during triage: these aren't first-touch DX wins, and
deletion risk-reward is worse than for surface-trim work.
Revisit after launch preflight.

The analyst was aggressive here ("free maintainer time for DX
work"). That bias is reasonable but not a forcing function —
several of these directories also serve as failure-mode escape
hatches that pay off rarely but pay off hugely when they do
(R2-contention, manual-e2e). Don't delete pre-launch what
might be needed post-launch.

---

## Why parked

Two reasons:

1. **Pre-launch, contributor infra is cheap to keep, expensive
   to recreate.** `bench/r2-contention*` and `eval/` are
   launch-preflight tools. Once we've run the preflight, they
   can move to a branch — but until then, they're load-bearing.
2. **The analyst conflates "unused on every PR" with "dead
   code."** A bench that hasn't been re-run since May doesn't
   mean delete; it means the cost model it validates hasn't
   changed. The maintainer infra still answers questions when
   something breaks.

---

## Items deferred

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

### I3. `eval/` scaffolding eval

**Brief's claim:** 3.1k LoC harness for one-shot launch
preflight ("first eval pass is `--app todo --trials 3`").

**Why parked:** This is *the* launch preflight. Run it, then
archive to a branch. Deleting before running is irreversible
loss of the eval harness for the launch decision.

### I4. `tests/integration/day-one-handshake.test.ts`

**Brief's claim:** Duplicates `manual-e2e/*/e2e.test.ts`.

**Why parked:** Possible — but the day-one gate exists with a
specific contract (manual deploy lifecycle). Verify the actual
overlap before deletion. Low-effort to verify; medium-blast
to delete.

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

import { fc } from "@fast-check/vitest";

const numRuns = process.env["FC_NUM_RUNS"] ? Number(process.env["FC_NUM_RUNS"]) : 100;

// Note on the orphan-iteration bleed at high `FC_NUM_RUNS`: when a
// property test exceeds vitest's `testTimeout`, vitest aborts and runs
// `afterEach`, but fast-check's microtask iteration loop keeps going
// and the orphan iterations operate on the *next* test's freshly-
// created storage (via the shared module-level `s`). The fix lives in
// `vitest.config.ts`, which bumps `testTimeout` to 10 minutes when
// `FC_NUM_RUNS > 1000` so the property tests have room to complete
// cleanly. We deliberately do *not* set `interruptAfterTimeLimit` here
// — `fc.configureGlobal` applies it across every property test, and
// some tests override their own vitest `timeout` (e.g.
// `tests/integration/maintenance-crash-fuzz.test.ts` sets 10 minutes per
// test even at default `FC_NUM_RUNS=100`). A global interrupt would
// fail those tests prematurely.

fc.configureGlobal({ numRuns });

import type { FoldBudget } from "./boundary.ts";
import type { ModelOp } from "./model.ts";
import type { ObserverAction } from "./schedule.ts";

/**
 * The default budget for scenarios that are not studying a ceiling.
 *
 * Every field is deliberately far above what the scenarios reach, so a property
 * that fails does so because of the boundary rule under test and not because a
 * ceiling clipped it. Override the one field a scenario is actually probing —
 * `roomyBudget({ maxEntriesPerRun: 0 })`, `roomyBudget({ ceilingEntries: 1 })` —
 * rather than defining a second budget, so the deviation is visible at the call
 * site.
 *
 * `subrequestLimit` is a model assumption, not a kernel constant; see
 * `CF_FREE_BUDGET` in `boundary.ts`.
 */
export const roomyBudget = (overrides: Partial<FoldBudget> = {}): FoldBudget => ({
  maxEntriesPerRun: 100,
  minEntriesToCompact: 1,
  ceilingBytes: 1_000_000,
  ceilingEntries: 1_000,
  subrequestLimit: 10_000,
  ...overrides,
});

/**
 * A log of `count` distinct inserts, one document each.
 *
 * Deliberately the simplest possible log: no updates, no deletes, no key
 * collisions, so row count equals sequence number and a boundary assertion reads
 * directly off the fold end. Scenarios that need overwrite and delete traffic
 * build their own log (see `syntheticOperations` in `evidence-report.test.ts`).
 */
export const operations = (count: number): readonly ModelOp[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "I" as const,
    docId: `doc-${index}`,
    value: index,
  }));

/**
 * One observer's fold attempt, defaulting to a fully-informed, non-crashing,
 * manifest-aligned pass.
 *
 * `readsAtGeneration: Number.MAX_SAFE_INTEGER` is the sentinel `schedule.ts`
 * reads as "latest generation"; override it with a concrete generation to model
 * a lagging observer.
 */
export const action = (overrides: Partial<ObserverAction> = {}): ObserverAction => ({
  observerId: 0,
  readsAtGeneration: Number.MAX_SAFE_INTEGER,
  observedTail: 20,
  k: 5,
  budget: roomyBudget(),
  algorithm: "aligned-manifest",
  crashAt: "none",
  ...overrides,
});

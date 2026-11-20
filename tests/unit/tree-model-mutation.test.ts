/**
 * Every tree-model mutation schedule must pass unmutated, with its property
 * exercised, and go red under its mutant, with its property exercised and
 * violated and nothing else violated beyond the schedule's declared
 * collateral. A schedule runs here once the log-path system can run it,
 * its property is evaluable there, and its mutant is implemented; today
 * those are the schedules for the commit and read properties, whose
 * mutants wrap the log-path system.
 */
import { describe, expect, test } from "vitest";
import {
  ALL_TREE_CAPABILITIES,
  capabilitiesOf,
  crashOf,
  LOG_PATH_MUTANTS,
  logPathSystem,
  runTreeSchedule,
  scheduleProblems,
  type TreeRun,
  type TreeSystemFactory,
} from "../fixtures/tree-executor.ts";
import {
  checkTreeProperties,
  isEvaluable,
  TREE_MUTATION_SCHEDULES,
  TREE_PROPERTY_NAMES,
  treeProperty,
  type TreeMutationSchedule,
} from "../fixtures/tree-model-properties.ts";

const logPathMutant = (
  schedule: TreeMutationSchedule,
): ((make: TreeSystemFactory) => TreeSystemFactory) | undefined =>
  schedule.mutant.seam === "system" && Object.hasOwn(LOG_PATH_MUTANTS, schedule.mutant.name)
    ? LOG_PATH_MUTANTS[schedule.mutant.name as keyof typeof LOG_PATH_MUTANTS]
    : undefined;

const logPathCapabilities = capabilitiesOf(logPathSystem());

const liveOnLogPath = TREE_MUTATION_SCHEDULES.filter(
  (schedule) =>
    scheduleProblems(schedule.schedule, logPathCapabilities).length === 0 &&
    isEvaluable(treeProperty(schedule.property), logPathCapabilities, {}) &&
    logPathMutant(schedule) !== undefined,
);

const violated = (run: TreeRun): string[] =>
  checkTreeProperties(run)
    .filter(({ status }) => status === "violated")
    .map(({ name }) => name);

describe("tree-model mutation schedules", () => {
  test("every property has a schedule, and schedules are in property order", () => {
    expect([...new Set(TREE_MUTATION_SCHEDULES.map(({ property }) => property))]).toEqual([
      ...TREE_PROPERTY_NAMES,
    ]);
  });

  test("every schedule is well formed and lists only other properties as collateral", () => {
    for (const schedule of TREE_MUTATION_SCHEDULES) {
      expect(
        scheduleProblems(schedule.schedule, ALL_TREE_CAPABILITIES),
        `${schedule.mutant.name} schedule`,
      ).toEqual([]);
      expect(schedule.collateral, `${schedule.mutant.name} collateral`).not.toContain(
        schedule.property,
      );
    }
  });

  test("the log path runs the commit- and read-property schedules", () => {
    expect(liveOnLogPath.map(({ property, mutant }) => `${property}/${mutant.name}`)).toEqual([
      "acknowledged-never-lost/ack-without-create",
      "unacknowledged-never-visible/resend-crashed-commit",
      "unacknowledged-never-visible/double-commit",
      "unacknowledged-never-visible/resend-acknowledged-write",
      "cold-and-warm-equal-reference/cold-read-skips-newest-entry",
    ]);
  });

  for (const schedule of liveOnLogPath) {
    test(`${schedule.mutant.name} turns ${schedule.property} red`, async () => {
      const passing = await runTreeSchedule(logPathSystem, schedule.schedule);
      expect(violated(passing)).toEqual([]);
      const passingTarget = checkTreeProperties(passing).find(
        ({ name }) => name === schedule.property,
      )!;
      expect(passingTarget.status).toBe("holds");

      const mutated = await runTreeSchedule(
        logPathMutant(schedule)!(logPathSystem),
        schedule.schedule,
      );
      const target = checkTreeProperties(mutated).find(({ name }) => name === schedule.property)!;
      expect(target.exercised).toBe(true);
      expect(target.status).toBe("violated");
      expect(
        violated(mutated).filter(
          (name) =>
            name !== schedule.property &&
            !(schedule.collateral as readonly string[]).includes(name),
        ),
      ).toEqual([]);

      // Both runs reached every crash the schedule places.
      for (const run of [passing, mutated]) {
        for (const step of run.steps) {
          if (crashOf(step.transition) !== undefined) {
            expect(step.crashFired, `${run.system} step ${step.index}`).toBe(true);
          }
        }
      }
    });
  }
});

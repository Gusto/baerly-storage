import type { ModelState, ModelWorkloadAssumptions } from "./types.ts";

export interface ModelObjectBoundObservation {
  readonly liveDocuments: number;
  readonly activeLevels: number;
  readonly unreclaimedAttempts: number;
}

export class ModelAssumptionViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelAssumptionViolationError";
  }
}

function assertModelObservationWithinAssumptions(
  assumptions: ModelWorkloadAssumptions,
  observation: ModelObjectBoundObservation,
): void {
  const observations = [
    ["liveDocuments", observation.liveDocuments, "maxLiveDocuments", assumptions.maxLiveDocuments],
    ["activeLevels", observation.activeLevels, "maxActiveLevels", assumptions.maxActiveLevels],
    [
      "unreclaimedAttempts",
      observation.unreclaimedAttempts,
      "maxConcurrentPublishers",
      assumptions.maxConcurrentPublishers,
    ],
  ] as const;

  for (const [observationName, actual, assumptionName, maximum] of observations) {
    if (!Number.isInteger(actual) || actual < 0 || actual > maximum) {
      throw new ModelAssumptionViolationError(
        `${observationName}=${actual} exceeds ${assumptionName}=${maximum}`,
      );
    }
  }
}

export const calculateModelObjectBound = (
  assumptions: ModelWorkloadAssumptions,
  observation: ModelObjectBoundObservation,
): number => {
  assertModelObservationWithinAssumptions(assumptions, observation);
  const { liveDocuments, activeLevels, unreclaimedAttempts } = observation;
  const runsPerLevel = assumptions.maxRunsPerLevel;
  const committedSuffixEntries = assumptions.maxCommittedSuffixEntries;

  return (
    2 +
    liveDocuments +
    activeLevels * runsPerLevel +
    2 * committedSuffixEntries +
    unreclaimedAttempts * Math.max(4, 2 * committedSuffixEntries + runsPerLevel + 3)
  );
};

export const countModelObjects = (state: ModelState): number => state.store.objects.size + 1;

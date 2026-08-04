export const MODEL_OPERATION_KINDS = [
  "append-log",
  "emit-run",
  "publish-root",
  "merge-runs",
  "lose-publication-cas",
  "crash",
  "retry",
  "reconstruct",
  "reclaim",
] as const;

export type ModelOperationKind = (typeof MODEL_OPERATION_KINDS)[number];

export type ModelChange =
  | { readonly kind: "put"; readonly value: number }
  | { readonly kind: "delete" };

export interface ModelMutation {
  readonly mutationId: string;
  readonly sequence: number;
  readonly documentId: string;
  readonly change: ModelChange;
}

export interface ModelWorkloadAssumptions {
  readonly maxLiveDocuments: number;
  readonly maxActiveLevels: number;
  readonly maxRunsPerLevel: number;
  readonly maxCommittedSuffixEntries: number;
  readonly maxConcurrentPublishers: number;
  readonly maxScheduleOperations: number;
}

export const MODEL_ASSUMPTION_KEYS = [
  "maxLiveDocuments",
  "maxActiveLevels",
  "maxRunsPerLevel",
  "maxCommittedSuffixEntries",
  "maxConcurrentPublishers",
  "maxScheduleOperations",
] as const satisfies readonly (keyof ModelWorkloadAssumptions)[];

export const MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS: ModelWorkloadAssumptions = {
  maxLiveDocuments: 1,
  maxActiveLevels: 2,
  maxRunsPerLevel: 1,
  maxCommittedSuffixEntries: 1,
  maxConcurrentPublishers: 2,
  maxScheduleOperations: 4,
};

export function validateModelFullSuiteAssumptions(assumptions: ModelWorkloadAssumptions): void {
  for (const key of MODEL_ASSUMPTION_KEYS) {
    const value = assumptions[key];
    const minimum = MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS[key];
    if (!Number.isInteger(value) || value < minimum) {
      throw new RangeError(
        `invalid full-suite assumption ${key}=${String(value)}; minimum=${minimum}`,
      );
    }
  }
}

export function modelAssumptionMismatch(
  expected: ModelWorkloadAssumptions,
  actual: ModelWorkloadAssumptions,
): string | null {
  for (const key of MODEL_ASSUMPTION_KEYS) {
    if (actual[key] !== expected[key]) {
      return `model assumption mismatch: ${key}=${String(actual[key])}; expected=${expected[key]}`;
    }
  }
  return null;
}

export const DEFAULT_MODEL_ASSUMPTIONS: ModelWorkloadAssumptions = {
  maxLiveDocuments: 8,
  maxActiveLevels: 3,
  maxRunsPerLevel: 2,
  maxCommittedSuffixEntries: 6,
  maxConcurrentPublishers: 2,
  maxScheduleOperations: 40,
};

export const MODEL_BASE_SHA = "68e42ce7cbbc195f0711539981c178625a1e715a";

/**
 * `foldedThrough` value meaning "no manifest has folded anything yet".
 *
 * Every consumer compares `object.sequence <= foldedThrough` to decide whether
 * a suffix entry has already been absorbed into a run. Sequence 0 is a valid
 * point in the model domain, so the empty case cannot be spelled `0` without
 * making "nothing folded" indistinguishable from "sequence 0 folded". Four
 * consumers each re-derived this sentinel independently and one of them chose
 * `0`, which made an acknowledged sequence-0 entry reclaimable by
 * {@link reachableModelObjectKeys} while both reconstruction paths still
 * served it. Import this rather than writing the literal again.
 */
export const MODEL_NOTHING_FOLDED = -1;

export interface ModelContentObject {
  readonly kind: "content";
  readonly key: string;
  readonly documentId: string;
  readonly value: number;
}

export interface ModelLogObject {
  readonly kind: "log";
  readonly key: string;
  readonly mutation: ModelMutation;
  readonly contentKey: string | null;
}

export interface ModelAckObject {
  readonly kind: "ack";
  readonly key: string;
  readonly sequence: number;
  readonly mutationId: string;
}

/**
 * Canonical dedup and replay order for mutations: sequence first, `mutationId`
 * as the tie-break. Every consumer that has to decide which mutation wins for a
 * document sorts by this, so the tie-break is part of the modeled protocol
 * rather than a local choice.
 *
 * Deliberately shared by the reference, cold, and warm reconstruction paths.
 * Those three stay independent in what makes them differ — which objects they
 * read, whether they reuse a warm run, how they materialise content — and
 * `cold-and-warm-equal-reference-replay` is meaningful because of that. It was
 * never meaningful for the tie-break: the copies were verbatim, so an ordering
 * bug agreed with itself in all three and the property stayed green.
 *
 * Copying it instead is the {@link MODEL_NOTHING_FOLDED} failure mode: a rule
 * re-derived per consumer, one consumer left behind, and the divergence landing
 * outside the reconstruction paths where nothing compares it.
 */
export const compareModelMutations = (left: ModelMutation, right: ModelMutation): number =>
  left.sequence - right.sequence || left.mutationId.localeCompare(right.mutationId);

/**
 * Canonical order for the acknowledged suffix: sequence first, key as the
 * tie-break. Separate from {@link compareModelMutations} because an
 * acknowledgement is ordered before its log entry has been read, so the
 * mutation is not yet in hand.
 */
export const compareModelAcknowledgements = (left: ModelAckObject, right: ModelAckObject): number =>
  left.sequence - right.sequence || left.key.localeCompare(right.key);

export interface ModelRunObject {
  readonly kind: "run";
  readonly key: string;
  readonly level: number;
  readonly mutations: readonly ModelMutation[];
  readonly complete: true;
}

export interface ModelManifestObject {
  readonly kind: "manifest";
  readonly key: string;
  readonly generation: number;
  readonly predecessorKey: string | null;
  readonly foldedThrough: number;
  readonly levels: readonly {
    readonly level: number;
    readonly runKeys: readonly string[];
  }[];
}

export type ModelObject =
  | ModelContentObject
  | ModelLogObject
  | ModelAckObject
  | ModelRunObject
  | ModelManifestObject;

export interface ModelRootPointer {
  readonly generation: number;
  readonly etag: string;
  readonly manifestKey: string | null;
}

export interface ModelStore {
  readonly objects: ReadonlyMap<string, ModelObject>;
  readonly root: ModelRootPointer;
  readonly durableTrace: readonly ModelDurableTraceEntry[];
}

export type ModelDurableEffect =
  | { readonly kind: "put-immutable"; readonly object: ModelObject }
  | { readonly kind: "cas-root"; readonly expectedEtag: string; readonly next: ModelRootPointer }
  | { readonly kind: "delete-object"; readonly key: string };

export type ModelCrashBoundary = "before" | "after";

export interface ModelDurableTraceEntry {
  readonly effectId: string;
  readonly operationId: string;
  readonly effectIndex: number;
  readonly effect: ModelDurableEffect;
  readonly outcome: "applied" | "conflict" | "crashed-before" | "crashed-after";
}

export interface ModelDurableResult {
  readonly store: ModelStore;
  readonly outcome: ModelDurableTraceEntry["outcome"];
  readonly traceEntry: ModelDurableTraceEntry;
}

export interface ModelWarmCache {
  readonly rootGeneration: number | null;
  readonly runs: ReadonlyMap<string, ModelRunObject>;
}

export interface ModelAppendLogOperation {
  readonly kind: "append-log";
  readonly operationId: string;
  readonly mutation: ModelMutation;
  readonly acknowledgement: "acknowledge" | "drop";
}

export interface ModelEmitRunOperation {
  readonly kind: "emit-run";
  readonly operationId: string;
  readonly runId: string;
  readonly level: number;
  readonly sequences: readonly number[];
}

export interface ModelPublicationInput {
  readonly publicationId: string;
  readonly expectedGeneration: number;
  readonly runKeys: readonly string[];
  readonly foldedThrough: number;
  readonly role: "tail" | "base";
}

export interface ModelPublishRootOperation extends ModelPublicationInput {
  readonly kind: "publish-root";
  readonly operationId: string;
}

export interface ModelMergeRunsOperation {
  readonly kind: "merge-runs";
  readonly operationId: string;
  readonly mergeId: string;
  readonly inputRunKeys: readonly string[];
  readonly outputRunId: string;
  readonly targetLevel: number;
}

export interface ModelLosePublicationCasOperation {
  readonly kind: "lose-publication-cas";
  readonly operationId: string;
  readonly winner: ModelPublicationInput;
  readonly loser: ModelPublicationInput;
}

export interface ModelCrashOperation {
  readonly kind: "crash";
  readonly operationId: string;
  readonly targetOperationId: string;
  readonly durableEffectIndex: number;
  readonly boundary: ModelCrashBoundary;
}

export interface ModelRetryOperation {
  readonly kind: "retry";
  readonly operationId: string;
  readonly targetOperationId: string;
}

export interface ModelReconstructOperation {
  readonly kind: "reconstruct";
  readonly operationId: string;
  readonly mode: "cold" | "warm" | "reference";
}

export interface ModelReclaimOperation {
  readonly kind: "reclaim";
  readonly operationId: string;
  readonly candidateKeys: readonly string[];
}

export type ModelOperation =
  | ModelAppendLogOperation
  | ModelEmitRunOperation
  | ModelPublishRootOperation
  | ModelMergeRunsOperation
  | ModelLosePublicationCasOperation
  | ModelCrashOperation
  | ModelRetryOperation
  | ModelReconstructOperation
  | ModelReclaimOperation;

export type ModelTransitionOutcome =
  | "applied"
  | "rejected"
  | "crashed-before"
  | "crashed-after"
  | "cas-lost";

export interface ModelAttempt {
  readonly operation: ModelOperation;
  readonly durableEffects: readonly ModelDurableEffect[];
  readonly outcome: ModelTransitionOutcome;
}

export interface ModelCoverage {
  readonly crashBoundaries: ReadonlySet<string>;
  readonly publicationOutcomes: ReadonlySet<"win" | "lose">;
  readonly maintenanceOrders: ReadonlySet<"tail-before-base" | "base-before-tail">;
  readonly rejectedArms: ReadonlySet<string>;
}

export interface ModelState {
  readonly assumptions: ModelWorkloadAssumptions;
  readonly store: ModelStore;
  readonly referenceLedger: readonly ModelMutation[];
  readonly attempts: ReadonlyMap<string, ModelAttempt>;
  readonly pendingCrash: ModelCrashOperation | null;
  readonly warmCache: ModelWarmCache;
  readonly coverage: ModelCoverage;
  readonly unreclaimedByAttempt: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unreclaimedAttempts: number;
}

export interface ModelTransition {
  readonly state: ModelState;
  readonly operation: ModelOperation;
  readonly outcome: ModelTransitionOutcome;
  readonly durableEffects: readonly ModelDurableEffect[];
  readonly rejectionId: string | null;
  readonly reconstructionMode: ModelReconstructOperation["mode"] | null;
}

export interface ModelRun {
  readonly initial: ModelState;
  readonly final: ModelState;
  readonly transitions: readonly ModelTransition[];
}

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { expect, test } from "vitest";

import {
  alignedManifestBoundary,
  alignedManifestTarget,
  alignedObservedBoundary,
  CF_FREE_BUDGET,
  liveGreedyBoundary,
  prepareFold,
  type BoundaryInput,
  type FoldBudget,
} from "./boundary.ts";
import { foldCost } from "./cost.ts";
import {
  applySnapshot,
  emptyState,
  makeSnapshot,
  replayAcknowledged,
  rowsAtManifest,
  type ModelLog,
  type ModelOp,
  type ModelState,
} from "./model.ts";
import {
  drainToQuiescence,
  reclaimUnreferenced,
  runSchedule,
  type ObserverAction,
} from "./schedule.ts";

const BASE_SHA = "ac3ed48e5bd39aa4a758d05d40a5195e0d84eccc" as const;
const DETERMINISTIC_SEED = 20260803 as const;
const K_SWEEP = [8, 16, 20, 32, 64, 200] as const;
const SYNTHETIC_LOG_LENGTH = 640;
const REPORT_ROOT = "bench/results/fold-boundary-model";
const SOURCE_FILES = [
  "tests/model/fold-boundary/arbitraries.ts",
  "tests/model/fold-boundary/boundary.test.ts",
  "tests/model/fold-boundary/boundary.ts",
  "tests/model/fold-boundary/cost.ts",
  "tests/model/fold-boundary/evidence-report.test.ts",
  "tests/model/fold-boundary/model.test.ts",
  "tests/model/fold-boundary/model.ts",
  "tests/model/fold-boundary/orphan-bound.test.ts",
  "tests/model/fold-boundary/progress-bound.test.ts",
  "tests/model/fold-boundary/schedule.ts",
] as const;
const PROPERTY_CATALOG = [
  {
    question: 1,
    propertyIds: [
      "P1a_manifestTargetIsIndependentOfObservationAndBudget",
      "P1b_liveAndObservedAlignedTargetsDependOnObservedAvailability",
    ],
    command: "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P1a_|P1b_'",
  },
  {
    question: 2,
    propertyIds: [
      "P2a_fewerThanNextKEntriesProducesNoObjectOrProgress",
      "P2b_retryAfterAvailabilityUsesTheSameManifestTarget",
    ],
    command: "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P2a_|P2b_'",
  },
  {
    question: 3,
    propertyIds: [
      "P3a_crashBeforeCasLeavesManifestUnchangedAndRetryUsesSameTarget",
      "P3b_laggingObserverBoundarySequenceIsAPrefixOfFullyInformedSequence",
    ],
    command: "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P3a_|P3b_'",
  },
  {
    question: 4,
    propertyIds: [
      "P4a_firstTargetAfterKChangeIsStrictlyMonotoneAndNewKAligned",
      "P4b_mixedKObserversCanPrepareDifferentObjectsFromOneGeneration",
    ],
    command: "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P4a_|P4b_'",
  },
  {
    question: 5,
    propertyIds: [
      "P5a_observersOnOppositeSidesOfOneBoundaryEmitAtMostOneObjectForOneK",
      "P5b_sameManifestSameKAlwaysProducesTheSameObjectKey",
    ],
    command: "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P5a_|P5b_'",
  },
  {
    question: 6,
    propertyIds: [
      "P6a_sameGenerationSameKContentionAddsNoDistinctCasOrphan",
      "P6b_successfulFoldCanIncreaseRatherThanReduceReclaimableObjects",
      "P6c_mixedKContentionHasAReachableDistinctCasOrphan",
      "P6d_crashAfterPutHasAReachableNeverReferencedSnapshot",
      "P6e_reclamationRemovesAllAndOnlyNonCurrentSnapshots",
    ],
    command:
      "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P6a_|P6b_|P6c_|P6d_|P6e_'",
  },
  {
    question: 7,
    propertyIds: [
      "P7a_everyPreparedManifestBoundaryStrictlyAdvancesAndIsAligned",
      "P7b_everyPreparedReadSetIsTheExactContiguousInterval",
      "P7c_contiguousIncrementalFoldEqualsReferenceReplay",
      "P7d_publishedSnapshotCanPreserveEveryAcknowledgedPrefix",
      "P7e_everyPublishedSnapshotMatchesReferenceReplayThroughItsFloor",
    ],
    command:
      "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P7a_|P7b_|P7c_|P7d_|P7e_'",
  },
  {
    question: 8,
    propertyIds: [
      "P8a_tightKnownTailCostIsNPlusFiveWithSnapshotAndNPlusFourWithout",
      "P8b_deferredAttemptStillPaysSnapshotAndLogReadsButNoPuts",
      "P8c_kAboveMaxEntriesCannotPrepare",
      "P8d_zeroMaxEntriesIsAnExplicitZeroProgressCounterexample",
      "P8e_manifestAlignedProgressFitsCfFreeWithTightKnownTailForKAtMostTwenty",
      "P8f_scheduledStaleProbeCanExceedThePerPassSubrequestLimit",
    ],
    command:
      "FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t 'P8a_|P8b_|P8c_|P8d_|P8e_|P8f_'",
  },
] as const;

type ClaimClassification =
  | "universally-quantified-property"
  | "bounded-deterministic-observation"
  | "explicit-counterexample"
  | "unresolved";

interface EvidenceClaim {
  readonly question: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly classification: ClaimClassification;
  readonly conclusion: string;
  readonly propertyIds: readonly string[];
  readonly command: string;
}

interface EvidenceCounterexample {
  readonly id: string;
  readonly observed: boolean;
  readonly [key: string]: unknown;
}

interface EvidencePayload {
  readonly status: "research-only / non-authorizing";
  readonly baseSha: typeof BASE_SHA;
  readonly generatedAtUtc: string;
  readonly deterministicSeed: typeof DETERMINISTIC_SEED;
  readonly effectiveFcNumRuns: number;
  readonly nodeVersion: string;
  readonly liveConstants: Readonly<Record<string, number>>;
  readonly modelParameters: {
    readonly kSweep: typeof K_SWEEP;
    readonly syntheticLogLength: number;
    readonly alignmentOrigin: "absolute-sequence-zero";
  };
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly claims: readonly EvidenceClaim[];
  readonly counterexamples: readonly EvidenceCounterexample[];
  readonly unresolvedQuestions: readonly string[];
  readonly implementationAuthorization: "No implementation mechanism is authorized by this research evidence.";
  readonly tables: object;
}

const roomyBudget = (overrides: Partial<FoldBudget> = {}): FoldBudget => ({
  maxEntriesPerRun: 200,
  minEntriesToCompact: 1,
  ceilingBytes: 10_000_000,
  ceilingEntries: 10_000,
  subrequestLimit: 10_000,
  ...overrides,
});

const syntheticOperations = (length: number, seed: number): readonly ModelOp[] => {
  let state = seed >>> 0;
  return Array.from({ length }, (_, sequence) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const docId = `doc-${state % 97}`;
    if (sequence % 11 === 10) {
      return { kind: "D" as const, docId };
    }
    return {
      kind: sequence < 97 ? ("I" as const) : ("U" as const),
      docId,
      value: state,
    };
  });
};

const stateWithTail = (tail: number, tailHint = tail): ModelState => {
  const state = emptyState({
    ops: syntheticOperations(tail, DETERMINISTIC_SEED),
    acknowledgedTail: tail,
  });
  if (tailHint === tail) {
    return state;
  }
  const manifest = { ...state.manifest, tailHint };
  return { ...state, manifest, manifestHistory: [{ ...manifest }] };
};

const action = (overrides: Partial<ObserverAction> = {}): ObserverAction => ({
  observerId: 0,
  readsAtGeneration: Number.MAX_SAFE_INTEGER,
  observedTail: 20,
  k: 5,
  budget: roomyBudget(),
  algorithm: "aligned-manifest",
  crashAt: "none",
  ...overrides,
});

const inputAt = (
  floor: number,
  observedTail: number,
  k: number,
  budget = roomyBudget(),
): BoundaryInput => {
  const log: ModelLog = {
    ops: syntheticOperations(Math.max(floor, observedTail), DETERMINISTIC_SEED),
    acknowledgedTail: Math.max(floor, observedTail),
  };
  const base = emptyState(log);
  const state =
    floor === 0 ? base : applySnapshot(base, makeSnapshot(replayAcknowledged(log, floor), floor));
  return { manifest: state.manifest, observedTail, budget, k };
};

const sha256 = (contents: Buffer | string): string =>
  createHash("sha256").update(contents).digest("hex");

const sourceHashes = async (repoRoot: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(
      SOURCE_FILES.map(
        async (path) => [path, sha256(await readFile(join(repoRoot, path)))] as const,
      ),
    ),
  );

interface SourceToken {
  readonly kind: "identifier" | "punctuation" | "string";
  readonly value: string;
}

const sourceTokens = (source: string): readonly SourceToken[] => {
  const tokens: SourceToken[] = [];
  let index = 0;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) {
        break;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (current === "`" || current === "'" || current === '"') {
      const quote = current;
      const start = index + 1;
      index = start;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          break;
        }
        index += 1;
      }
      if (quote !== "`") {
        tokens.push({ kind: "string", value: source.slice(start, index) });
      }
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(current)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
        index += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }

    tokens.push({ kind: "punctuation", value: current });
    index += 1;
  }

  return tokens;
};

const declaredPropertyIdsInSource = (source: string): readonly string[] => {
  const tokens = sourceTokens(source);
  return tokens.flatMap((token, index) => {
    const previous = tokens[index - 1];
    const openParen = tokens[index + 1];
    const propertyId = tokens[index + 2];
    const comma = tokens[index + 3];
    return token.kind === "identifier" &&
      token.value === "test" &&
      previous?.value !== "." &&
      openParen?.value === "(" &&
      propertyId?.kind === "string" &&
      /^P[1-8][a-z]_[A-Za-z0-9]+$/.test(propertyId.value) &&
      comma?.value === ","
      ? [propertyId.value]
      : [];
  });
};

const declaredPropertyIds = async (repoRoot: string): Promise<ReadonlySet<string>> => {
  const propertyTestFiles = SOURCE_FILES.filter(
    (path) => path.endsWith(".test.ts") && !path.endsWith("evidence-report.test.ts"),
  );
  const sources = await Promise.all(
    propertyTestFiles.map((path) => readFile(join(repoRoot, path), "utf8")),
  );
  return new Set(sources.flatMap(declaredPropertyIdsInSource));
};

const writeReport = async (
  repoRoot: string,
  payload: EvidencePayload,
  markdown: string,
): Promise<string> => {
  const root = resolve(repoRoot, REPORT_ROOT);
  await mkdir(root, { recursive: true });
  const timestamp = payload.generatedAtUtc.replaceAll(":", "-");
  let suffix = 0;

  for (;;) {
    const candidate = join(root, `${timestamp}${suffix === 0 ? "" : `-${suffix}`}`);
    try {
      await mkdir(candidate);
      await writeFile(join(candidate, "report.json"), `${JSON.stringify(payload, null, 2)}\n`, {
        flag: "wx",
      });
      await writeFile(join(candidate, "report.md"), markdown, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      suffix += 1;
    }
  }
};

const renderMarkdown = (payload: EvidencePayload): string => `# Fold-boundary research evidence

Status: **${payload.status}**

No implementation mechanism is authorized by this report.

## Provenance

- Base SHA: \`${payload.baseSha}\`
- Generated UTC: \`${payload.generatedAtUtc}\`
- Deterministic scenario seed: \`${payload.deterministicSeed}\`
- Effective FC_NUM_RUNS: \`${payload.effectiveFcNumRuns}\`
- Node: \`${payload.nodeVersion}\`
- Alignment origin: \`${payload.modelParameters.alignmentOrigin}\`
- Synthetic log length: \`${payload.modelParameters.syntheticLogLength}\`
- K sweep: \`${payload.modelParameters.kSweep.join(", ")}\`

## Claims

${payload.claims
  .map(
    (claim) =>
      `### Q${claim.question} — ${claim.classification}\n\n${claim.conclusion}\n\nProperties: ${claim.propertyIds.map((id) => `\`${id}\``).join(", ")}\n\nCommand: \`${claim.command}\``,
  )
  .join("\n\n")}

## Deterministic tables

\`\`\`json
${JSON.stringify(payload.tables, null, 2)}
\`\`\`

## Counterexamples

\`\`\`json
${JSON.stringify(payload.counterexamples, null, 2)}
\`\`\`

## Unresolved questions

${payload.unresolvedQuestions.map((question) => `- ${question}`).join("\n")}

## Source SHA-256

${Object.entries(payload.sourceSha256)
  .map(([path, digest]) => `- \`${digest}\`  \`${path}\``)
  .join("\n")}
`;

test("R1_reportIsCollisionSafeSelfConsistentAndTraceableToProperties", async () => {
  const repoRoot = process.cwd();
  const log: ModelLog = {
    ops: syntheticOperations(SYNTHETIC_LOG_LENGTH, DETERMINISTIC_SEED),
    acknowledgedTail: SYNTHETIC_LOG_LENGTH,
  };
  const initial = emptyState(log);

  const boundaryTargetDependence = [12, 18].map((observedTail) => {
    const input = inputAt(7, observedTail, 5);
    return {
      floor: 7,
      observedTail,
      k: 5,
      liveGreedy: liveGreedyBoundary(input),
      alignedObserved: alignedObservedBoundary(input),
      alignedManifest: alignedManifestBoundary(input),
      manifestTarget: alignedManifestTarget(input.manifest.logSeqStart, input.k),
    };
  });
  expect(boundaryTargetDependence).toEqual([
    {
      floor: 7,
      observedTail: 12,
      k: 5,
      liveGreedy: 12,
      alignedObserved: 10,
      alignedManifest: 10,
      manifestTarget: 10,
    },
    {
      floor: 7,
      observedTail: 18,
      k: 5,
      liveGreedy: 18,
      alignedObserved: 15,
      alignedManifest: 10,
      manifestTarget: 10,
    },
  ]);

  const tightTailCost = K_SWEEP.map((k) => {
    const withSnapshot = foldCost({
      manifest: {
        generation: 1,
        logSeqStart: 8,
        snapshotKey: "prior",
        tailHint: 8 + k,
      },
      probeFloor: 8 + k,
      observedTail: 8 + k,
      logEntriesRead: k,
      reachedSnapshotPut: true,
      reachedCurrentCas: true,
    });
    const withoutSnapshot = foldCost({
      manifest: {
        generation: 0,
        logSeqStart: 0,
        snapshotKey: null,
        tailHint: k,
      },
      probeFloor: k,
      observedTail: k,
      logEntriesRead: k,
      reachedSnapshotPut: true,
      reachedCurrentCas: true,
    });
    return {
      k,
      withSnapshotTotal: withSnapshot.total,
      withoutSnapshotTotal: withoutSnapshot.total,
      snapshotDelta: withSnapshot.total - withoutSnapshot.total,
      cfFreeSubrequestLimit: CF_FREE_BUDGET.subrequestLimit,
    };
  });
  expect(tightTailCost.map(({ withSnapshotTotal }) => withSnapshotTotal)).toEqual([
    13, 21, 25, 37, 69, 205,
  ]);
  expect(tightTailCost.map(({ withoutSnapshotTotal }) => withoutSnapshotTotal)).toEqual([
    12, 20, 24, 36, 68, 204,
  ]);
  expect(tightTailCost.map(({ snapshotDelta }) => snapshotDelta)).toEqual([1, 1, 1, 1, 1, 1]);

  const productionBudget = roomyBudget();
  const foldAndObjectProduction = K_SWEEP.map((k) => {
    const aligned = drainToQuiescence({
      initial,
      budget: productionBudget,
      k,
      algorithm: "aligned-manifest",
      maxPasses: SYNTHETIC_LOG_LENGTH + 2,
    });
    const live = drainToQuiescence({
      initial,
      budget: productionBudget,
      k,
      algorithm: "live-greedy",
      maxPasses: SYNTHETIC_LOG_LENGTH + 2,
    });
    return {
      k,
      alignedWrittenFolds: aligned.attempts.filter(({ outcome }) => outcome === "written").length,
      alignedObjects: aligned.finalState.snapshots.size,
      alignedFinalFloor: aligned.finalState.manifest.logSeqStart,
      liveWrittenFolds: live.attempts.filter(({ outcome }) => outcome === "written").length,
      liveObjects: live.finalState.snapshots.size,
      liveFinalFloor: live.finalState.manifest.logSeqStart,
      materializedRowsEqual:
        JSON.stringify([...rowsAtManifest(aligned.finalState).entries()].toSorted()) ===
        JSON.stringify([...rowsAtManifest(live.finalState).entries()].toSorted()),
    };
  });
  expect(
    foldAndObjectProduction.map(
      ({
        alignedWrittenFolds,
        alignedObjects,
        alignedFinalFloor,
        liveWrittenFolds,
        liveObjects,
        liveFinalFloor,
        materializedRowsEqual,
      }) => ({
        alignedWrittenFolds,
        alignedObjects,
        alignedFinalFloor,
        liveWrittenFolds,
        liveObjects,
        liveFinalFloor,
        materializedRowsEqual,
      }),
    ),
  ).toEqual([
    {
      alignedWrittenFolds: 80,
      alignedObjects: 80,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      alignedWrittenFolds: 40,
      alignedObjects: 40,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      alignedWrittenFolds: 32,
      alignedObjects: 32,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      alignedWrittenFolds: 20,
      alignedObjects: 20,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      alignedWrittenFolds: 10,
      alignedObjects: 10,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      alignedWrittenFolds: 3,
      alignedObjects: 3,
      alignedFinalFloor: 600,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
  ]);

  const sameKRacersResult = runSchedule({
    initial: stateWithTail(20),
    observers: [
      action({ observerId: 1, readsAtGeneration: 0, observedTail: 5, k: 5 }),
      action({ observerId: 2, readsAtGeneration: 0, observedTail: 9, k: 5 }),
    ],
  });
  const sameKRacers = {
    outcomes: sameKRacersResult.attempts.map(({ outcome }) => outcome),
    foldEnds: sameKRacersResult.attempts.map(({ foldEnd }) => foldEnd),
    emittedKeys: sameKRacersResult.attempts.map(({ emittedKey }) => emittedKey),
    storedObjects: sameKRacersResult.finalState.snapshots.size,
    neverReferencedObjects: sameKRacersResult.neverReferencedSnapshots.length,
  };
  expect(sameKRacers.outcomes).toEqual(["written", "cas_lost"]);
  expect(sameKRacers.foldEnds).toEqual([5, 5]);
  expect(new Set(sameKRacers.emittedKeys).size).toBe(1);
  expect(sameKRacers.storedObjects).toBe(1);
  expect(sameKRacers.neverReferencedObjects).toBe(0);

  const mixedKRacersResult = runSchedule({
    initial: stateWithTail(20),
    observers: [
      action({ observerId: 1, readsAtGeneration: 0, observedTail: 20, k: 4 }),
      action({ observerId: 2, readsAtGeneration: 0, observedTail: 20, k: 6 }),
    ],
  });
  const mixedKRacers = {
    outcomes: mixedKRacersResult.attempts.map(({ outcome }) => outcome),
    foldEnds: mixedKRacersResult.attempts.map(({ foldEnd }) => foldEnd),
    emittedKeys: mixedKRacersResult.attempts.map(({ emittedKey }) => emittedKey),
    storedObjects: mixedKRacersResult.finalState.snapshots.size,
    neverReferencedObjects: mixedKRacersResult.neverReferencedSnapshots.length,
  };
  expect(mixedKRacers.outcomes).toEqual(["written", "cas_lost"]);
  expect(mixedKRacers.foldEnds).toEqual([4, 6]);
  expect(new Set(mixedKRacers.emittedKeys).size).toBe(2);
  expect(mixedKRacers.storedObjects).toBe(2);
  expect(mixedKRacers.neverReferencedObjects).toBe(1);

  const crashRetryResult = runSchedule({
    initial: stateWithTail(20),
    observers: [
      action({ observerId: 1, observedTail: 20, k: 5, crashAt: "after_snapshot_put" }),
      action({ observerId: 2, observedTail: 20, k: 5 }),
    ],
  });
  const crashRetry = {
    outcomes: crashRetryResult.attempts.map(({ outcome }) => outcome),
    foldEnds: crashRetryResult.attempts.map(({ foldEnd }) => foldEnd),
    emittedKeys: crashRetryResult.attempts.map(({ emittedKey }) => emittedKey),
    finalGeneration: crashRetryResult.finalState.manifest.generation,
  };
  expect(crashRetry.outcomes).toEqual(["crashed", "written"]);
  expect(crashRetry.foldEnds).toEqual([5, 5]);
  expect(new Set(crashRetry.emittedKeys).size).toBe(1);
  expect(crashRetry.finalGeneration).toBe(1);

  const unavailableState = stateWithTail(4);
  const availabilityRetry = {
    target: alignedManifestTarget(unavailableState.manifest.logSeqStart, 5),
    before: prepareFold({
      state: unavailableState,
      observedTail: 4,
      probeFloor: 4,
      budget: roomyBudget(),
      k: 5,
      algorithm: "aligned-manifest",
    }),
    after: prepareFold({
      state: stateWithTail(5),
      observedTail: 5,
      probeFloor: 5,
      budget: roomyBudget(),
      k: 5,
      algorithm: "aligned-manifest",
    }),
  };
  expect({
    target: availabilityRetry.target,
    beforeOutcome: availabilityRetry.before.outcome,
    beforeFoldEnd: availabilityRetry.before.foldEnd,
    beforeSnapshot: availabilityRetry.before.snapshot,
    afterOutcome: availabilityRetry.after.outcome,
    afterFoldEnd: availabilityRetry.after.foldEnd,
  }).toEqual({
    target: 5,
    beforeOutcome: "below_min_threshold",
    beforeFoldEnd: null,
    beforeSnapshot: null,
    afterOutcome: "prepared",
    afterFoldEnd: 5,
  });

  const firstFold = runSchedule({
    initial: stateWithTail(10),
    observers: [action({ observerId: 1, observedTail: 10, k: 5 })],
  });
  const secondFold = runSchedule({
    initial: firstFold.finalState,
    observers: [action({ observerId: 2, observedTail: 10, k: 5 })],
  });
  const reclaimed = reclaimUnreferenced(secondFold.finalState);
  const reclamation = {
    beforeFirstFold: firstFold.reclaimableSnapshots.length,
    afterSecondSuccessfulFold: secondFold.reclaimableSnapshots.length,
    storedBeforeReclamation: secondFold.finalState.snapshots.size,
    storedAfterReclamation: reclaimed.snapshots.size,
    currentObjectPreserved:
      reclaimed.manifest.snapshotKey !== null &&
      reclaimed.snapshots.has(reclaimed.manifest.snapshotKey),
    materializedRowsPreserved:
      JSON.stringify([...rowsAtManifest(secondFold.finalState).entries()].toSorted()) ===
      JSON.stringify([...rowsAtManifest(reclaimed).entries()].toSorted()),
  };
  expect(reclamation).toEqual({
    beforeFirstFold: 0,
    afterSecondSuccessfulFold: 1,
    storedBeforeReclamation: 2,
    storedAfterReclamation: 1,
    currentObjectPreserved: true,
    materializedRowsPreserved: true,
  });

  const zeroMaxEntriesResult = prepareFold({
    state: stateWithTail(20),
    observedTail: 20,
    probeFloor: 20,
    budget: roomyBudget({ maxEntriesPerRun: 0 }),
    k: 5,
    algorithm: "live-greedy",
  });
  expect(zeroMaxEntriesResult.outcome).toBe("below_min_threshold");
  expect(zeroMaxEntriesResult.foldEnd).toBeNull();

  const staleProbeResult = runSchedule({
    initial: stateWithTail(100, 0),
    observers: [action({ observedTail: 100, k: 20, budget: CF_FREE_BUDGET })],
  });
  expect(staleProbeResult.attempts[0]!.cost.probeGets).toBe(101);
  expect(staleProbeResult.attempts[0]!.cost.total).toBeGreaterThan(CF_FREE_BUDGET.subrequestLimit);

  const crashAfterPutResult = runSchedule({
    initial: stateWithTail(20),
    observers: [action({ observedTail: 20, k: 5, crashAt: "after_snapshot_put" })],
  });
  expect(crashAfterPutResult.attempts[0]!.outcome).toBe("crashed");
  expect(crashAfterPutResult.neverReferencedSnapshots).toHaveLength(1);

  const counterexamples = [
    {
      id: "zero-max-entries-progress",
      observed: true,
      outcome: zeroMaxEntriesResult.outcome,
      foldEnd: zeroMaxEntriesResult.foldEnd,
    },
    {
      id: "stale-probe-budget-overflow",
      observed: true,
      totalCost: staleProbeResult.attempts[0]!.cost.total,
      subrequestLimit: CF_FREE_BUDGET.subrequestLimit,
    },
    {
      id: "mixed-k-cas-orphan",
      observed: true,
      loserOutcome: mixedKRacersResult.attempts[1]!.outcome,
      neverReferencedObjects: mixedKRacersResult.neverReferencedSnapshots.length,
    },
    {
      id: "crash-after-put-orphan",
      observed: true,
      outcome: crashAfterPutResult.attempts[0]!.outcome,
      neverReferencedObjects: crashAfterPutResult.neverReferencedSnapshots.length,
    },
    {
      id: "successful-fold-increases-reclaimable-objects",
      observed: true,
      before: firstFold.reclaimableSnapshots.length,
      after: secondFold.reclaimableSnapshots.length,
    },
  ] as const;

  const command = (propertyPattern: string): string =>
    `FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t '${propertyPattern}'`;
  const claims: readonly EvidenceClaim[] = [
    {
      question: 1,
      classification: "universally-quantified-property",
      conclusion: `At floor 7 and K=5, the manifest target remained ${boundaryTargetDependence[0]!.manifestTarget} while live boundaries changed from ${boundaryTargetDependence[0]!.liveGreedy} to ${boundaryTargetDependence[1]!.liveGreedy} with observation.`,
      propertyIds: [
        "P1a_manifestTargetIsIndependentOfObservationAndBudget",
        "P1b_liveAndObservedAlignedTargetsDependOnObservedAvailability",
      ],
      command: command("P1a_|P1b_"),
    },
    {
      question: 2,
      classification: "bounded-deterministic-observation",
      conclusion: `With only 4 entries, target ${availabilityRetry.target} produced ${availabilityRetry.before.outcome} and no object; at 5 entries the retry prepared the same target.`,
      propertyIds: [
        "P2a_fewerThanNextKEntriesProducesNoObjectOrProgress",
        "P2b_retryAfterAvailabilityUsesTheSameManifestTarget",
      ],
      command: command("P2a_|P2b_"),
    },
    {
      question: 3,
      classification: "bounded-deterministic-observation",
      conclusion: `A crash after snapshot PUT left generation 0 unchanged, and retry published the same floor ${crashRetry.foldEnds[1]} and content-addressed key at generation ${crashRetry.finalGeneration}.`,
      propertyIds: [
        "P3a_crashBeforeCasLeavesManifestUnchangedAndRetryUsesSameTarget",
        "P3b_laggingObserverBoundarySequenceIsAPrefixOfFullyInformedSequence",
      ],
      command: command("P3a_|P3b_"),
    },
    {
      question: 4,
      classification: "unresolved",
      conclusion: `K=4 and K=6 observers from generation 0 prepared floors ${mixedKRacers.foldEnds.join(" and ")}; rolling-deploy K compatibility therefore remains a policy question.`,
      propertyIds: [
        "P4a_firstTargetAfterKChangeIsStrictlyMonotoneAndNewKAligned",
        "P4b_mixedKObserversCanPrepareDifferentObjectsFromOneGeneration",
      ],
      command: command("P4a_|P4b_"),
    },
    {
      question: 5,
      classification: "universally-quantified-property",
      conclusion: `Two generation-0, K=5 racers emitted one key, stored ${sameKRacers.storedObjects} object, and added ${sameKRacers.neverReferencedObjects} distinct CAS orphan.`,
      propertyIds: [
        "P5a_observersOnOppositeSidesOfOneBoundaryEmitAtMostOneObjectForOneK",
        "P5b_sameManifestSameKAlwaysProducesTheSameObjectKey",
      ],
      command: command("P5a_|P5b_"),
    },
    {
      question: 6,
      classification: "explicit-counterexample",
      conclusion: `Mixed-K CAS loss and crash-after-PUT each produced one never-referenced object, while a second successful fold increased reclaimable objects from ${reclamation.beforeFirstFold} to ${reclamation.afterSecondSuccessfulFold}.`,
      propertyIds: [
        "P6a_sameGenerationSameKContentionAddsNoDistinctCasOrphan",
        "P6b_successfulFoldCanIncreaseRatherThanReduceReclaimableObjects",
        "P6c_mixedKContentionHasAReachableDistinctCasOrphan",
        "P6d_crashAfterPutHasAReachableNeverReferencedSnapshot",
        "P6e_reclamationRemovesAllAndOnlyNonCurrentSnapshots",
      ],
      command: command("P6a_|P6b_|P6c_|P6d_|P6e_"),
    },
    {
      question: 7,
      classification: "universally-quantified-property",
      conclusion: `Every deterministic aligned/live row compared equal after the ${SYNTHETIC_LOG_LENGTH}-entry log, including the K=200 aligned remainder at floor 600.`,
      propertyIds: [
        "P7a_everyPreparedManifestBoundaryStrictlyAdvancesAndIsAligned",
        "P7b_everyPreparedReadSetIsTheExactContiguousInterval",
        "P7c_contiguousIncrementalFoldEqualsReferenceReplay",
        "P7d_publishedSnapshotCanPreserveEveryAcknowledgedPrefix",
        "P7e_everyPublishedSnapshotMatchesReferenceReplayThroughItsFloor",
      ],
      command: command("P7a_|P7b_|P7c_|P7d_|P7e_"),
    },
    {
      question: 8,
      classification: "explicit-counterexample",
      conclusion: `Tight-tail prior-snapshot totals ranged from ${tightTailCost[0]!.withSnapshotTotal} to ${tightTailCost.at(-1)!.withSnapshotTotal}; zero max entries made no progress, while stale probing cost ${staleProbeResult.attempts[0]!.cost.total} against the live limit ${CF_FREE_BUDGET.subrequestLimit}.`,
      propertyIds: [
        "P8a_tightKnownTailCostIsNPlusFiveWithSnapshotAndNPlusFourWithout",
        "P8b_deferredAttemptStillPaysSnapshotAndLogReadsButNoPuts",
        "P8c_kAboveMaxEntriesCannotPrepare",
        "P8d_zeroMaxEntriesIsAnExplicitZeroProgressCounterexample",
        "P8e_manifestAlignedProgressFitsCfFreeWithTightKnownTailForKAtMostTwenty",
        "P8f_scheduledStaleProbeCanExceedThePerPassSubrequestLimit",
      ],
      command: command("P8a_|P8b_|P8c_|P8d_|P8e_|P8f_"),
    },
  ];

  const tables = {
    boundaryTargetDependence,
    tightTailCost,
    foldAndObjectProduction,
    sameGenerationSameKRacers: sameKRacers,
    mixedKRacers,
    crashRetry,
    availabilityRetry: {
      target: availabilityRetry.target,
      beforeOutcome: availabilityRetry.before.outcome,
      beforeFoldEnd: availabilityRetry.before.foldEnd,
      afterOutcome: availabilityRetry.after.outcome,
      afterFoldEnd: availabilityRetry.after.foldEnd,
    },
    reclamation,
  };
  const generatedAtUtc = new Date().toISOString();
  const effectiveFcNumRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
  expect(Number.isFinite(effectiveFcNumRuns)).toBe(true);
  const payload: EvidencePayload = {
    status: "research-only / non-authorizing",
    baseSha: BASE_SHA,
    generatedAtUtc,
    deterministicSeed: DETERMINISTIC_SEED,
    effectiveFcNumRuns,
    nodeVersion: process.version,
    liveConstants: {
      WRITE_TICK_FOLD_ENTRIES_PER_PASS,
      WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
      MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
      MAINTENANCE_MAX_FOLD_ROWS,
      MAINTENANCE_PROFILE_CF_FREE_MAX_FOLD_ENTRIES_PER_PASS:
        MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass,
      MAINTENANCE_PROFILE_NODE_MAX_FOLD_ENTRIES_PER_PASS:
        MAINTENANCE_PROFILE_NODE.maxFoldEntriesPerPass,
      CF_FREE_SUBREQUEST_LIMIT: CF_FREE_BUDGET.subrequestLimit,
    },
    modelParameters: {
      kSweep: K_SWEEP,
      syntheticLogLength: SYNTHETIC_LOG_LENGTH,
      alignmentOrigin: "absolute-sequence-zero",
    },
    sourceSha256: await sourceHashes(repoRoot),
    claims,
    counterexamples,
    unresolvedQuestions: [
      "Which K and maintenance-profile policy should be selected for each deployment class?",
      "What K compatibility rule should rolling deployments enforce while old and new observers overlap?",
    ],
    implementationAuthorization:
      "No implementation mechanism is authorized by this research evidence.",
    tables,
  };
  const markdown = renderMarkdown(payload);

  expect(
    declaredPropertyIdsInSource(`
      // test("P1z_lineCommentOnly", () => {});
      /*
      test("P1z_blockCommentOnly", () => {});
      */
      const text = 'test("P1z_stringLiteralOnly", () => {})';
      test("P1a_realDeclaration", () => {});
    `),
  ).toEqual(["P1a_realDeclaration"]);
  const actualPropertyIds = await declaredPropertyIds(repoRoot);
  const canonicalPropertyIds = PROPERTY_CATALOG.flatMap(
    ({ propertyIds: catalogPropertyIds }) => catalogPropertyIds,
  );
  expect(canonicalPropertyIds).toHaveLength(new Set(canonicalPropertyIds).size);
  expect([...actualPropertyIds].toSorted()).toEqual([...canonicalPropertyIds].toSorted());
  expect(payload.claims.map(({ question }) => question)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(
    payload.claims.map(({ question, propertyIds: claimPropertyIds, command: claimCommand }) => ({
      question,
      propertyIds: claimPropertyIds,
      command: claimCommand,
    })),
  ).toEqual(PROPERTY_CATALOG);
  expect(Object.keys(payload.sourceSha256).toSorted()).toEqual([...SOURCE_FILES].toSorted());
  expect(Object.values(payload.sourceSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(
    true,
  );
  expect(payload.counterexamples.map(({ id }) => id)).toEqual([
    "zero-max-entries-progress",
    "stale-probe-budget-overflow",
    "mixed-k-cas-orphan",
    "crash-after-put-orphan",
    "successful-fold-increases-reclaimable-objects",
  ]);
  expect(payload.counterexamples.every(({ observed }) => observed)).toBe(true);

  const firstDirectory = await writeReport(repoRoot, payload, markdown);
  const firstJsonBeforeCollision = await readFile(join(firstDirectory, "report.json"), "utf8");
  const firstMarkdownBeforeCollision = await readFile(join(firstDirectory, "report.md"), "utf8");
  const secondDirectory = await writeReport(repoRoot, payload, markdown);
  const reportBaseDirectory = join(
    resolve(repoRoot, REPORT_ROOT),
    payload.generatedAtUtc.replaceAll(":", "-"),
  );
  const directorySuffix = (directory: string): number =>
    directory === reportBaseDirectory ? 0 : Number(directory.slice(reportBaseDirectory.length + 1));
  expect(secondDirectory).not.toBe(firstDirectory);
  expect(directorySuffix(secondDirectory)).toBeGreaterThan(directorySuffix(firstDirectory));
  await expect(readFile(join(firstDirectory, "report.json"), "utf8")).resolves.toBe(
    firstJsonBeforeCollision,
  );
  await expect(readFile(join(firstDirectory, "report.md"), "utf8")).resolves.toBe(
    firstMarkdownBeforeCollision,
  );

  const parsed = JSON.parse(
    await readFile(join(secondDirectory, "report.json"), "utf8"),
  ) as typeof payload;
  const readBackMarkdown = await readFile(join(secondDirectory, "report.md"), "utf8");
  expect(parsed).toEqual(payload);
  expect(readBackMarkdown).toBe(markdown);
  expect(parsed.status).toBe("research-only / non-authorizing");
  expect(parsed.baseSha).toBe(BASE_SHA);
  expect(parsed.deterministicSeed).toBe(DETERMINISTIC_SEED);
  expect(parsed.modelParameters.kSweep).toEqual(K_SWEEP);
  expect(parsed.modelParameters.alignmentOrigin).toBe("absolute-sequence-zero");
  expect(parsed.sourceSha256).toEqual(await sourceHashes(repoRoot));
  expect(parsed.implementationAuthorization).toBe(
    "No implementation mechanism is authorized by this research evidence.",
  );
  expect(readBackMarkdown).toContain("No implementation mechanism is authorized by this report.");
  expect(readBackMarkdown).toContain(`Base SHA: \`${BASE_SHA}\``);
  expect(readBackMarkdown).toContain("## Deterministic tables");
  expect(readBackMarkdown).toContain("## Counterexamples");
  expect(readBackMarkdown).toContain("## Source SHA-256");
});

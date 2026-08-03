import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  type PreparedFold,
} from "./boundary.ts";
import { foldCost } from "./cost.ts";
import { action, roomyBudget } from "./fixtures.ts";
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
  type ScheduleResult,
} from "./schedule.ts";

/**
 * The commit this report was generated from, resolved at run time.
 *
 * Deliberately NOT a hardcoded literal. A literal is correct only until the
 * branch is rebased, and the round-trip assertion at the bottom of this file
 * compares the emitted value against the same constant — so a stale SHA would
 * still pass and ship a report attributing results to the wrong commit.
 * `sourceSha256` pins the bytes that produced the numbers; this pins the
 * commit those bytes came from.
 *
 * Falls back to `"unknown"` rather than throwing: the report's own integrity
 * does not depend on git being reachable, and a missing SHA is honest whereas
 * a wrong one is not.
 */
const resolveCommitSha = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
};

const DETERMINISTIC_SEED = 20260803 as const;
const K_SWEEP = [8, 16, 20, 32, 64, 200] as const;
const SYNTHETIC_LOG_LENGTH = 640;
const REPORT_ROOT = "bench/results/fold-boundary-model";
const MODEL_DIRECTORY = "tests/model/fold-boundary";
/**
 * Every file whose bytes contributed to the numbers in the emitted report.
 *
 * The report's `sourceSha256` map is built from this list, so an omission here
 * silently narrows provenance rather than failing — a report would then claim to
 * pin the bytes that produced it while excluding some of them. `R6` enforces
 * that this list equals the actual directory contents so adding a model file
 * cannot quietly fall out of provenance coverage.
 */
const SOURCE_FILES = [
  `${MODEL_DIRECTORY}/arbitraries.ts`,
  `${MODEL_DIRECTORY}/boundary.test.ts`,
  `${MODEL_DIRECTORY}/boundary.ts`,
  `${MODEL_DIRECTORY}/cost.ts`,
  `${MODEL_DIRECTORY}/evidence-report.test.ts`,
  `${MODEL_DIRECTORY}/fixtures.ts`,
  `${MODEL_DIRECTORY}/model.test.ts`,
  `${MODEL_DIRECTORY}/model.ts`,
  `${MODEL_DIRECTORY}/orphan-bound.test.ts`,
  `${MODEL_DIRECTORY}/progress-bound.test.ts`,
  `${MODEL_DIRECTORY}/schedule.ts`,
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
  readonly commitSha: string;
  readonly generatedAtUtc: string;
  readonly deterministicSeed: typeof DETERMINISTIC_SEED;
  readonly effectiveFcNumRuns: number;
  readonly nodeVersion: string;
  /** Values imported from `@baerly/protocol`. Every entry is real kernel state. */
  readonly liveConstants: Readonly<Record<string, number>>;
  /**
   * Values the MODEL assumes but the kernel does not export. Kept separate
   * from `liveConstants` so a reader can tell at a glance which numbers are
   * sourced from the implementation and which are the model's own premises.
   */
  readonly modelAssumptions: Readonly<
    Record<string, { readonly value: number; readonly source: string }>
  >;
  readonly modelParameters: {
    readonly kSweep: typeof K_SWEEP;
    readonly syntheticLogLength: number;
    readonly alignmentOrigin: "absolute-sequence-zero";
    /**
     * The budget the deterministic tables were produced under. Published because
     * `foldAndObjectProduction` is only interpretable against it: a
     * `maxEntriesPerRun` below the largest `kSweep` entry would make that arm
     * measure the per-pass cap instead of the boundary rule. See `reportBudget`.
     */
    readonly budget: FoldBudget;
  };
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly claims: readonly EvidenceClaim[];
  readonly counterexamples: readonly EvidenceCounterexample[];
  readonly unresolvedQuestions: readonly string[];
  readonly implementationAuthorization: "No implementation mechanism is authorized by this research evidence.";
  readonly tables: object;
}

/**
 * The report arm's budget: the shared `roomyBudget()` with every ceiling raised.
 *
 * The divergence is load-bearing, not incidental. `K_SWEEP` reaches 200, and
 * `alignedManifestBoundary` refuses a target further than `maxEntriesPerRun` past
 * the floor — so under the shared 100-entry default the K=200 arm of
 * `foldAndObjectProduction` could never prepare, and the published table would be
 * measuring the per-pass cap rather than the boundary rule it claims to compare.
 * The byte and row ceilings are raised for the same reason: this arm folds a
 * {@link SYNTHETIC_LOG_LENGTH}-entry log, not the handful of entries the property
 * scenarios use.
 *
 * Published under `modelParameters.budget` so a reader of the report can see the
 * premise the tables were produced under.
 */
const reportBudget = (overrides: Partial<FoldBudget> = {}): FoldBudget =>
  roomyBudget({
    maxEntriesPerRun: 200,
    ceilingBytes: 10_000_000,
    ceilingEntries: 10_000,
    ...overrides,
  });

/** {@link action}, bound to {@link reportBudget} so every report arm shares one premise. */
const reportAction = (overrides: Partial<ObserverAction> = {}): ObserverAction =>
  action({ budget: reportBudget(), ...overrides });

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

const inputAt = (
  floor: number,
  observedTail: number,
  k: number,
  budget = reportBudget(),
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

/**
 * Tokenize enough JavaScript to tell a real `test("P…")` declaration from a
 * mention of one inside a comment or a string.
 *
 * That discrimination is the whole reason this is a scanner and not a regex: the
 * model files discuss property IDs in prose, and `R2` pins the behavior on a
 * fixture containing exactly those decoys.
 *
 * Template literals carry a `${…}` depth stack, so a template nested inside an
 * interpolation — `` `\`${id}\`` `` in `renderMarkdown` below — no longer flips
 * backtick parity for the rest of the file. Without it this file could not
 * tokenize itself, and `declaredPropertyIds` had to exclude it.
 *
 * Regex literals are not lexed, so a `/…/` containing an unbalanced brace or an
 * unpaired quote would desync the scanner. Unlike the template-parity bug this
 * replaces, nothing in the model does that today, and `R3`'s two-way set equality
 * against `PROPERTY_CATALOG` fails loudly if it ever happens.
 */
const sourceTokens = (source: string): readonly SourceToken[] => {
  const tokens: SourceToken[] = [];
  // One entry per template literal currently open, innermost last. A template is
  // "open" while the scanner is inside one of its `${…}` interpolations.
  const templateDepth: number[] = [];
  let braceDepth = 0;
  let index = 0;

  const scanQuoted = (quote: '"' | "'"): void => {
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
    tokens.push({ kind: "string", value: source.slice(start, index) });
    index += 1;
  };

  // Consumes the literal span of a template up to either its closing backtick or
  // the `${` that opens an interpolation, leaving `index` past whichever it hit.
  const scanTemplateSpan = (): void => {
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === "`") {
        index += 1;
        templateDepth.pop();
        return;
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        index += 2;
        braceDepth += 1;
        return;
      }
      index += 1;
    }
  };

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index + 2);
      if (lineEnd === -1) {
        break;
      }
      index = lineEnd;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (current === "`") {
      index += 1;
      templateDepth.push(braceDepth);
      scanTemplateSpan();
      continue;
    }
    if (current === '"' || current === "'") {
      scanQuoted(current);
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      tokens.push({ kind: "punctuation", value: current });
      index += 1;
      continue;
    }
    if (current === "}") {
      braceDepth -= 1;
      // Closing the brace that opened the innermost template's interpolation
      // returns the scanner to that template's literal text.
      if (templateDepth.at(-1) === braceDepth) {
        index += 1;
        scanTemplateSpan();
        continue;
      }
      tokens.push({ kind: "punctuation", value: current });
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

/**
 * Scrape the real `test("P…")` declarations out of every model test file.
 *
 * Includes this file. It has to: the catalog claims to enumerate every property
 * in the model, so a scrape that skipped a file could not detect a property
 * declared there. `sourceTokens` handles this file's nested templates, which is
 * what makes the self-inclusion possible.
 */
const declaredPropertyIds = async (repoRoot: string): Promise<ReadonlySet<string>> => {
  const propertyTestFiles = SOURCE_FILES.filter((path) => path.endsWith(".test.ts"));
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

- Commit SHA: \`${payload.commitSha}\`
- Generated UTC: \`${payload.generatedAtUtc}\`
- Deterministic scenario seed: \`${payload.deterministicSeed}\`
- Effective FC_NUM_RUNS: \`${payload.effectiveFcNumRuns}\`
- Node: \`${payload.nodeVersion}\`
- Alignment origin: \`${payload.modelParameters.alignmentOrigin}\`
- Synthetic log length: \`${payload.modelParameters.syntheticLogLength}\`
- K sweep: \`${payload.modelParameters.kSweep.join(", ")}\`
- Table budget: \`${JSON.stringify(payload.modelParameters.budget)}\`

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

/**
 * The deterministic scenarios behind every published table.
 *
 * Split out of the report test so each table can be recomputed and asserted on
 * its own, and so a failure names the table that moved instead of pointing at one
 * long body.
 *
 * On why `R1a`–`R1f` assert exact values that the `P`-series also covers: they
 * are not duplicate behavior verification. The `P` properties are universally
 * quantified — `P8a` asserts `total === N + 5` for every `N`, `P1b` asserts that
 * live boundaries track observation. Neither pins the numbers this report
 * *publishes*. Those numbers are interpolated verbatim into the claim prose (Q1
 * cites the floor-7 targets, Q8 cites the tight-tail totals), so if `K_SWEEP` or
 * `SYNTHETIC_LOG_LENGTH` changed, every `P` property would still pass while the
 * emitted evidence silently said something different. `R1a`–`R1f` are golden-value
 * pins on the artifact; the `P` series is the behavior gate.
 */
interface Scenarios {
  readonly boundaryTargetDependence: readonly {
    readonly floor: number;
    readonly observedTail: number;
    readonly k: number;
    readonly liveGreedy: number | null;
    readonly alignedObserved: number | null;
    readonly alignedManifest: number | null;
    readonly manifestTarget: number;
  }[];
  readonly tightTailCost: readonly {
    readonly k: number;
    readonly withSnapshotTotal: number;
    readonly withoutSnapshotTotal: number;
    readonly snapshotDelta: number;
    readonly cfFreeSubrequestLimit: number;
  }[];
  readonly foldAndObjectProduction: readonly {
    readonly k: number;
    readonly alignedWrittenFolds: number;
    readonly alignedObjects: number;
    readonly alignedFinalFloor: number;
    readonly liveWrittenFolds: number;
    readonly liveObjects: number;
    readonly liveFinalFloor: number;
    readonly materializedRowsEqual: boolean;
  }[];
  readonly sameKRacers: ContentionSummary;
  readonly mixedKRacers: ContentionSummary;
  readonly mixedKRacersResult: ScheduleResult;
  readonly crashRetry: {
    readonly outcomes: readonly string[];
    readonly foldEnds: readonly (number | null)[];
    readonly emittedKeys: readonly (string | null)[];
    readonly finalGeneration: number;
  };
  readonly availabilityRetry: {
    readonly target: number;
    readonly before: PreparedFold;
    readonly after: PreparedFold;
  };
  readonly reclamation: {
    readonly beforeFirstFold: number;
    readonly afterSecondSuccessfulFold: number;
    readonly storedBeforeReclamation: number;
    readonly storedAfterReclamation: number;
    readonly currentObjectPreserved: boolean;
    readonly materializedRowsPreserved: boolean;
  };
  readonly zeroMaxEntries: PreparedFold;
  readonly staleProbe: ScheduleResult;
  readonly crashAfterPut: ScheduleResult;
}

interface ContentionSummary {
  readonly outcomes: readonly string[];
  readonly foldEnds: readonly (number | null)[];
  readonly emittedKeys: readonly (string | null)[];
  readonly storedObjects: number;
  readonly neverReferencedObjects: number;
}

const contentionSummary = (result: ScheduleResult): ContentionSummary => ({
  outcomes: result.attempts.map(({ outcome }) => outcome),
  foldEnds: result.attempts.map(({ foldEnd }) => foldEnd),
  emittedKeys: result.attempts.map(({ emittedKey }) => emittedKey),
  storedObjects: result.finalState.snapshots.size,
  neverReferencedObjects: result.neverReferencedSnapshots.length,
});

const sortedRows = (state: ModelState): string =>
  JSON.stringify([...rowsAtManifest(state).entries()].toSorted());

const buildBoundaryTargetDependence = (): Scenarios["boundaryTargetDependence"] =>
  [12, 18].map((observedTail) => {
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

const buildTightTailCost = (): Scenarios["tightTailCost"] =>
  K_SWEEP.map((k) => {
    const withSnapshot = foldCost({
      manifest: { generation: 1, logSeqStart: 8, snapshotKey: "prior", tailHint: 8 + k },
      probeFloor: 8 + k,
      observedTail: 8 + k,
      logEntriesRead: k,
      reachedSnapshotPut: true,
      reachedCurrentCas: true,
    });
    const withoutSnapshot = foldCost({
      manifest: { generation: 0, logSeqStart: 0, snapshotKey: null, tailHint: k },
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

const buildFoldAndObjectProduction = (): Scenarios["foldAndObjectProduction"] => {
  const initial = emptyState({
    ops: syntheticOperations(SYNTHETIC_LOG_LENGTH, DETERMINISTIC_SEED),
    acknowledgedTail: SYNTHETIC_LOG_LENGTH,
  });
  const budget = reportBudget();

  return K_SWEEP.map((k) => {
    const drain = (algorithm: "aligned-manifest" | "live-greedy"): ScheduleResult =>
      drainToQuiescence({
        initial,
        budget,
        k,
        algorithm,
        maxPasses: SYNTHETIC_LOG_LENGTH + 2,
      });
    const aligned = drain("aligned-manifest");
    const live = drain("live-greedy");
    const written = (result: ScheduleResult): number =>
      result.attempts.filter(({ outcome }) => outcome === "written").length;

    return {
      k,
      alignedWrittenFolds: written(aligned),
      alignedObjects: aligned.finalState.snapshots.size,
      alignedFinalFloor: aligned.finalState.manifest.logSeqStart,
      liveWrittenFolds: written(live),
      liveObjects: live.finalState.snapshots.size,
      liveFinalFloor: live.finalState.manifest.logSeqStart,
      materializedRowsEqual: sortedRows(aligned.finalState) === sortedRows(live.finalState),
    };
  });
};

const buildAvailabilityRetry = (): Scenarios["availabilityRetry"] => {
  const unavailable = stateWithTail(4);
  const prepareAt = (state: ModelState, tail: number): PreparedFold =>
    prepareFold({
      state,
      observedTail: tail,
      probeFloor: tail,
      budget: reportBudget(),
      k: 5,
      algorithm: "aligned-manifest",
    });

  return {
    target: alignedManifestTarget(unavailable.manifest.logSeqStart, 5),
    before: prepareAt(unavailable, 4),
    after: prepareAt(stateWithTail(5), 5),
  };
};

const buildReclamation = (): Scenarios["reclamation"] => {
  const firstFold = runSchedule({
    initial: stateWithTail(10),
    observers: [reportAction({ observerId: 1, observedTail: 10, k: 5 })],
  });
  const secondFold = runSchedule({
    initial: firstFold.finalState,
    observers: [reportAction({ observerId: 2, observedTail: 10, k: 5 })],
  });
  const reclaimed = reclaimUnreferenced(secondFold.finalState);

  return {
    beforeFirstFold: firstFold.reclaimableSnapshots.length,
    afterSecondSuccessfulFold: secondFold.reclaimableSnapshots.length,
    storedBeforeReclamation: secondFold.finalState.snapshots.size,
    storedAfterReclamation: reclaimed.snapshots.size,
    currentObjectPreserved:
      reclaimed.manifest.snapshotKey !== null &&
      reclaimed.snapshots.has(reclaimed.manifest.snapshotKey),
    materializedRowsPreserved: sortedRows(secondFold.finalState) === sortedRows(reclaimed),
  };
};

const buildScenarios = (): Scenarios => {
  const mixedKRacersResult = runSchedule({
    initial: stateWithTail(20),
    observers: [
      reportAction({ observerId: 1, readsAtGeneration: 0, observedTail: 20, k: 4 }),
      reportAction({ observerId: 2, readsAtGeneration: 0, observedTail: 20, k: 6 }),
    ],
  });
  const crashRetryResult = runSchedule({
    initial: stateWithTail(20),
    observers: [
      reportAction({ observerId: 1, observedTail: 20, k: 5, crashAt: "after_snapshot_put" }),
      reportAction({ observerId: 2, observedTail: 20, k: 5 }),
    ],
  });

  return {
    boundaryTargetDependence: buildBoundaryTargetDependence(),
    tightTailCost: buildTightTailCost(),
    foldAndObjectProduction: buildFoldAndObjectProduction(),
    sameKRacers: contentionSummary(
      runSchedule({
        initial: stateWithTail(20),
        observers: [
          reportAction({ observerId: 1, readsAtGeneration: 0, observedTail: 5, k: 5 }),
          reportAction({ observerId: 2, readsAtGeneration: 0, observedTail: 9, k: 5 }),
        ],
      }),
    ),
    mixedKRacers: contentionSummary(mixedKRacersResult),
    mixedKRacersResult,
    crashRetry: {
      outcomes: crashRetryResult.attempts.map(({ outcome }) => outcome),
      foldEnds: crashRetryResult.attempts.map(({ foldEnd }) => foldEnd),
      emittedKeys: crashRetryResult.attempts.map(({ emittedKey }) => emittedKey),
      finalGeneration: crashRetryResult.finalState.manifest.generation,
    },
    availabilityRetry: buildAvailabilityRetry(),
    reclamation: buildReclamation(),
    zeroMaxEntries: prepareFold({
      state: stateWithTail(20),
      observedTail: 20,
      probeFloor: 20,
      budget: reportBudget({ maxEntriesPerRun: 0 }),
      k: 5,
      algorithm: "live-greedy",
    }),
    staleProbe: runSchedule({
      initial: stateWithTail(100, 0),
      observers: [reportAction({ observedTail: 100, k: 20, budget: CF_FREE_BUDGET })],
    }),
    crashAfterPut: runSchedule({
      initial: stateWithTail(20),
      observers: [reportAction({ observedTail: 20, k: 5, crashAt: "after_snapshot_put" })],
    }),
  };
};

/**
 * Memoized because `foldAndObjectProduction` drains a
 * {@link SYNTHETIC_LOG_LENGTH}-entry log twice for each of the six `K_SWEEP`
 * values, and several tests below need the same table.
 *
 * Safe to share: `buildScenarios` is a pure function of the module constants and
 * the returned value is deeply readonly, so no test can observe another's
 * ordering through it.
 */
let cachedScenarios: Scenarios | undefined;
const scenarios = (): Scenarios => (cachedScenarios ??= buildScenarios());

const buildTables = (model: Scenarios): object => ({
  boundaryTargetDependence: model.boundaryTargetDependence,
  tightTailCost: model.tightTailCost,
  foldAndObjectProduction: model.foldAndObjectProduction,
  sameGenerationSameKRacers: model.sameKRacers,
  mixedKRacers: model.mixedKRacers,
  crashRetry: model.crashRetry,
  availabilityRetry: {
    target: model.availabilityRetry.target,
    beforeOutcome: model.availabilityRetry.before.outcome,
    beforeFoldEnd: model.availabilityRetry.before.foldEnd,
    afterOutcome: model.availabilityRetry.after.outcome,
    afterFoldEnd: model.availabilityRetry.after.foldEnd,
  },
  reclamation: model.reclamation,
});

const buildCounterexamples = (model: Scenarios): readonly EvidenceCounterexample[] => [
  {
    id: "zero-max-entries-progress",
    observed: true,
    outcome: model.zeroMaxEntries.outcome,
    foldEnd: model.zeroMaxEntries.foldEnd,
  },
  {
    id: "stale-probe-budget-overflow",
    observed: true,
    totalCost: model.staleProbe.attempts[0]!.cost.total,
    subrequestLimit: CF_FREE_BUDGET.subrequestLimit,
  },
  {
    id: "mixed-k-cas-orphan",
    observed: true,
    loserOutcome: model.mixedKRacersResult.attempts[1]!.outcome,
    neverReferencedObjects: model.mixedKRacers.neverReferencedObjects,
  },
  {
    id: "crash-after-put-orphan",
    observed: true,
    outcome: model.crashAfterPut.attempts[0]!.outcome,
    neverReferencedObjects: model.crashAfterPut.neverReferencedSnapshots.length,
  },
  {
    id: "successful-fold-increases-reclaimable-objects",
    observed: true,
    before: model.reclamation.beforeFirstFold,
    after: model.reclamation.afterSecondSuccessfulFold,
  },
];

const command = (propertyPattern: string): string =>
  `FC_NUM_RUNS=10000 pnpm test:agent tests/model/fold-boundary -t '${propertyPattern}'`;

const buildClaims = (model: Scenarios): readonly EvidenceClaim[] => [
  {
    question: 1,
    classification: "universally-quantified-property",
    conclusion: `At floor 7 and K=5, the manifest target remained ${model.boundaryTargetDependence[0]!.manifestTarget} while live boundaries changed from ${model.boundaryTargetDependence[0]!.liveGreedy} to ${model.boundaryTargetDependence[1]!.liveGreedy} with observation.`,
    propertyIds: [
      "P1a_manifestTargetIsIndependentOfObservationAndBudget",
      "P1b_liveAndObservedAlignedTargetsDependOnObservedAvailability",
    ],
    command: command("P1a_|P1b_"),
  },
  {
    question: 2,
    classification: "bounded-deterministic-observation",
    conclusion: `With only 4 entries, target ${model.availabilityRetry.target} produced ${model.availabilityRetry.before.outcome} and no object; at 5 entries the retry prepared the same target.`,
    propertyIds: [
      "P2a_fewerThanNextKEntriesProducesNoObjectOrProgress",
      "P2b_retryAfterAvailabilityUsesTheSameManifestTarget",
    ],
    command: command("P2a_|P2b_"),
  },
  {
    question: 3,
    classification: "bounded-deterministic-observation",
    conclusion: `A crash after snapshot PUT left generation 0 unchanged, and retry published the same floor ${model.crashRetry.foldEnds[1]} and content-addressed key at generation ${model.crashRetry.finalGeneration}.`,
    propertyIds: [
      "P3a_crashBeforeCasLeavesManifestUnchangedAndRetryUsesSameTarget",
      "P3b_laggingObserverBoundarySequenceIsAPrefixOfFullyInformedSequence",
    ],
    command: command("P3a_|P3b_"),
  },
  {
    question: 4,
    classification: "unresolved",
    conclusion: `K=4 and K=6 observers from generation 0 prepared floors ${model.mixedKRacers.foldEnds.join(" and ")}; rolling-deploy K compatibility therefore remains a policy question.`,
    propertyIds: [
      "P4a_firstTargetAfterKChangeIsStrictlyMonotoneAndNewKAligned",
      "P4b_mixedKObserversCanPrepareDifferentObjectsFromOneGeneration",
    ],
    command: command("P4a_|P4b_"),
  },
  {
    question: 5,
    classification: "universally-quantified-property",
    conclusion: `Two generation-0, K=5 racers emitted one key, stored ${model.sameKRacers.storedObjects} object, and added ${model.sameKRacers.neverReferencedObjects} distinct CAS orphan.`,
    propertyIds: [
      "P5a_observersOnOppositeSidesOfOneBoundaryEmitAtMostOneObjectForOneK",
      "P5b_sameManifestSameKAlwaysProducesTheSameObjectKey",
    ],
    command: command("P5a_|P5b_"),
  },
  {
    question: 6,
    classification: "explicit-counterexample",
    conclusion: `Mixed-K CAS loss and crash-after-PUT each produced one never-referenced object, while a second successful fold increased reclaimable objects from ${model.reclamation.beforeFirstFold} to ${model.reclamation.afterSecondSuccessfulFold}.`,
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
    conclusion: `Tight-tail prior-snapshot totals ranged from ${model.tightTailCost[0]!.withSnapshotTotal} to ${model.tightTailCost.at(-1)!.withSnapshotTotal}; zero max entries made no progress, while stale probing cost ${model.staleProbe.attempts[0]!.cost.total} against the live limit ${CF_FREE_BUDGET.subrequestLimit}.`,
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

const buildPayload = async (args: {
  readonly repoRoot: string;
  readonly model: Scenarios;
  readonly generatedAtUtc: string;
}): Promise<EvidencePayload> => ({
  status: "research-only / non-authorizing",
  commitSha: resolveCommitSha(),
  generatedAtUtc: args.generatedAtUtc,
  deterministicSeed: DETERMINISTIC_SEED,
  effectiveFcNumRuns: Number(process.env["FC_NUM_RUNS"] ?? 100),
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
  },
  modelAssumptions: {
    cfFreeSubrequestLimit: {
      value: CF_FREE_BUDGET.subrequestLimit,
      source:
        "Cloudflare Workers Free plan per-request subrequest cap. Platform limit, not a kernel constant — @baerly/protocol does not export it.",
    },
  },
  modelParameters: {
    kSweep: K_SWEEP,
    syntheticLogLength: SYNTHETIC_LOG_LENGTH,
    alignmentOrigin: "absolute-sequence-zero",
    budget: reportBudget(),
  },
  sourceSha256: await sourceHashes(args.repoRoot),
  claims: buildClaims(args.model),
  counterexamples: buildCounterexamples(args.model),
  unresolvedQuestions: [
    "Which K and maintenance-profile policy should be selected for each deployment class?",
    "What K compatibility rule should rolling deployments enforce while old and new observers overlap?",
    "Does the scheduled fold path need a bounded tail probe, and what should a pass do when the bound is hit — defer the fold, or refresh the tail hint and make partial progress? See the stale-probe-budget-overflow counterexample: the O(gap) probe is hole-tolerant by design, so the writer's O(log gap) galloping tail-find is not a drop-in substitute.",
  ],
  implementationAuthorization:
    "No implementation mechanism is authorized by this research evidence.",
  tables: buildTables(args.model),
});

test("R1a_publishedBoundaryTargetDependenceTableIsUnchanged", () => {
  expect(scenarios().boundaryTargetDependence).toEqual([
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
});

test("R1b_publishedTightTailCostTableIsUnchanged", () => {
  const { tightTailCost } = scenarios();

  expect(tightTailCost.map(({ k }) => k)).toEqual([...K_SWEEP]);
  expect(tightTailCost.map(({ withSnapshotTotal }) => withSnapshotTotal)).toEqual([
    13, 21, 25, 37, 69, 205,
  ]);
  expect(tightTailCost.map(({ withoutSnapshotTotal }) => withoutSnapshotTotal)).toEqual([
    12, 20, 24, 36, 68, 204,
  ]);
  expect(tightTailCost.map(({ snapshotDelta }) => snapshotDelta)).toEqual([1, 1, 1, 1, 1, 1]);
});

test("R1c_publishedFoldAndObjectProductionTableIsUnchanged", () => {
  expect(scenarios().foldAndObjectProduction).toEqual([
    {
      k: 8,
      alignedWrittenFolds: 80,
      alignedObjects: 80,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      k: 16,
      alignedWrittenFolds: 40,
      alignedObjects: 40,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      k: 20,
      alignedWrittenFolds: 32,
      alignedObjects: 32,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      k: 32,
      alignedWrittenFolds: 20,
      alignedObjects: 20,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      k: 64,
      alignedWrittenFolds: 10,
      alignedObjects: 10,
      alignedFinalFloor: 640,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
    {
      k: 200,
      alignedWrittenFolds: 3,
      alignedObjects: 3,
      alignedFinalFloor: 600,
      liveWrittenFolds: 4,
      liveObjects: 4,
      liveFinalFloor: 640,
      materializedRowsEqual: true,
    },
  ]);
});

test("R1d_publishedContentionAndCrashTablesAreUnchanged", () => {
  const { sameKRacers, mixedKRacers, crashRetry } = scenarios();

  expect(sameKRacers).toEqual({
    outcomes: ["written", "cas_lost"],
    foldEnds: [5, 5],
    emittedKeys: sameKRacers.emittedKeys,
    storedObjects: 1,
    neverReferencedObjects: 0,
  });
  expect(new Set(sameKRacers.emittedKeys).size).toBe(1);

  expect(mixedKRacers).toEqual({
    outcomes: ["written", "cas_lost"],
    foldEnds: [4, 6],
    emittedKeys: mixedKRacers.emittedKeys,
    storedObjects: 2,
    neverReferencedObjects: 1,
  });
  expect(new Set(mixedKRacers.emittedKeys).size).toBe(2);

  expect(crashRetry).toEqual({
    outcomes: ["crashed", "written"],
    foldEnds: [5, 5],
    emittedKeys: crashRetry.emittedKeys,
    finalGeneration: 1,
  });
  expect(new Set(crashRetry.emittedKeys).size).toBe(1);
});

test("R1e_publishedAvailabilityAndReclamationTablesAreUnchanged", () => {
  const { availabilityRetry, reclamation } = scenarios();

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

  expect(reclamation).toEqual({
    beforeFirstFold: 0,
    afterSecondSuccessfulFold: 1,
    storedBeforeReclamation: 2,
    storedAfterReclamation: 1,
    currentObjectPreserved: true,
    materializedRowsPreserved: true,
  });
});

test("R1f_everyPublishedCounterexampleIsReproducedByItsScenario", () => {
  const model = scenarios();

  expect(model.zeroMaxEntries.outcome).toBe("below_min_threshold");
  expect(model.zeroMaxEntries.foldEnd).toBeNull();
  expect(model.staleProbe.attempts[0]!.cost.total).toBeGreaterThan(CF_FREE_BUDGET.subrequestLimit);
  expect(model.crashAfterPut.attempts[0]!.outcome).toBe("crashed");
  expect(model.crashAfterPut.neverReferencedSnapshots).toHaveLength(1);

  expect(buildCounterexamples(model).map(({ id }) => id)).toEqual([
    "zero-max-entries-progress",
    "stale-probe-budget-overflow",
    "mixed-k-cas-orphan",
    "crash-after-put-orphan",
    "successful-fold-increases-reclaimable-objects",
  ]);
  expect(buildCounterexamples(model).every(({ observed }) => observed)).toBe(true);
});

/**
 * Assembled line-by-line from quoted strings rather than written as one template
 * literal, because the fixture must contain genuinely UNESCAPED nested backticks
 * — an escaped `` \` `` does not reproduce the failure this pins.
 *
 * The nested-template line is the discriminating case. A parity-based scanner (no
 * `${…}` depth stack) misreads the span as ending at the inner opening backtick,
 * resumes in code mode mid-literal, and there meets the apostrophe in `don't` —
 * which it takes as opening a single-quoted string that never closes. Every
 * declaration after that point is then invisible: the scanner returns `[]` for
 * this fixture instead of the one real declaration.
 */
const SCRAPER_FIXTURE = [
  '// test("P1z_lineCommentOnly", () => {});',
  "/*",
  'test("P1z_blockCommentOnly", () => {});',
  "*/",
  "const text = 'test(\"P1z_stringLiteralOnly\", () => {})';",
  'const nested = `a ${xs.map((x) => `don\'t ${x}`).join("")} b`;',
  'test("P1a_realDeclaration", () => {});',
  'describe.skip("P1z_notATestCall", () => {});',
].join("\n");

test("R2_propertyIdScraperSeesOnlyRealDeclarations", () => {
  expect(declaredPropertyIdsInSource(SCRAPER_FIXTURE)).toEqual(["P1a_realDeclaration"]);
});

test("R3_everyDeclaredPropertyIdIsCatalogued", async () => {
  const declared = await declaredPropertyIds(process.cwd());
  const catalogued = PROPERTY_CATALOG.flatMap(({ propertyIds }) => propertyIds);

  expect(catalogued).toHaveLength(new Set(catalogued).size);
  expect([...declared].toSorted()).toEqual([...catalogued].toSorted());
});

test("R4_payloadIsSelfConsistentAndFullyProvenanced", async () => {
  const repoRoot = process.cwd();
  const payload = await buildPayload({
    repoRoot,
    model: scenarios(),
    generatedAtUtc: new Date().toISOString(),
  });

  expect(Number.isFinite(payload.effectiveFcNumRuns)).toBe(true);
  expect(payload.claims.map(({ question }) => question)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(
    payload.claims.map(({ question, propertyIds, command: claimCommand }) => ({
      question,
      propertyIds,
      command: claimCommand,
    })),
  ).toEqual(PROPERTY_CATALOG);
  expect(Object.keys(payload.sourceSha256).toSorted()).toEqual([...SOURCE_FILES].toSorted());
  expect(Object.values(payload.sourceSha256).every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(
    true,
  );
  // Shape check, not a round-trip tautology: assert the resolver produced a real
  // object name (or the honest fallback) before trusting it as provenance.
  expect(payload.commitSha).toMatch(/^([a-f0-9]{40}|unknown)$/);
  expect(payload.modelParameters.budget).toEqual(reportBudget());
});

test("R5_reportWriteIsCollisionSafeAndRoundTrips", async () => {
  const repoRoot = process.cwd();
  const payload = await buildPayload({
    repoRoot,
    model: scenarios(),
    generatedAtUtc: new Date().toISOString(),
  });
  const markdown = renderMarkdown(payload);

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
  ) as EvidencePayload;
  const readBackMarkdown = await readFile(join(secondDirectory, "report.md"), "utf8");

  expect(parsed).toEqual(payload);
  expect(readBackMarkdown).toBe(markdown);
  expect(parsed.status).toBe("research-only / non-authorizing");
  expect(parsed.implementationAuthorization).toBe(
    "No implementation mechanism is authorized by this research evidence.",
  );
  expect(readBackMarkdown).toContain("No implementation mechanism is authorized by this report.");
  expect(readBackMarkdown).toContain(`Commit SHA: \`${payload.commitSha}\``);
  expect(readBackMarkdown).toContain("## Deterministic tables");
  expect(readBackMarkdown).toContain("## Counterexamples");
  expect(readBackMarkdown).toContain("## Source SHA-256");
});

test("R6_sourceHashesCoverEveryModelFile", async () => {
  const entries = await readdir(join(process.cwd(), MODEL_DIRECTORY));
  const onDisk = entries
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${MODEL_DIRECTORY}/${entry}`)
    .toSorted();

  expect(onDisk.length).toBeGreaterThan(0);
  expect([...SOURCE_FILES].toSorted()).toEqual(onDisk);
});

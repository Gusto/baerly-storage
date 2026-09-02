/**
 * Lane B deliverable: per-cell aggregation from raw events.
 *
 * Reduces a directory of per-invocation raw events into per-cell summaries:
 * p50/p95/p99 CPU, outcome histograms (canonical and verbatim), zero-failure
 * bound, hash cost (as a paired difference between the two monolithic arms),
 * and CPU-per-MiB slope — each with its evidence-contract v2 assessment:
 * execution outcome, evidence completeness, and CPU-sample completeness are
 * evaluated as three SEPARATE gates (see
 * `workload-ceiling-harness.ts`'s evidence block).
 *
 * Groups by `scenario_id`: the planned invocations per cell share one scenario
 * id by design, so the repeats ARE the sample.
 * `workload-ceiling-compare.ts` groups the same way and for the same reason —
 * it reduces each (cell, arm) to a p50 before joining the two arms. The two
 * modules agree about cardinality; only what they do after grouping differs.
 *
 * Every number this module reports comes from a tagged algorithm in
 * `statistics.ts` — no statistic is computed inline.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  clopperPearsonZeroFailureUpper,
  madEstimate,
  olsQr,
  quantileEstimate,
  WILSON_Z_BY_CONFIDENCE,
  wilsonOneSidedUpper,
  type DispersionEstimate,
  type OlsQrInput,
  type OlsQrResult,
  type QuantileEstimate,
  type StratifiedPair,
  type WilsonOneSidedUpperResult,
} from "./statistics.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import {
  decodeWorkloadCeilingInvocationRecord,
  WORKLOAD_CEILING_CONTRACT_ID,
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  WORKLOAD_CEILING_IMPLEMENTATIONS,
  WORKLOAD_CEILING_THERMAL_CLASSES,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingImplementation,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingRawEvent,
  decodeWorkloadCeilingSweepReport,
  type WorkloadCeilingSweepCell,
  type WorkloadCeilingSweepReport,
  type WorkloadCeilingThermalClass,
} from "./workload-ceiling-harness.ts";
import {
  assessWorkloadCeilingExecution,
  deploymentKey,
  hasResolvedDeployment,
  isResolvedOk,
  readEventsFromDirectory,
  type ResolvedWorkloadCeilingRawEvent,
  type WorkloadCeilingZeroFailureBound,
} from "./workload-ceiling-compare.ts";

/**
 * Per-cell evidence assessment: the three v2 gates, reported together so a
 * reader sees WHICH gate failed, not just that "the aggregate refused".
 */
export interface WorkloadCeilingCellEvidence {
  /** Planned measured invocations for this cell and arm, from the journal. */
  readonly planned_count: number;
  /** Event files present for those invocations. */
  readonly collected_event_count: number;
  /** Invocations whose authoritative (Workers Observability) record resolved. */
  readonly authoritative_event_count: number;
  /** Authoritative events whose canonical outcome is not `success`. */
  readonly execution_failure_count: number;
  readonly evidence_missing_count: number;
  readonly evidence_ambiguous_count: number;
  /** Successful invocations carrying a finite CPU measurement. */
  readonly finite_cpu_sample_count: number;
  readonly cpu_sample_floor: number;
  /**
   * Every planned invocation has exactly one authoritative event: collected
   * === planned, no missing, no ambiguous. An independent admission gate —
   * never the same fact as the zero-failure bound.
   */
  readonly complete: boolean;
  /** Finite successful CPU samples meet the preregistered floor. */
  readonly cpu_complete: boolean;
}

/**
 * Per-cell summary: CPU quantiles, outcomes, thermal distribution, failure
 * bounds, and the evidence assessment above.
 */
export interface WorkloadCeilingCellSummary {
  readonly scenario_id: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly target_bytes: number;
  readonly achieved_bytes: number;
  readonly row_count: number;
  readonly collected_event_count: number;
  /** Canonical outcome literal → count, over authoritative events. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** Verbatim authoritative outcome literal → count. Provenance, not classification. */
  readonly outcome_verbatim: Readonly<Record<string, number>>;
  readonly thermal: Readonly<Record<WorkloadCeilingThermalClass, number>>;
  /**
   * Null when no successful invocation carried a CPU measurement — an
   * expected state at the cells past the CPU wall.
   */
  readonly cpu_ms: {
    readonly p50: QuantileEstimate;
    readonly p95: QuantileEstimate;
    readonly p99: QuantileEstimate;
    readonly dispersion: DispersionEstimate;
  } | null;
  /**
   * Quantiles over `exceededCpu` samples only. CENSORED observations — the CPU
   * consumed before the runtime killed the invocation, not the cost of a fold
   * that finished. Never pooled with `cpu_ms`.
   */
  readonly exceeded_cpu_ms: { readonly p50: QuantileEstimate } | null;
  /** Per thermal class, when that class has finite-CPU successful samples. */
  readonly cpu_ms_by_thermal: Readonly<
    Partial<Record<WorkloadCeilingThermalClass, QuantileEstimate>>
  >;
  readonly zero_failure_upper_bound: WorkloadCeilingZeroFailureBound;
  /**
   * Wilson one-sided upper bound on the execution-failure rate — defined at
   * any failure count, over authoritative events only.
   */
  readonly failure_upper_bound: WilsonOneSidedUpperResult;
  readonly evidence: WorkloadCeilingCellEvidence;
  /** Per-source CPU counts: provenance rolled up to the cell. */
  readonly cpu_provenance: Readonly<Record<"workers_invocations_adaptive" | "none", number>>;
  readonly script_version: string;
  readonly compatibility_date: string;
}

/**
 * Full axis report: per-cell summaries, hash cost, and CPU-per-MiB slope.
 */
export interface WorkloadCeilingAxisReport {
  readonly contract_id: typeof WORKLOAD_CEILING_CONTRACT_ID;
  readonly evidence_contract_id: typeof WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID;
  readonly sweep_id: string;
  readonly axis: "byte" | "row";
  readonly capture: typeof WORKLOAD_CEILING_STUDY.capture;
  readonly cells: readonly WorkloadCeilingCellSummary[];
  /**
   * One entry per cell that has finite-CPU successful samples in BOTH monolithic arms.
   */
  readonly hash_cost: readonly {
    readonly scenario_id: string;
    readonly difference_ms: StratifiedPair[];
  }[];
  /**
   * `cpu_ms ~ intercept + mib`, fitted across cells with finite-CPU samples.
   * Unavailable — with a stated reason — when fewer than two cells resolved.
   */
  readonly cpu_per_mib: OlsQrResult | { readonly unavailable: string };
}

/**
 * Pure. The per-cell evidence assessment without any refusal — the counts a
 * blocked capture still needs to report. `events` are the collected events
 * for one (cell, arm); `plannedCount` is the journal's non-warmup
 * invocation count for the same (cell, arm).
 */
export function assessWorkloadCeilingCellEvidence(
  events: readonly WorkloadCeilingRawEvent[],
  plannedCount: number,
  cpuSampleFloor: number,
): WorkloadCeilingCellEvidence {
  const execution = assessWorkloadCeilingExecution(events);
  const complete =
    events.length === plannedCount &&
    execution.evidence_missing_count === 0 &&
    execution.evidence_ambiguous_count === 0;
  return {
    planned_count: plannedCount,
    collected_event_count: events.length,
    authoritative_event_count: execution.authoritative_event_count,
    execution_failure_count: execution.execution_failure_count,
    evidence_missing_count: execution.evidence_missing_count,
    evidence_ambiguous_count: execution.evidence_ambiguous_count,
    finite_cpu_sample_count: execution.finite_cpu_sample_count,
    cpu_sample_floor: cpuSampleFloor,
    complete,
    cpu_complete: execution.finite_cpu_sample_count >= cpuSampleFloor,
  };
}

/**
 * An `exceededCpu` invocation the platform still reported a CPU number for —
 * a CENSORED observation, quantiled separately and never pooled with the cost
 * of a fold that finished. A type guard rather than a predicate plus a cast:
 * the cast form let the runtime `cpu_ms !== null` check and the asserted
 * `cpu_ms: number` drift apart silently.
 */
const isCensoredExceededCpu = (
  event: WorkloadCeilingRawEvent,
): event is WorkloadCeilingRawEvent & { readonly cpu_ms: number } =>
  event.outcome === "exceededCpu" && event.cpu_ms !== null;

/**
 * Zip two arrays by index, truncating to the shorter length.
 * Used for pairing hash-cost samples within a cell.
 */
function zipByIndex<T, U>(a: readonly T[], b: readonly U[]): readonly [T, U][] {
  const minLength = Math.min(a.length, b.length);
  const result: [T, U][] = [];
  for (let i = 0; i < minLength; i++) {
    result.push([a[i]!, b[i]!]);
  }
  return result;
}

/**
 * Groups events by scenario_id for a single implementation.
 */
function indexByScenario(
  events: readonly WorkloadCeilingRawEvent[],
): ReadonlyMap<string, readonly WorkloadCeilingRawEvent[]> {
  const byScenario = new Map<string, WorkloadCeilingRawEvent[]>();
  for (const event of events) {
    const existing = byScenario.get(event.scenario_id);
    if (existing) {
      existing.push(event);
    } else {
      byScenario.set(event.scenario_id, [event]);
    }
  }
  return byScenario;
}

/** Non-warmup journal records grouped by (implementation, scenario). */
function plannedCountsByArmAndScenario(
  plannedInvocations: readonly WorkloadCeilingInvocationRecord[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byArm = new Map<string, Map<string, number>>();
  for (const record of plannedInvocations) {
    if (record.warmup) {
      continue;
    }
    let byScenario = byArm.get(record.implementation);
    if (byScenario === undefined) {
      byScenario = new Map();
      byArm.set(record.implementation, byScenario);
    }
    byScenario.set(record.scenario_id, (byScenario.get(record.scenario_id) ?? 0) + 1);
  }
  return byArm;
}

/**
 * Builds a per-cell summary from collected events.
 *
 * Refuses (throws `WorkloadCeilingHarnessError`) on three capture-level
 * violations, in order:
 *
 *  1. `script_version` — resolved events disagree on deployment metadata:
 *     two runtime builds are not one measurement.
 *  2. `evidence_completeness` — a planned invocation is uncollected, or its
 *     authoritative record is missing or ambiguous. No report is produced
 *     over incomplete evidence.
 *  3. `sample_count` — the capture was PLANNED below the preregistered CPU
 *     sample floor (a deliberately short rehearsal run). A capture planned at
 *     or above the floor that lands short on finite CPU samples does NOT
 *     throw: the cell's `evidence.cpu_complete` verdict is false, which
 *     blocks admission and is reported.
 */
function buildCellSummary(input: {
  readonly scenarioId: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly cell: WorkloadCeilingSweepCell;
  readonly events: readonly WorkloadCeilingRawEvent[];
  readonly plannedCount: number;
}): WorkloadCeilingCellSummary {
  const { scenarioId, implementation, cell, events, plannedCount } = input;

  // Thermal distribution over every collected event (warm/cold is a property
  // of the invocation, independent of evidence resolution).
  const thermal: Record<WorkloadCeilingThermalClass, number> = {
    warm: 0,
    cold: 0,
    unknown: 0,
  };
  for (const event of events) {
    thermal[event.thermal_class] = (thermal[event.thermal_class] ?? 0) + 1;
  }

  // Deployment metadata: every event that HAS deployment metadata must agree.
  // Unresolved events are skipped — they carry the sentinel, not a version
  // the platform reported, so including them would report missing evidence as
  // "the Worker was redeployed mid-run".
  const deployedEvents = events.filter(hasResolvedDeployment);
  const firstDeployed = deployedEvents[0];
  if (firstDeployed !== undefined) {
    for (const event of deployedEvents) {
      if (deploymentKey(event) !== deploymentKey(firstDeployed)) {
        throw new WorkloadCeilingHarnessError(
          "script_version",
          `Cell ${scenarioId} has events with mixed deployment metadata`,
        );
      }
    }
  }

  // Evidence assessment (three separate gates).
  const cpuFloor = WORKLOAD_CEILING_STUDY.capture.cpu_sample_floor_per_cell;
  const evidence = assessWorkloadCeilingCellEvidence(events, plannedCount, cpuFloor);
  const execution = assessWorkloadCeilingExecution(events);
  const outcomes = execution.outcome_histogram;
  const verbatimHistogram: Record<string, number> = {};
  for (const event of events) {
    if (event.evidence.status !== "resolved") {
      continue;
    }
    const verbatim = event.evidence.authoritative_outcome!;
    verbatimHistogram[verbatim] = (verbatimHistogram[verbatim] ?? 0) + 1;
  }
  const cpuProvenance: Record<"workers_invocations_adaptive" | "none", number> = {
    workers_invocations_adaptive: 0,
    none: 0,
  };
  for (const event of events) {
    if (event.evidence.cpu_source === "workers-invocations-adaptive") {
      cpuProvenance["workers_invocations_adaptive"] += 1;
    } else {
      cpuProvenance.none += 1;
    }
  }

  if (!evidence.complete) {
    const uncollected = plannedCount - events.length;
    const reasons: string[] = [];
    if (uncollected > 0) {
      reasons.push(`${uncollected} uncollected`);
    }
    if (evidence.evidence_missing_count > 0) {
      reasons.push(`${evidence.evidence_missing_count} missing`);
    }
    if (evidence.evidence_ambiguous_count > 0) {
      reasons.push(`${evidence.evidence_ambiguous_count} ambiguous`);
    }
    if (reasons.length === 0) {
      reasons.push(
        `${events.length} collected events exceed the ${plannedCount} planned invocations`,
      );
    }
    throw new WorkloadCeilingHarnessError(
      "evidence_completeness",
      `Cell ${scenarioId} (${implementation}) has incomplete evidence: ${reasons.join(", ")} ` +
        `of ${plannedCount} planned invocations — every planned invocation must have ` +
        `exactly one authoritative event, and there is no post-hoc remedy`,
    );
  }

  if (plannedCount < cpuFloor) {
    throw new WorkloadCeilingHarnessError(
      "sample_count",
      `Cell ${scenarioId} was planned at ${plannedCount} invocations, below the ` +
        `preregistered CPU sample floor ${cpuFloor}`,
    );
  }

  // Quantile inputs: successful invocations with finite CPU.
  const cpuSamples = events.filter(isResolvedOk) as readonly ResolvedWorkloadCeilingRawEvent[];
  const exceeded = events.filter(isCensoredExceededCpu);

  let cpu_ms: WorkloadCeilingCellSummary["cpu_ms"] = null;
  if (cpuSamples.length > 0) {
    const cpuValues = cpuSamples.map((e) => e.cpu_ms);
    cpu_ms = {
      p50: quantileEstimate(cpuValues, 0.5, "quantile-r7-v1"),
      p95: quantileEstimate(cpuValues, 0.95, "quantile-r7-v1"),
      p99: quantileEstimate(cpuValues, 0.99, "quantile-r7-v1"),
      dispersion: madEstimate(cpuValues),
    };
  }

  // Censored CPU quantiles (exceededCpu samples only)
  let exceeded_cpu_ms: WorkloadCeilingCellSummary["exceeded_cpu_ms"] = null;
  if (exceeded.length > 0) {
    exceeded_cpu_ms = {
      p50: quantileEstimate(
        exceeded.map((e) => e.cpu_ms),
        0.5,
        "quantile-r7-v1",
      ),
    };
  }

  // Per-thermal quantiles
  const cpu_ms_by_thermal: Partial<Record<WorkloadCeilingThermalClass, QuantileEstimate>> = {};
  for (const thermalClass of WORKLOAD_CEILING_THERMAL_CLASSES) {
    const thermalResolved = cpuSamples.filter((e) => e.thermal_class === thermalClass);
    if (thermalResolved.length > 0) {
      cpu_ms_by_thermal[thermalClass] = quantileEstimate(
        thermalResolved.map((e) => e.cpu_ms),
        0.5,
        "quantile-r7-v1",
      );
    }
  }

  // Zero-execution-failure bound over AUTHORITATIVE events only. Evidence
  // missingness is not a failure and not a trial.
  const attempts = Math.max(1, evidence.authoritative_event_count);
  const zero_failure_upper_bound: WorkloadCeilingZeroFailureBound =
    evidence.execution_failure_count === 0
      ? clopperPearsonZeroFailureUpper(attempts, WORKLOAD_CEILING_STUDY.capture.confidence)
      : {
          invalid: "failures-present",
          failure_count: evidence.execution_failure_count,
        };

  const z =
    WILSON_Z_BY_CONFIDENCE[
      WORKLOAD_CEILING_STUDY.capture.confidence as keyof typeof WILSON_Z_BY_CONFIDENCE
    ];
  const failure_upper_bound = wilsonOneSidedUpper(evidence.execution_failure_count, attempts, {
    confidence: WORKLOAD_CEILING_STUDY.capture.confidence,
    z: z!,
  });

  return {
    scenario_id: scenarioId,
    implementation,
    target_bytes: cell.target_bytes,
    achieved_bytes: cell.achieved_bytes,
    row_count: cell.row_count,
    collected_event_count: events.length,
    outcomes,
    outcome_verbatim: verbatimHistogram,
    thermal,
    cpu_ms,
    exceeded_cpu_ms,
    cpu_ms_by_thermal,
    zero_failure_upper_bound,
    failure_upper_bound,
    evidence,
    cpu_provenance: cpuProvenance,
    // Reported from a resolved event when the cell has one: if the cell's
    // first event happened to be unresolved, its `script_version` is the
    // sentinel, not the version that served the cell.
    script_version: (firstDeployed ?? events[0]!).script_version,
    compatibility_date: (firstDeployed ?? events[0]!).compatibility_date,
  };
}

/**
 * Invocation order within one (cell, arm): the telemetry minute the platform
 * attributed the invocation to.
 *
 * Neither of the obvious alternatives is an order. `observed_at` is the
 * COLLECTOR's clock, stamped when the event was written, not when the
 * invocation ran; and `readEventsFromDirectory` returns `readdir` order, which
 * is not temporal at all. The runner spaces invocations 70 s apart and refuses
 * to start in a minute's tail, so within one (cell, arm) each invocation has
 * its own minute and `runtime_period` totally orders them. `run_id` breaks
 * ties only so the result is deterministic.
 */
const byInvocationOrder = (a: WorkloadCeilingRawEvent, b: WorkloadCeilingRawEvent): number =>
  a.runtime_period === b.runtime_period
    ? a.run_id.localeCompare(b.run_id)
    : a.runtime_period.localeCompare(b.runtime_period);

/**
 * Computes hash cost per cell (hashed minus unhashed).
 *
 * Pairs are by repetition ordinal within the cell, not by run_id: the two arms
 * are separate invocations, so there is no natural pair. What makes the
 * pairing meaningful is that the runner interleaves the arms, so the k-th
 * control and the k-th unhashed invocation fall in the same pass.
 *
 * **The ordinal is taken over each arm's FULL ordered event list, and a pair
 * is emitted only when both arms resolved that ordinal.** Filtering to usable
 * samples first and then zipping is the tempting shape and it is wrong: the
 * contract preregisters ~15 % adaptive-row drops, so one arm losing its 3rd
 * invocation would silently shift every later pair to compare invocations from
 * different passes. That corrupts the reported hash cost rather than merely
 * widening it, and nothing downstream could see it. A dropped ordinal is left
 * as a gap in the `pair_id` sequence instead.
 */
function computeHashCost(input: {
  readonly cells: readonly WorkloadCeilingSweepCell[];
  readonly eventsByArm: ReadonlyMap<
    WorkloadCeilingImplementation,
    readonly WorkloadCeilingRawEvent[]
  >;
}): readonly { readonly scenario_id: string; readonly difference_ms: StratifiedPair[] }[] {
  const { cells, eventsByArm } = input;

  const controlEvents = eventsByArm.get("monolithic-control") ?? [];
  const unhashedEvents = eventsByArm.get("monolithic-control-unhashed") ?? [];

  const controlByScenario = indexByScenario(controlEvents);
  const unhashedByScenario = indexByScenario(unhashedEvents);

  const result: { readonly scenario_id: string; readonly difference_ms: StratifiedPair[] }[] = [];

  for (const cell of cells) {
    const controlCellEvents = controlByScenario.get(cell.scenario_id) ?? [];
    const unhashedCellEvents = unhashedByScenario.get(cell.scenario_id) ?? [];

    const ordered = zipByIndex(
      controlCellEvents.toSorted(byInvocationOrder),
      unhashedCellEvents.toSorted(byInvocationOrder),
    );

    const pairs: StratifiedPair[] = [];
    for (const [k, [hashed, unhashed]] of ordered.entries()) {
      if (!isResolvedOk(hashed) || !isResolvedOk(unhashed)) {
        continue;
      }
      pairs.push({
        pair_id: `${cell.scenario_id}#${k}`,
        stratum: cell.scenario_id,
        baseline: unhashed.cpu_ms,
        candidate: hashed.cpu_ms,
      });
    }

    if (pairs.length === 0) {
      continue;
    }

    result.push({ scenario_id: cell.scenario_id, difference_ms: pairs });
  }

  return result;
}

/**
 * Computes CPU-per-MiB slope across cells.
 *
 * Uses monolithic-control summaries only (one per scenario_id) to avoid
 * duplicate MiB values from other implementations.
 */
function computeCpuPerMib(input: {
  readonly cells: readonly WorkloadCeilingCellSummary[];
}): OlsQrResult | { readonly unavailable: string } {
  const { cells } = input;

  // Use monolithic-control summaries only (one per scenario_id)
  const controlCells = cells.filter((c) => c.implementation === "monolithic-control");

  // Only cells with resolved CPU numbers
  const resolvedCells = controlCells.filter((c) => c.cpu_ms !== null);
  if (resolvedCells.length < 2) {
    return {
      unavailable: "fewer than two cells resolved a CPU number",
    };
  }

  const rows = resolvedCells.map((c) => ({
    x: [1, c.achieved_bytes / (1024 * 1024)],
    y: c.cpu_ms!.p50.value,
  }));

  const olsInput: OlsQrInput = {
    columns: ["intercept", "mib"],
    rows,
  };

  try {
    return olsQr(olsInput);
  } catch (error) {
    // The reason matters: a singular design matrix and a non-finite input are
    // different problems with the capture, and the fixed string told a reader
    // neither.
    return {
      unavailable: `OLS fit failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Pure. Reduces every collected event for one axis into per-cell summaries.
 *
 * Groups by `scenario_id`: the planned invocations share one scenario id by
 * design, so the repeats ARE the sample. `workload-ceiling-compare.ts` groups
 * the same way, then reduces each (cell, arm) to a p50 before joining the two
 * arms.
 *
 * `plannedInvocations` is the capture journal (warmup entries included; they
 * are filtered here). The journal is the source of truth for how many
 * invocations were planned per cell/arm — evidence completeness is judged
 * against it, not against whatever happened to collect.
 *
 * @throws WorkloadCeilingHarnessError (see `buildCellSummary`) when a cell's
 *   resolved events disagree on deployment metadata, when a planned
 *   invocation lacks exactly one authoritative event, or when the capture was
 *   planned below the CPU sample floor.
 */
export function buildWorkloadCeilingAxisReport(input: {
  readonly sweepId: string;
  readonly axis: "byte" | "row";
  readonly cells: readonly WorkloadCeilingSweepCell[];
  readonly plannedInvocations: readonly WorkloadCeilingInvocationRecord[];
  readonly eventsByArm: ReadonlyMap<
    WorkloadCeilingImplementation,
    readonly WorkloadCeilingRawEvent[]
  >;
}): WorkloadCeilingAxisReport {
  const { sweepId, axis, cells, plannedInvocations, eventsByArm } = input;

  const plannedByArm = plannedCountsByArmAndScenario(plannedInvocations);
  const allSummaries: WorkloadCeilingCellSummary[] = [];

  // The union of planned and collected arms, not just the collected ones. An
  // arm the journal planned whose event directory never appeared — collect-batch
  // crashed, or the directory ENOENT'd in the CLI — would otherwise never be
  // visited, so its wholly-uncollected cells would never reach the
  // evidence-completeness refusal below. A sweep missing an entire captured arm
  // has to refuse, not produce a clean-looking report over the arms that
  // survived.
  const armsToSummarize = new Set<WorkloadCeilingImplementation>([
    ...plannedByArm.keys(),
    ...eventsByArm.keys(),
  ] as readonly WorkloadCeilingImplementation[]);

  for (const implementation of armsToSummarize) {
    const eventsByScenario = indexByScenario(eventsByArm.get(implementation) ?? []);
    const plannedForArm = plannedByArm.get(implementation);

    for (const cell of cells) {
      const cellEvents = eventsByScenario.get(cell.scenario_id) ?? [];
      const plannedCount = plannedForArm?.get(cell.scenario_id) ?? 0;
      // An arm this sweep neither planned nor collected (e.g.
      // `chunked-candidate` before Milestone 5) has no cell here. An arm that
      // planned or collected anything DOES get a summary — planned-but-
      // uncollected is exactly the evidence incompleteness the report must
      // refuse on, not silently skip.
      if (cellEvents.length === 0 && plannedCount === 0) {
        continue;
      }

      const summary = buildCellSummary({
        scenarioId: cell.scenario_id,
        implementation,
        cell,
        events: cellEvents,
        plannedCount,
      });
      allSummaries.push(summary);
    }
  }

  // Sort by scenario_id
  allSummaries.sort((a, b) => a.scenario_id.localeCompare(b.scenario_id));

  // Compute hash cost and slope (hash cost needs raw events for pairing)
  const hash_cost = computeHashCost({ cells, eventsByArm });
  const cpu_per_mib = computeCpuPerMib({ cells: allSummaries });

  return {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
    sweep_id: sweepId,
    axis,
    capture: WORKLOAD_CEILING_STUDY.capture,
    cells: allSummaries,
    hash_cost,
    cpu_per_mib,
  };
}

/** Loads and decodes the capture journal — the planned-invocation source of truth. */
async function loadJournal(
  resultsDir: string,
  sweepId: string,
): Promise<readonly WorkloadCeilingInvocationRecord[]> {
  const journalPath = `${resultsDir}/journal-${sweepId}.jsonl`;
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    console.error(
      `workload-ceiling-aggregate: cannot read journal ${journalPath} (${code}) — the journal ` +
        `is the planned-invocation count evidence completeness is judged against`,
    );
    throw new Error(`cannot read journal ${journalPath} (${code})`, { cause: error });
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => decodeWorkloadCeilingInvocationRecord(line));
}

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:aggregate`).
 */
async function main(): Promise<number> {
  const sweepId = process.env["WORKLOAD_CEILING_SWEEP_ID"];
  const resultsDir =
    process.env["WORKLOAD_CEILING_RESULTS_DIR"] ?? "bench/results/workload-ceiling";

  if (sweepId === undefined) {
    console.error(
      "workload-ceiling-aggregate: requires WORKLOAD_CEILING_SWEEP_ID — " +
        "the sweep identifier from the capture phase",
    );
    return 1;
  }

  // Load the sweep report through the codec its writer enforces on the same
  // file. `JSON.parse ... as` asserted a shape nothing had checked, so a
  // parseable-but-malformed report fed unvalidated `achieved_bytes` /
  // `target_bytes` / `row_count` straight into the admission gates below —
  // and, sitting outside the try, a truncated file threw an uncaught
  // SyntaxError instead of this clean `return 1`. The errno is reported for
  // the same reason `loadJournal` reports it: EACCES on a real report must
  // not read as "no report".
  const sweepPath = `${resultsDir}/sweep-${sweepId}.json`;
  let sweep: WorkloadCeilingSweepReport;
  try {
    sweep = decodeWorkloadCeilingSweepReport(await readFile(sweepPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      `workload-ceiling-aggregate: cannot read sweep report ${sweepPath}` +
        `${code === undefined ? "" : ` (${code})`}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (sweep.sweep_id !== sweepId) {
    console.error(
      `workload-ceiling-aggregate: sweep report sweep_id ${sweep.sweep_id} ` +
        `does not match requested ${sweepId}`,
    );
    return 1;
  }

  // Load the journal — the planned count every completeness verdict reads.
  const journal = await loadJournal(resultsDir, sweepId);

  // Read events for each arm
  const eventsByArm = new Map<WorkloadCeilingImplementation, readonly WorkloadCeilingRawEvent[]>();
  for (const impl of WORKLOAD_CEILING_IMPLEMENTATIONS) {
    const armDir = `${resultsDir}/${sweepId}/${impl}`;
    // An arm this sweep never captured (e.g. `chunked-candidate` before
    // Milestone 5) has no directory at all. Absence is expected and simply
    // leaves the arm out of eventsByArm — per-cell aggregation already
    // omits a cell's hash cost when an arm is missing.
    //
    // ONLY absence. Collapsing every stat rejection to "not there" would make
    // an unreadable directory — a permission error on a real arm's captured
    // events — look like an arm the sweep never ran, and drop it from the
    // report with no diagnostic.
    const armDirStatus = await stat(armDir).then(
      () => "present" as const,
      (error: NodeJS.ErrnoException) => error.code ?? "unknown",
    );
    if (armDirStatus === "ENOENT") {
      continue;
    }
    if (armDirStatus !== "present") {
      console.error(
        `workload-ceiling-aggregate: cannot stat arm directory ${armDir} (${armDirStatus})`,
      );
      return 1;
    }
    const events = await readEventsFromDirectory(armDir);
    eventsByArm.set(impl, events);
  }

  // Build report
  let report: WorkloadCeilingAxisReport;
  try {
    report = buildWorkloadCeilingAxisReport({
      sweepId,
      axis: "byte", // TODO: derive from sweep config
      cells: sweep.cells,
      plannedInvocations: journal,
      eventsByArm,
    });
  } catch (error) {
    if (error instanceof WorkloadCeilingHarnessError) {
      console.error(`workload-ceiling-aggregate: refused (${error.field}) — ${error.message}`);
      return 1;
    }
    throw error;
  }

  // Print per-cell table
  console.log(`Axis: ${report.axis}, cells: ${report.cells.length}`);
  console.log("");
  for (const cell of report.cells) {
    console.log(`  ${cell.scenario_id} [${cell.implementation}]:`);
    console.log(`    target: ${cell.target_bytes}B, achieved: ${cell.achieved_bytes}B`);
    console.log(
      `    planned: ${cell.evidence.planned_count}, authoritative: ${cell.evidence.authoritative_event_count}, ` +
        `cpu samples: ${cell.evidence.finite_cpu_sample_count} (floor ${cell.evidence.cpu_sample_floor}), ` +
        `execution failures: ${cell.evidence.execution_failure_count}`,
    );
    console.log(
      `    outcomes: ${JSON.stringify(cell.outcomes)} (verbatim: ${JSON.stringify(cell.outcome_verbatim)})`,
    );
    console.log(
      `    evidence complete: ${cell.evidence.complete}, cpu complete: ${cell.evidence.cpu_complete}`,
    );
    if (cell.cpu_ms) {
      console.log(
        `    cpu_ms p50/p95/p99: ${cell.cpu_ms.p50.value.toFixed(2)}/` +
          `${cell.cpu_ms.p95.value.toFixed(2)}/${cell.cpu_ms.p99.value.toFixed(2)}`,
      );
    } else {
      console.log("    cpu_ms: null (no finite-CPU successful samples)");
    }
    if (cell.exceeded_cpu_ms) {
      console.log(
        `    exceeded_cpu_ms p50: ${cell.exceeded_cpu_ms.p50.value.toFixed(2)} (censored)`,
      );
    }
    if ("invalid" in cell.zero_failure_upper_bound) {
      console.log(
        `    zero-failure bound: invalid (${cell.zero_failure_upper_bound.failure_count} execution failures)`,
      );
    } else {
      console.log(
        `    zero-failure bound: ${cell.zero_failure_upper_bound.upper.toFixed(4)} ` +
          `at ${cell.zero_failure_upper_bound.confidence} confidence`,
      );
    }
  }

  // Write report
  const outDir = `${resultsDir}/${sweepId}`;
  await mkdir(outDir, { recursive: true });
  const outPath = `${outDir}/axis-report.json`;
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(``);
  console.log(`wrote ${outPath}`);

  const cpuIncomplete = report.cells.filter((c) => !c.evidence.cpu_complete);
  if (cpuIncomplete.length > 0) {
    console.error("");
    console.error(
      `workload-ceiling-aggregate: refused (cpu_sample_floor) — ` +
        `${cpuIncomplete.length} cell(s) fell short of finite successful CPU samples: ` +
        cpuIncomplete.map((c) => `${c.scenario_id}[${c.implementation}]`).join(", "),
    );
    console.error(
      `The report is written for diagnosis, but admission is blocked. There is no ` +
        `top-up: additional attempts are planned before capture, never added after ` +
        `observing missingness.`,
    );
    return 1;
  }
  return 0;
}

await runAsCliEntrypoint(import.meta.url, main);

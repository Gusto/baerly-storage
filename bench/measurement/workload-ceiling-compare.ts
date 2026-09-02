/**
 * Matched comparison for the deployed workload-ceiling study (parent plan
 * Task 8 Step 7).
 *
 * **The paired unit is a CELL, not an invocation.** The capture runner emits
 * `WORKLOAD_CEILING_STUDY.capture.planned_measured_invocations_per_cell`
 * invocations per cell per arm, all carrying that cell's single
 * `scenario_id` (`workload-ceiling-cells.ts` mints one id per cell and
 * deliberately does not encode the arm). So each side of a scenario arrives
 * as a SAMPLE, and this module reduces it to one cell statistic — the r7 p50
 * over that side's finite-CPU successful invocations, plus its MAD — before
 * joining. Pairing raw invocations would be both unmatched (nothing links
 * the k-th control invocation to the k-th candidate one) and, at n = 40 per
 * side, statistically indefensible.
 *
 * Joins `monolithic-control` and `chunked-candidate` cell statistics
 * (`workload-ceiling-harness.ts` events, produced by
 * `workload-ceiling-collect.ts`) by `scenario_id` PLUS deployment metadata —
 * `compatibility_date` and `script_version` must agree, because this study's
 * Worker (`bench/workload-ceiling-worker/src/index.ts`) serves both
 * implementations from the SAME deployed script, branching on the request's
 * `implementation` field. Deployment agreement is now checked in two places,
 * because a sample has an inside: WITHIN a side, whose events must all name
 * one deployment, and ACROSS the two sides. Events measured on different
 * runtime builds are NOT a valid pair.
 *
 * Every number this module reports comes from a tagged algorithm in
 * `statistics.ts` — p50/p95/p99 via `quantileEstimate`, per-cell dispersion
 * via `madEstimate`, the paired candidate/control ratio via
 * `pairedRatioBootstrap`, and the zero-failure
 * upper bound on unresolved/failed invocations via
 * `clopperPearsonZeroFailureUpper` — computed per side ONLY over sides that
 * observed zero unresolved invocations; a side with any failure is marked
 * `{ invalid: "failures-present", failure_count }` instead, because the
 * zero-failure formula has no honest extension to F > 0 (see
 * {@link WorkloadCeilingZeroFailureBoundInvalid}). An incomplete pair (missing a side,
 * mismatched deployment metadata, or either side yielding no usable `ok`
 * measurement) is rejected from the paired statistics rather than
 * silently imputed, and is reported separately.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  clopperPearsonZeroFailureUpper,
  madEstimate,
  pairedRatioBootstrap,
  quantileEstimate,
  type BootstrapResult,
  type ClopperPearsonZeroFailureResult,
  type DispersionEstimate,
  type PairedValue,
  type QuantileEstimate,
} from "./statistics.ts";
import {
  decodeWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_SUCCESS_OUTCOME,
  WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";

export function deploymentKey(event: WorkloadCeilingRawEvent): string {
  return `${event.compatibility_date}|${event.script_version}`;
}

/**
 * True when the event carries no deployment metadata to agree or disagree
 * about — the authoritative record never resolved, so `script_version` is
 * the sentinel rather than a version the platform reported.
 *
 * Callers comparing `deploymentKey` across a cell MUST skip these. An
 * unresolved event is an evidence-completeness fact, not evidence that two
 * runtime builds served one capture, and conflating the two turns a couple
 * of missing telemetry records into a spurious "the Worker was redeployed
 * mid-run" verdict.
 */
export const hasResolvedDeployment = (event: WorkloadCeilingRawEvent): boolean =>
  event.script_version !== WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION;

/**
 * The single definition of "this invocation resolved to a usable
 * MEASUREMENT": the authoritative platform record resolved AND classified
 * the invocation as a success AND the CPU source supplied a finite number.
 *
 * Each half is load-bearing:
 *
 *  - a `null` outcome (evidence missing or ambiguous) is not a sample of
 *    anything — the invocation's execution result was never established;
 *  - a non-success outcome can still carry a partial CPU number — the
 *    platform reports one for `exceededCpu`, and `workload-ceiling-harness.ts`
 *    preserves that shape deliberately. Pooling it would understate the cost
 *    of an invocation that never finished;
 *  - a success whose adaptive CPU row never landed (the rehearsal's
 *    missingness shape) is a real success and NOT an execution failure, but
 *    it contributes no quantile sample.
 *
 * Both the pairing logic and the execution assessment below read predicates
 * from this module so those three concepts never drift apart again.
 */
export const isResolvedOk = (
  event: WorkloadCeilingRawEvent,
): event is ResolvedWorkloadCeilingRawEvent =>
  event.outcome === WORKLOAD_CEILING_SUCCESS_OUTCOME &&
  event.cpu_ms !== null &&
  Number.isFinite(event.cpu_ms);

/** A WorkloadCeilingRawEvent whose collection resolved to exactly one single-request invocation with a finite CPU measurement. */
export type ResolvedWorkloadCeilingRawEvent = Omit<WorkloadCeilingRawEvent, "cpu_ms"> & {
  readonly cpu_ms: number;
};

/**
 * The three-way execution/evidence assessment every consumer of collected
 * events shares. Computed over a list of events (one per collected
 * invocation):
 *
 *  - `authoritative_event_count` — invocations whose Workers Observability
 *    record resolved. This is the denominator of the zero-execution-failure
 *    bound: only an invocation whose outcome the platform actually reported
 *    is a Bernoulli trial.
 *  - `execution_failure_count` — authoritative events whose canonical
 *    outcome is not `"success"`. A missing CPU row, a missing authoritative
 *    record, or an ambiguous one never lands here — those are evidence and
 *    CPU-completeness facts, gated separately.
 *  - `evidence_missing_count` / `evidence_ambiguous_count` — authoritative
 *    records that never arrived or did not resolve to exactly one
 *    correlatable event.
 *  - `finite_cpu_sample_count` — successful invocations carrying a finite
 *    CPU measurement (the quantile sample pool).
 *  - `outcome_histogram` — canonical outcomes over authoritative events.
 */
export interface WorkloadCeilingExecutionAssessment {
  readonly authoritative_event_count: number;
  readonly execution_failure_count: number;
  readonly evidence_missing_count: number;
  readonly evidence_ambiguous_count: number;
  readonly finite_cpu_sample_count: number;
  readonly outcome_histogram: Readonly<Record<string, number>>;
}

/** Pure. The shared three-way assessment described above. */
export function assessWorkloadCeilingExecution(
  events: readonly WorkloadCeilingRawEvent[],
): WorkloadCeilingExecutionAssessment {
  const histogram: Record<string, number> = {};
  let authoritative = 0;
  let failures = 0;
  let missing = 0;
  let ambiguous = 0;
  let finiteCpu = 0;
  for (const event of events) {
    switch (event.evidence.status) {
      case "missing": {
        missing += 1;
        continue;
      }
      case "ambiguous": {
        ambiguous += 1;
        continue;
      }
      case "resolved": {
        break;
      }
      default: {
        // A fourth evidence status must be classified here deliberately.
        // Reaching the authoritative path by fall-through would count an
        // unclassified record as a Bernoulli trial and assert a histogram
        // entry over a genuine `null` outcome — inflating the denominator of
        // the zero-failure bound with an invocation whose result nobody
        // established.
        const unclassified: never = event.evidence.status;
        throw new WorkloadCeilingHarnessError(
          "evidence.status",
          `unclassified evidence status ${JSON.stringify(unclassified)}`,
        );
      }
    }
    // `resolved` implies a non-null outcome in the codec
    // (`workload-ceiling-harness.ts`), but the flat event type does not say
    // so, and this function also runs over hand-built events. Assert the
    // invariant rather than silencing it with `!`.
    const outcome = event.outcome;
    if (outcome === null) {
      throw new WorkloadCeilingHarnessError(
        "outcome",
        'must be a platform outcome when evidence.status is "resolved"',
      );
    }
    authoritative += 1;
    histogram[outcome] = (histogram[outcome] ?? 0) + 1;
    if (outcome !== WORKLOAD_CEILING_SUCCESS_OUTCOME) {
      failures += 1;
      continue;
    }
    // The one definition of "usable measurement", not a second copy of it:
    // `finite_cpu_sample_count` has to stay equal to
    // `events.filter(isResolvedOk).length`, which is what this module's
    // docstring promises the pairing path and this assessment share.
    if (isResolvedOk(event)) {
      finiteCpu += 1;
    }
  }
  return {
    authoritative_event_count: authoritative,
    execution_failure_count: failures,
    evidence_missing_count: missing,
    evidence_ambiguous_count: ambiguous,
    finite_cpu_sample_count: finiteCpu,
    outcome_histogram: histogram,
  };
}

/**
 * One side of one cell, reduced to the statistics a matched comparison joins
 * on. `p50` is the paired value; `dispersion` travels with it so a reader can
 * see whether the two sides' medians are separated by more than their own
 * spread.
 *
 * `sample_count` is reported rather than gated: the preregistered
 * `cpu_sample_floor_per_cell` is owned by `workload-ceiling-aggregate.ts`,
 * and a second copy of that gate here would be a second thing to keep in
 * sync. What this module guarantees is only that the count is nonzero and
 * visible in the persisted report.
 */
export interface WorkloadCeilingCellStatistic {
  readonly scenario_id: string;
  /** Invocations collected for this (cell, side), before any gate. */
  readonly collected_event_count: number;
  /** Finite-CPU successful invocations — the pool `p50` and `dispersion` summarize. */
  readonly sample_count: number;
  /**
   * That pool, in collection order. Persisted because it is what every number
   * on this side rests on, and because the pooled report quantiles are taken
   * over these rather than over the per-cell p50s — a p99 across four cell
   * medians is just the largest of four numbers.
   */
  readonly cpu_ms_samples: readonly number[];
  readonly p50: QuantileEstimate;
  readonly dispersion: DispersionEstimate;
  /** The one deployment every event on this side that resolved a version named. */
  readonly deployment_key: string;
}

export interface WorkloadCeilingComparisonPair {
  readonly scenario_id: string;
  readonly control: WorkloadCeilingCellStatistic;
  readonly candidate: WorkloadCeilingCellStatistic;
}

export interface WorkloadCeilingIncompletePair {
  readonly scenario_id: string;
  /**
   * `mixed-deployment-within-side` is the redeploy-mid-capture case: one
   * side's own events name two runtime builds, so the side has no single
   * deployment to compare against the other. `unresolved-cpu` is now a
   * property of the SIDE, not of one event — it means the side produced zero
   * finite-CPU successful invocations, so there is nothing to take a p50 of.
   */
  readonly reason:
    | "missing-control"
    | "missing-candidate"
    | "mixed-deployment-within-side"
    | "deployment-metadata-mismatch"
    | "unresolved-cpu";
}

export interface WorkloadCeilingMatchedComparison {
  readonly pairs: readonly WorkloadCeilingComparisonPair[];
  readonly incomplete: readonly WorkloadCeilingIncompletePair[];
}

/** Groups a side's events by `scenario_id`, preserving collection order within a cell. */
function groupByScenario(
  events: readonly WorkloadCeilingRawEvent[],
): Map<string, WorkloadCeilingRawEvent[]> {
  const byScenario = new Map<string, WorkloadCeilingRawEvent[]>();
  for (const event of events) {
    const bucket = byScenario.get(event.scenario_id);
    if (bucket === undefined) {
      byScenario.set(event.scenario_id, [event]);
      continue;
    }
    bucket.push(event);
  }
  return byScenario;
}

/**
 * The distinct deployments a side's events name. Events whose evidence never
 * resolved carry the `unresolved` sentinel rather than a version, so they are
 * skipped — see {@link hasResolvedDeployment}.
 */
const deploymentsNamedBy = (events: readonly WorkloadCeilingRawEvent[]): Set<string> =>
  new Set(events.filter(hasResolvedDeployment).map(deploymentKey));

/**
 * Pure. Reduces one side of one cell to its statistic, or returns the
 * rejection reason literal explaining why it has none.
 */
function summarizeCellSide(
  scenarioId: string,
  events: readonly WorkloadCeilingRawEvent[],
): WorkloadCeilingCellStatistic | "mixed-deployment-within-side" | "unresolved-cpu" {
  const deployments = deploymentsNamedBy(events);
  if (deployments.size > 1) {
    return "mixed-deployment-within-side";
  }
  const samples = events.filter(isResolvedOk).map((event) => event.cpu_ms);
  if (samples.length === 0 || deployments.size === 0) {
    return "unresolved-cpu";
  }
  return {
    scenario_id: scenarioId,
    collected_event_count: events.length,
    sample_count: samples.length,
    cpu_ms_samples: samples,
    p50: quantileEstimate(samples, 0.5, "quantile-r7-v1"),
    dispersion: madEstimate(samples),
    deployment_key: [...deployments][0]!,
  };
}

/**
 * Pure. Groups each side's events by `scenario_id`, reduces each (cell, side)
 * to a {@link WorkloadCeilingCellStatistic}, and joins the two sides by
 * scenario and deployment. Every rejection is reported by name — this
 * function never drops a scenario silently.
 *
 * Gate order per scenario: both sides present → each side names one
 * deployment → each side has at least one CPU sample → the two sides name the
 * SAME deployment.
 */
export function matchWorkloadCeilingEvents(
  controlEvents: readonly WorkloadCeilingRawEvent[],
  candidateEvents: readonly WorkloadCeilingRawEvent[],
): WorkloadCeilingMatchedComparison {
  const incomplete: WorkloadCeilingIncompletePair[] = [];
  const controlByScenario = groupByScenario(controlEvents);
  const candidateByScenario = groupByScenario(candidateEvents);

  const scenarioIds = new Set([...controlByScenario.keys(), ...candidateByScenario.keys()]);
  const pairs: WorkloadCeilingComparisonPair[] = [];
  for (const scenarioId of [...scenarioIds].toSorted()) {
    const controlSide = controlByScenario.get(scenarioId);
    const candidateSide = candidateByScenario.get(scenarioId);
    if (controlSide === undefined) {
      incomplete.push({ scenario_id: scenarioId, reason: "missing-control" });
      continue;
    }
    if (candidateSide === undefined) {
      incomplete.push({ scenario_id: scenarioId, reason: "missing-candidate" });
      continue;
    }
    const control = summarizeCellSide(scenarioId, controlSide);
    const candidate = summarizeCellSide(scenarioId, candidateSide);
    if (typeof control === "string" || typeof candidate === "string") {
      // A side that named two deployments is reported as such even when the
      // other side merely lacks samples: a redeploy mid-capture is the more
      // actionable fact, and it explains the missing samples often enough.
      const reason =
        control === "mixed-deployment-within-side" || candidate === "mixed-deployment-within-side"
          ? "mixed-deployment-within-side"
          : "unresolved-cpu";
      incomplete.push({ scenario_id: scenarioId, reason });
      continue;
    }
    if (control.deployment_key !== candidate.deployment_key) {
      incomplete.push({ scenario_id: scenarioId, reason: "deployment-metadata-mismatch" });
      continue;
    }
    pairs.push({ scenario_id: scenarioId, control, candidate });
  }
  return {
    pairs,
    incomplete: incomplete.toSorted((a, b) => a.scenario_id.localeCompare(b.scenario_id)),
  };
}

/**
 * A side of the comparison whose authoritative events include at least one
 * invocation the platform classified as a non-success outcome (e.g.
 * `exceededCpu` — which can still carry a partial CPU number; see
 * {@link isResolvedOk}). The zero-failure Clopper-Pearson formula
 * (`1 − c^(1/n)`) is valid only at zero observed failures: `n` counts
 * successes, so plugging any success-count-derived denominator in at F > 0
 * is anti-conservative (more failures would TIGHTEN the bound — the opposite
 * of the intended failure-budget reading), and the general F > 0 bound needs
 * a Beta inverse (bisection over the Binomial CDF), deliberately out of scope
 * for a bench tool. Reported by name — never dropped silently, and never
 * filled in with a number the formula cannot honestly produce.
 *
 * Evidence missingness does NOT land here (see
 * {@link assessWorkloadCeilingExecution}): a missing authoritative record is
 * not an execution failure. It blocks evidence completeness instead.
 */
export interface WorkloadCeilingZeroFailureBoundInvalid {
  readonly invalid: "failures-present";
  readonly failure_count: number;
}

/** Per side: a valid zero-failure bound, or the explicit invalidity marker above. */
export type WorkloadCeilingZeroFailureBound =
  | ClopperPearsonZeroFailureResult
  | WorkloadCeilingZeroFailureBoundInvalid;

export interface WorkloadCeilingComparisonReport {
  /** Paired CELLS, not paired invocations — see the module header. */
  readonly pair_count: number;
  readonly incomplete_count: number;
  readonly incomplete: readonly WorkloadCeilingIncompletePair[];
  /**
   * The per-cell statistics the ratio below is computed from, persisted so a
   * reader can see which cells carried the comparison and on how many samples
   * each side rests.
   */
  readonly pairs: readonly WorkloadCeilingComparisonPair[];
  /**
   * Quantiles over the POOLED finite-CPU samples of every paired cell on this
   * side — a mixture across cells of different sizes, deliberately: it is the
   * "how expensive does an invocation get anywhere in the matrix"
   * distribution the budget line is read against. The per-cell view is
   * `pairs`; nothing here is a per-cell estimate.
   *
   * Samples from a cell that failed to pair are excluded, because the whole
   * report describes the matched comparison — an unmatched cell must not move
   * a number the matched sides are compared on. Those invocations still count
   * against `zero_failure_upper_bound`, which is assessed over every attempt.
   */
  readonly control_cpu_ms: {
    readonly p50: QuantileEstimate;
    readonly p95: QuantileEstimate;
    readonly p99: QuantileEstimate;
  };
  readonly candidate_cpu_ms: {
    readonly p50: QuantileEstimate;
    readonly p95: QuantileEstimate;
    readonly p99: QuantileEstimate;
  };
  readonly paired_candidate_over_control_ratio: BootstrapResult<"paired-ratio-bootstrap-v1">;
  /**
   * Over ALL collected events on each side, including incomplete/unresolved
   * ones — but split per evidence-contract v2: the bound is computed over
   * AUTHORITATIVE events only (invocations whose execution outcome the
   * platform actually reported), and it is invalidated by real execution
   * failures, never by evidence missingness. Valid ONLY for a side with zero
   * execution failures: a side with ≥ 1 carries
   * `{ invalid: "failures-present", failure_count }` instead of a bound.
   */
  readonly zero_failure_upper_bound: {
    readonly control: WorkloadCeilingZeroFailureBound;
    readonly candidate: WorkloadCeilingZeroFailureBound;
  };
}

const quantiles = (values: readonly number[]) => ({
  p50: quantileEstimate(values, 0.5, "quantile-r7-v1"),
  p95: quantileEstimate(values, 0.95, "quantile-r7-v1"),
  p99: quantileEstimate(values, 0.99, "quantile-r7-v1"),
});

/**
 * Per-side execution assessment. F = 0 → the exact one-sided zero-failure
 * bound over the AUTHORITATIVE event count (clamped to ≥ 1 so an empty event
 * list still yields the maximally-wide n = 1 bound rather than throwing;
 * evidence-missing events contribute neither a trial nor a success); F > 0 →
 * the explicit invalidity marker, never an anti-conservative number.
 */
const zeroFailureUpperBound = (
  events: readonly WorkloadCeilingRawEvent[],
  confidence: number,
): WorkloadCeilingZeroFailureBound => {
  const assessment = assessWorkloadCeilingExecution(events);
  if (assessment.execution_failure_count > 0) {
    return { invalid: "failures-present", failure_count: assessment.execution_failure_count };
  }
  return clopperPearsonZeroFailureUpper(
    Math.max(1, assessment.authoritative_event_count),
    confidence,
  );
};

/**
 * Pure. Builds the full comparison report from a matched set plus the two
 * complete (pre-matching) event lists — the failure budget is deliberately
 * assessed over every collected attempt, not just the pairs that survived
 * matching, so a run that failed to resolve on one side still counts
 * against that side: it surfaces there as an explicit failures-present
 * marker, since the zero-failure bound itself is only computed at F = 0.
 *
 * The bootstrap resamples CELLS. `inclusion_unit` says so, and it is the
 * honest unit: the two arms are independent samples within a cell, so the
 * per-cell p50 ratio is the only quantity that is actually paired.
 */
export function buildWorkloadCeilingComparisonReport(input: {
  readonly matched: WorkloadCeilingMatchedComparison;
  readonly controlEvents: readonly WorkloadCeilingRawEvent[];
  readonly candidateEvents: readonly WorkloadCeilingRawEvent[];
  readonly confidence: number;
  readonly seed: number;
  readonly resamples: number;
}): WorkloadCeilingComparisonReport {
  const { matched } = input;
  if (matched.pairs.length === 0) {
    throw new WorkloadCeilingHarnessError("pairs", "no complete pairs to compare");
  }
  const pairedValues: PairedValue[] = matched.pairs.map((pair) => ({
    pair_id: pair.scenario_id,
    baseline: pair.control.p50.value,
    candidate: pair.candidate.p50.value,
  }));

  return {
    pair_count: matched.pairs.length,
    incomplete_count: matched.incomplete.length,
    incomplete: matched.incomplete,
    pairs: matched.pairs,
    control_cpu_ms: quantiles(matched.pairs.flatMap((pair) => pair.control.cpu_ms_samples)),
    candidate_cpu_ms: quantiles(matched.pairs.flatMap((pair) => pair.candidate.cpu_ms_samples)),
    paired_candidate_over_control_ratio: pairedRatioBootstrap(pairedValues, {
      seed: input.seed,
      resamples: input.resamples,
      confidence: input.confidence,
      inclusion_unit: "complete-pair-cell",
    }),
    zero_failure_upper_bound: {
      control: zeroFailureUpperBound(input.controlEvents, input.confidence),
      candidate: zeroFailureUpperBound(input.candidateEvents, input.confidence),
    },
  };
}

/**
 * Reads every `event-*.json` under `dir`. A directory that cannot be read
 * (missing, mistyped, permission-denied) fails LOUDLY — it must never look
 * like a directory that legitimately holds no events, which would surface
 * downstream as a confusing all-scenarios-missing pairing failure.
 */
export async function readEventsFromDirectory(
  dir: string,
): Promise<readonly WorkloadCeilingRawEvent[]> {
  let allEntries: readonly string[];
  try {
    allEntries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `workload-ceiling-compare: cannot read events directory ${dir} (${code}) — ` +
        `a mistyped or unreadable directory must not look like an empty one`,
      { cause: error },
    );
  }
  const entries = allEntries.filter((name) => name.startsWith("event-") && name.endsWith(".json"));
  const events: WorkloadCeilingRawEvent[] = [];
  for (const entry of entries) {
    const raw = await readFile(`${dir}/${entry}`, "utf8");
    events.push(decodeWorkloadCeilingRawEvent(raw));
  }
  return events;
}

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:compare`). Reads every
 * `event-*.json` `workload-ceiling-collect.ts` wrote under two directories —
 * one per implementation — and prints + persists the matched comparison.
 *
 * Required env: `WORKLOAD_CEILING_CONTROL_DIR`, `WORKLOAD_CEILING_CANDIDATE_DIR`.
 * Optional: `WORKLOAD_CEILING_CONFIDENCE` (default `0.95`),
 * `WORKLOAD_CEILING_BOOTSTRAP_SEED` (default `0`),
 * `WORKLOAD_CEILING_BOOTSTRAP_RESAMPLES` (default `2000`).
 */
async function main(): Promise<number> {
  const controlDir = process.env["WORKLOAD_CEILING_CONTROL_DIR"];
  const candidateDir = process.env["WORKLOAD_CEILING_CANDIDATE_DIR"];
  if (controlDir === undefined || candidateDir === undefined) {
    console.error(
      "workload-ceiling-compare: requires WORKLOAD_CEILING_CONTROL_DIR and " +
        "WORKLOAD_CEILING_CANDIDATE_DIR — directories of event-*.json files " +
        "written by workload-ceiling-collect.ts.",
    );
    return 1;
  }

  const controlEvents = await readEventsFromDirectory(controlDir);
  const candidateEvents = await readEventsFromDirectory(candidateDir);
  const matched = matchWorkloadCeilingEvents(controlEvents, candidateEvents);

  if (matched.pairs.length === 0) {
    console.error(
      `workload-ceiling-compare: no complete pairs (${matched.incomplete.length} incomplete). ` +
        "Nothing to compare.",
    );
    for (const entry of matched.incomplete) {
      console.error(`  - ${entry.scenario_id}: ${entry.reason}`);
    }
    return 1;
  }

  const report = buildWorkloadCeilingComparisonReport({
    matched,
    controlEvents,
    candidateEvents,
    confidence: Number(process.env["WORKLOAD_CEILING_CONFIDENCE"] ?? 0.95),
    seed: Number(process.env["WORKLOAD_CEILING_BOOTSTRAP_SEED"] ?? 0),
    resamples: Number(process.env["WORKLOAD_CEILING_BOOTSTRAP_RESAMPLES"] ?? 2000),
  });

  console.log(`paired cells: ${report.pair_count}, incomplete: ${report.incomplete_count}`);
  for (const pair of report.pairs) {
    console.log(
      `  ${pair.scenario_id}: control p50=${pair.control.p50.value} (n=${pair.control.sample_count}) ` +
        `candidate p50=${pair.candidate.p50.value} (n=${pair.candidate.sample_count})`,
    );
  }
  console.log(
    `control cpu_ms p50/p95/p99: ${report.control_cpu_ms.p50.value}/${report.control_cpu_ms.p95.value}/${report.control_cpu_ms.p99.value}`,
  );
  console.log(
    `candidate cpu_ms p50/p95/p99: ${report.candidate_cpu_ms.p50.value}/${report.candidate_cpu_ms.p95.value}/${report.candidate_cpu_ms.p99.value}`,
  );
  console.log(
    `paired candidate/control ratio: point=${report.paired_candidate_over_control_ratio.point} ` +
      `interval=[${report.paired_candidate_over_control_ratio.interval.lower}, ${report.paired_candidate_over_control_ratio.interval.upper}]`,
  );

  const outDir = "bench/results/workload-ceiling";
  await mkdir(outDir, { recursive: true });
  const outPath = `${outDir}/comparison-${Date.now()}.json`;
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${outPath}`);
  return 0;
}

// CLI entrypoint guard: `main()` runs only when this module is executed
// directly, never when a test imports it — an import must not read event
// directories or write comparison artifacts off the environment.
await runAsCliEntrypoint(import.meta.url, main);

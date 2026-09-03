/**
 * Matched comparison for the deployed workload-ceiling study (parent plan
 * Task 8 Step 7).
 *
 * Joins `monolithic-control` and `chunked-candidate` raw events
 * (`workload-ceiling-harness.ts`, produced by `workload-ceiling-collect.ts`)
 * by `scenario_id` PLUS deployment metadata — `compatibility_date` and
 * `script_version` must agree, because this study's Worker
 * (`bench/workload-ceiling-worker/src/index.ts`) serves both
 * implementations from the SAME deployed script, branching on the request's
 * `implementation` field. Two events under the same scenario but different
 * deployment metadata were not measured on the same runtime build and are
 * NOT a valid pair.
 *
 * Every number this module reports comes from a tagged algorithm in
 * `statistics.ts` — p50/p95/p99 via `quantileEstimate`, the paired
 * candidate/control ratio via `pairedRatioBootstrap`, and the zero-failure
 * upper bound on unresolved/failed invocations via
 * `clopperPearsonZeroFailureUpper` — computed per side ONLY over sides that
 * observed zero unresolved invocations; a side with any failure is marked
 * `{ invalid: "failures-present", failure_count }` instead, because the
 * zero-failure formula has no honest extension to F > 0 (see
 * {@link WorkloadCeilingZeroFailureBoundInvalid}). An incomplete pair (missing a side,
 * mismatched deployment metadata, or either side failing to resolve to a
 * usable `ok` measurement) is rejected from the paired statistics rather than
 * silently imputed, and is reported separately.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  clopperPearsonZeroFailureUpper,
  pairedRatioBootstrap,
  quantileEstimate,
  type BootstrapResult,
  type ClopperPearsonZeroFailureResult,
  type PairedValue,
  type QuantileEstimate,
} from "./statistics.ts";
import {
  decodeWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_SUCCESS_OUTCOME,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";

function deploymentKey(event: WorkloadCeilingRawEvent): string {
  return `${event.compatibility_date}|${event.script_version}`;
}

/**
 * The single definition of "this invocation resolved to a usable
 * measurement": the collection window produced a CPU number AND the platform
 * classified the invocation as a success.
 *
 * The `cpu_ms !== null` half alone is NOT sufficient. A non-success outcome can
 * still carry a partial CPU number — the platform reports one for
 * `exceededCpu`, and `workload-ceiling-harness.ts` preserves that shape
 * deliberately. Both the pairing logic and the per-side failure-budget count
 * MUST read this one predicate: a side that observed a real failed
 * invocation must never receive a valid-looking zero-failure bound, which is
 * exactly what counting such an event as a success would produce.
 */
const isResolvedOk = (event: WorkloadCeilingRawEvent): event is ResolvedWorkloadCeilingRawEvent =>
  event.cpu_ms !== null && event.outcome === WORKLOAD_CEILING_SUCCESS_OUTCOME;

/** A WorkloadCeilingRawEvent whose collection window resolved to exactly one single-request invocation. */
export type ResolvedWorkloadCeilingRawEvent = Omit<WorkloadCeilingRawEvent, "cpu_ms"> & {
  readonly cpu_ms: number;
};

export interface WorkloadCeilingComparisonPair {
  readonly scenario_id: string;
  readonly control: ResolvedWorkloadCeilingRawEvent;
  readonly candidate: ResolvedWorkloadCeilingRawEvent;
}

export interface WorkloadCeilingIncompletePair {
  readonly scenario_id: string;
  readonly reason:
    | "missing-control"
    | "missing-candidate"
    | "duplicate-scenario"
    | "deployment-metadata-mismatch"
    | "unresolved-cpu";
}

export interface WorkloadCeilingMatchedComparison {
  readonly pairs: readonly WorkloadCeilingComparisonPair[];
  readonly incomplete: readonly WorkloadCeilingIncompletePair[];
}

function indexByScenario(
  events: readonly WorkloadCeilingRawEvent[],
  incomplete: WorkloadCeilingIncompletePair[],
): Map<string, WorkloadCeilingRawEvent> {
  const byScenario = new Map<string, WorkloadCeilingRawEvent>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (byScenario.has(event.scenario_id)) {
      duplicates.add(event.scenario_id);
      continue;
    }
    byScenario.set(event.scenario_id, event);
  }
  for (const scenarioId of duplicates) {
    byScenario.delete(scenarioId);
    incomplete.push({ scenario_id: scenarioId, reason: "duplicate-scenario" });
  }
  return byScenario;
}

/**
 * Pure. Joins by `scenario_id`, then by deployment metadata, then requires
 * both sides to satisfy {@link isResolvedOk}. Every rejection is reported by
 * name — this function never drops a scenario silently.
 */
export function matchWorkloadCeilingEvents(
  controlEvents: readonly WorkloadCeilingRawEvent[],
  candidateEvents: readonly WorkloadCeilingRawEvent[],
): WorkloadCeilingMatchedComparison {
  const incomplete: WorkloadCeilingIncompletePair[] = [];
  const controlByScenario = indexByScenario(controlEvents, incomplete);
  const candidateByScenario = indexByScenario(candidateEvents, incomplete);

  const scenarioIds = new Set([...controlByScenario.keys(), ...candidateByScenario.keys()]);
  const pairs: WorkloadCeilingComparisonPair[] = [];
  for (const scenarioId of [...scenarioIds].toSorted()) {
    const control = controlByScenario.get(scenarioId);
    const candidate = candidateByScenario.get(scenarioId);
    if (control === undefined) {
      incomplete.push({ scenario_id: scenarioId, reason: "missing-control" });
      continue;
    }
    if (candidate === undefined) {
      incomplete.push({ scenario_id: scenarioId, reason: "missing-candidate" });
      continue;
    }
    if (deploymentKey(control) !== deploymentKey(candidate)) {
      incomplete.push({ scenario_id: scenarioId, reason: "deployment-metadata-mismatch" });
      continue;
    }
    if (!isResolvedOk(control) || !isResolvedOk(candidate)) {
      incomplete.push({ scenario_id: scenarioId, reason: "unresolved-cpu" });
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
 * A side of the comparison whose collected events include at least one
 * invocation that did not resolve to a usable measurement — either
 * `cpu_ms: null`, or a non-success outcome that still carried a partial CPU
 * number (see {@link isResolvedOk}). The zero-failure Clopper-Pearson
 * formula (`1 − c^(1/n)`) is valid only at zero observed failures: `n`
 * counts successes, so plugging any success-count-derived denominator in
 * at F > 0 is anti-conservative (more failures would TIGHTEN the bound —
 * the opposite of the intended failure-budget reading), and the general
 * F > 0 bound needs a Beta inverse (bisection over the Binomial CDF),
 * deliberately out of scope for a bench tool. Reported by name — never
 * dropped silently, and never filled in with a number the formula cannot
 * honestly produce.
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
  readonly pair_count: number;
  readonly incomplete_count: number;
  readonly incomplete: readonly WorkloadCeilingIncompletePair[];
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
   * ones — the study's failure budget. Valid ONLY for a side on which every
   * event satisfies {@link isResolvedOk}: a side with ≥ 1 failure carries
   * `{ invalid: "failures-present", failure_count }` instead of a bound
   * (see {@link WorkloadCeilingZeroFailureBoundInvalid} for why the
   * zero-failure formula has no honest F > 0 reading).
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
 * Per-side failure-budget assessment. F = 0 → the exact one-sided
 * zero-failure bound (attempts clamped to ≥ 1 so an empty event list still
 * yields the maximally-wide n = 1 bound rather than throwing); F > 0 → the
 * explicit invalidity marker, never an anti-conservative number.
 */
const zeroFailureUpperBound = (
  events: readonly WorkloadCeilingRawEvent[],
  confidence: number,
): WorkloadCeilingZeroFailureBound => {
  const failures = events.filter((event) => !isResolvedOk(event)).length;
  if (failures > 0) {
    return { invalid: "failures-present", failure_count: failures };
  }
  return clopperPearsonZeroFailureUpper(Math.max(1, events.length), confidence);
};

/**
 * Pure. Builds the full comparison report from a matched set plus the two
 * complete (pre-matching) event lists — the failure budget is deliberately
 * assessed over every collected attempt, not just the pairs that survived
 * matching, so a run that failed to resolve on one side still counts
 * against that side: it surfaces there as an explicit failures-present
 * marker, since the zero-failure bound itself is only computed at F = 0.
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
  const controlValues = matched.pairs.map((pair) => pair.control.cpu_ms);
  const candidateValues = matched.pairs.map((pair) => pair.candidate.cpu_ms);
  const pairedValues: PairedValue[] = matched.pairs.map((pair) => ({
    pair_id: pair.scenario_id,
    baseline: pair.control.cpu_ms,
    candidate: pair.candidate.cpu_ms,
  }));

  return {
    pair_count: matched.pairs.length,
    incomplete_count: matched.incomplete.length,
    incomplete: matched.incomplete,
    control_cpu_ms: quantiles(controlValues),
    candidate_cpu_ms: quantiles(candidateValues),
    paired_candidate_over_control_ratio: pairedRatioBootstrap(pairedValues, {
      seed: input.seed,
      resamples: input.resamples,
      confidence: input.confidence,
      inclusion_unit: "complete-pair",
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

  console.log(`pairs: ${report.pair_count}, incomplete: ${report.incomplete_count}`);
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

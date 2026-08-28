/**
 * Unattended capture runner for ticket 4: invokes the deployed Worker on the
 * preregistered schedule, appending one journal record per invocation.
 *
 * This CLI reads a sweep report, plans round-robin invocations across cells
 * and arms, and executes them at the spacing required by the telemetry system.
 * Each invocation is recorded in a JSONL journal before the next one starts,
 * so a crashed or killed run is fully recoverable.
 *
 * Two invocations cannot share a telemetry minute bucket, or they collapse into
 * one row and become impossible to resolve. This runner enforces a 70-second
 * spacing between starts (the contract's `invocation_spacing_seconds`) and
 * refuses to start in the last 10 seconds of any minute, so an invocation cannot
 * straddle a boundary and land its row in the next bucket.
 *
 * The shared secret is read from the environment and never written to disk,
 * logged, or included in error messages.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  collectionWindowFor,
  decodeWorkloadCeilingInvocationRecord,
  encodeWorkloadCeilingInvocationRecord,
  encodeWorkloadCeilingRunRequest,
  nextInvocationStart,
  type WorkloadCeilingImplementation,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingSweepCell,
  type WorkloadCeilingSweepReport,
  WORKLOAD_CEILING_CONTRACT_ID,
  type WorkloadCeilingThermalClass,
} from "./workload-ceiling-harness.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";

// Required env vars for the capture runner (documented in main() JSDoc)
// WORKLOAD_CEILING_SWEEP_ID, WORKLOAD_CEILING_SHARED_SECRET, WORKLOAD_CEILING_WORKER_URL

const DEFAULT_RESULTS_DIR = "bench/results/workload-ceiling";
const DEFAULT_ARMS = ["monolithic-control", "monolithic-control-unhashed"] as const;

export interface PlannedInvocation {
  readonly scenario_id: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly fixture_prefix: string;
  readonly warmup: boolean;
  /** Position in the global serial order. */
  readonly index: number;
}

/**
 * Pure. The full invocation order for a sweep.
 *
 * Round-robin over (cell × arm) — NOT blocked by cell. A five-hour serial run
 * drifts through colo reassignment, platform deploys, and diurnal load; blocked
 * ordering lands all of that drift on whichever cells occupied that stretch,
 * which is precisely the between-cell comparison the axis exists to make.
 * Round-robin spreads it evenly, so drift inflates variance instead of faking a
 * trend.
 *
 * Warmups come first WITHIN each (cell, arm) — they exist to absorb first-read
 * and first-isolate costs for that fixture, which is a per-fixture property.
 */
export const planCaptureInvocations = (input: {
  readonly cells: readonly WorkloadCeilingSweepCell[];
  readonly arms: readonly WorkloadCeilingImplementation[];
  readonly warmup: number;
  readonly measured: number;
}): readonly PlannedInvocation[] => {
  const result: PlannedInvocation[] = [];
  const totalPasses = input.warmup + input.measured;

  // Round-robin: for each pass, for each arm, for each cell. This ensures
  // consecutive invocations hit different cells, spreading drift evenly.
  // Warmups come first within each (cell, arm) pair.
  for (let pass = 0; pass < totalPasses; pass++) {
    for (const arm of input.arms) {
      for (const cell of input.cells) {
        result.push({
          scenario_id: cell.scenario_id,
          implementation: arm,
          fixture_prefix: cell.fixture_prefix,
          warmup: pass < input.warmup,
          index: result.length,
        });
      }
    }
  }

  return result;
};

/**
 * The plan slot a record or a planned invocation belongs to. `warmup` is part
 * of it because a slot's warmups and its measured invocations are different
 * work, and `exclusion_policy` is `warmup-tagged-before-run-only`.
 */
const slotKey = (invocation: {
  readonly scenario_id: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly warmup: boolean;
}): string =>
  `${invocation.scenario_id}\u0000${invocation.implementation}\u0000${String(invocation.warmup)}`;

/**
 * Pure. The planned invocations a journal does not already account for.
 *
 * A journal record cannot be matched to a planned invocation by identity:
 * `run_id` is a UUID minted at invocation time, and the record carries no plan
 * index. What it does carry is the slot, and the journal is append-only in
 * execution order — so the k-th record for a slot IS the k-th planned
 * invocation of that slot. Resume drops the first n planned invocations of
 * each slot, where n is that slot's record count.
 *
 * Getting this wrong is expensive rather than wrong-looking: a resume that
 * matches nothing re-runs every completed invocation, doubling both the
 * attended hours and the telemetry rows the collector has to disambiguate.
 */
export const remainingCaptureInvocations = (
  planned: readonly PlannedInvocation[],
  journal: readonly WorkloadCeilingInvocationRecord[],
): readonly PlannedInvocation[] => {
  const outstanding = new Map<string, number>();
  for (const record of journal) {
    const key = slotKey(record);
    outstanding.set(key, (outstanding.get(key) ?? 0) + 1);
  }
  return planned.filter((invocation) => {
    const key = slotKey(invocation);
    const count = outstanding.get(key) ?? 0;
    if (count === 0) {
      return true;
    }
    outstanding.set(key, count - 1);
    return false;
  });
};

/**
 * A required environment variable, rejected when unset OR blank. Blank counts
 * because the one required secret here is sent as a bearer token: an exported
 * but empty `WORKLOAD_CEILING_SHARED_SECRET` produces `Authorization: Bearer `
 * and a run that fails 401 on its first invocation instead of at startup.
 */
const assertEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`Missing or blank required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
};

const parseArms = (value: string | undefined): WorkloadCeilingImplementation[] => {
  if (value === undefined) {
    return [...DEFAULT_ARMS];
  }
  const arms = value.split(",").map((s) => s.trim()) as WorkloadCeilingImplementation[];
  for (const arm of arms) {
    if (!["monolithic-control", "monolithic-control-unhashed", "chunked-candidate"].includes(arm)) {
      console.error(`Invalid arm: ${arm}`);
      process.exit(1);
    }
  }
  return arms;
};

const parseResultsDir = (value: string | undefined): string => {
  return value === undefined ? DEFAULT_RESULTS_DIR : value;
};

const generateRunId = (): string => {
  return randomUUID();
};

const validateWorkerUrl = (url: string): void => {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/run") {
      console.error(`WORKLOAD_CEILING_WORKER_URL path must be /run, got: ${parsed.pathname}`);
      process.exit(1);
    }
    // Note: We validate the URL is well-formed and has the correct path.
    // The real security guarantee is the shared secret bearer token,
    // not the hostname pattern. Free tier accounts may not have a
    // workers.dev subdomain, so we don't enforce the hostname prefix here.
  } catch {
    console.error(`Invalid WORKLOAD_CEILING_WORKER_URL: ${url}`);
    process.exit(1);
  }
};

const loadSweepReport = async (
  resultsDir: string,
  sweepId: string,
): Promise<WorkloadCeilingSweepReport> => {
  const sweepPath = resolve(resultsDir, `sweep-${sweepId}.json`);
  try {
    const raw = await readFile(sweepPath, "utf-8");
    return JSON.parse(raw) as WorkloadCeilingSweepReport;
  } catch (error) {
    console.error(`Failed to read sweep report from ${sweepPath}`);
    console.error(error);
    process.exit(1);
  }
};

const loadExistingJournal = async (
  resultsDir: string,
  sweepId: string,
): Promise<WorkloadCeilingInvocationRecord[]> => {
  const journalPath = resolve(resultsDir, `journal-${sweepId}.jsonl`);
  try {
    const raw = await readFile(journalPath, "utf-8");
    return raw
      .trim()
      .split("\n")
      .map((line) => {
        if (line.trim() === "") {
          throw new Error("Empty line in journal");
        }
        return decodeWorkloadCeilingInvocationRecord(line);
      });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return []; // No journal yet
    }
    console.error(`Failed to read journal from ${journalPath}`);
    console.error(error);
    process.exit(1);
  }
};

const appendJournalRecord = async (
  resultsDir: string,
  sweepId: string,
  record: WorkloadCeilingInvocationRecord,
): Promise<void> => {
  const journalPath = resolve(resultsDir, `journal-${sweepId}.jsonl`);
  try {
    const line = `${encodeWorkloadCeilingInvocationRecord(record)}\n`;
    await appendFile(journalPath, line, { mode: 0o600 });
    // Sync is handled by Node's default file handling; for guaranteed persistence
    // we rely on the OS and filesystem. For POSIX systems, the data is flushed
    // on close, which happens after each write.
  } catch (error) {
    console.error(`Failed to append journal record to ${journalPath}`);
    console.error(error);
    process.exit(1);
  }
};

export const invokeWorker = async (
  workerUrl: string,
  sharedSecret: string,
  planned: PlannedInvocation,
): Promise<{
  readonly status: number;
  /**
   * `null` when the response carried no readable result — a non-2xx status, or
   * a 2xx whose body did not parse. Never defaulted to 0 / false: a Worker
   * that answers 200 with an unreadable body would otherwise be journalled as
   * a warm zero-row invocation, which mislabels the thermal class the study
   * correlates against and hides the response defect.
   */
  readonly rowCount: number | null;
  readonly isolateCold: boolean | null;
  /** The run_id sent in the request body — the same value the Worker logs as `workload_ceiling_run_id`. The journal record MUST carry this, not a fresh UUID, or the ticket 6 dashboard join can never match. */
  readonly runId: string;
  /** Response body text when the result was unreadable (read from the same response — never re-invoke to inspect an error). */
  readonly bodyText?: string;
}> => {
  const runId = generateRunId();
  const requestBody = encodeWorkloadCeilingRunRequest({
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    run_id: runId,
    scenario_id: planned.scenario_id,
    implementation: planned.implementation,
    fixture_prefix: planned.fixture_prefix,
  });

  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: requestBody,
    });

    const status = response.status;

    // Drain the body from THIS response either way. Re-invoking to inspect a
    // response would mint a real extra invocation whose telemetry can collapse
    // into another sample's minute bucket.
    let bodyText = "<no body>";
    try {
      bodyText = await response.text();
    } catch {
      // keep placeholder
    }

    if (status >= 200 && status < 300) {
      try {
        const body = JSON.parse(bodyText) as {
          row_count?: number;
          isolate_cold?: boolean;
        };
        if (typeof body.row_count === "number" && typeof body.isolate_cold === "boolean") {
          return { status, rowCount: body.row_count, isolateCold: body.isolate_cold, runId };
        }
      } catch {
        // fall through to the unreadable-result return below
      }
    }

    return { status, rowCount: null, isolateCold: null, runId, bodyText };
  } catch (error) {
    console.error(`Failed to invoke Worker at ${workerUrl}`);
    console.error(error);
    throw error;
  }
};

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
};

/**
 * Time left, from the pace so far: elapsed / completed, times outstanding.
 * (Reporting elapsed / completed on its own would label the per-invocation
 * pace as an ETA.)
 */
const formatRemaining = (elapsedMs: number, completed: number, outstanding: number): string => {
  if (completed === 0) {
    return "unknown";
  }
  return formatDuration((elapsedMs / completed) * outstanding);
};

/**
 * Sleeps until the next legal start instant and returns it. WHICH instant is
 * legal is `nextInvocationStart`'s decision, not this function's — the
 * spacing-plus-minute-tail rule is the study's, it is pure, and it is unit
 * tested. A second copy here would be the copy that actually runs during a
 * capture while the tests validated the other one.
 */
const waitForSlot = async (previousStart: Date | null, now: Date): Promise<Date> => {
  const candidate = nextInvocationStart(previousStart, now);
  const delayMs = candidate.getTime() - now.getTime();
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return candidate;
};

const main = async (): Promise<number> => {
  const sweepId = assertEnv("WORKLOAD_CEILING_SWEEP_ID");
  const sharedSecret = assertEnv("WORKLOAD_CEILING_SHARED_SECRET");
  const workerUrl = assertEnv("WORKLOAD_CEILING_WORKER_URL");
  const arms = parseArms(process.env["WORKLOAD_CEILING_ARMS"]);
  const resultsDir = parseResultsDir(process.env["WORKLOAD_CEILING_RESULTS_DIR"]);

  const measuredOverride = process.env["WORKLOAD_CEILING_MEASURED_OVERRIDE"];
  const measured = measuredOverride
    ? parseInt(measuredOverride, 10)
    : WORKLOAD_CEILING_STUDY.capture.planned_measured_invocations_per_cell;
  const warmup = WORKLOAD_CEILING_STUDY.capture.warmup_invocations_per_cell;

  validateWorkerUrl(workerUrl);

  await mkdir(resultsDir, { recursive: true });

  const sweep = await loadSweepReport(resultsDir, sweepId);
  if (sweep.contract_id !== WORKLOAD_CEILING_CONTRACT_ID) {
    console.error(
      `Sweep report contract mismatch: expected ${WORKLOAD_CEILING_CONTRACT_ID}, got ${sweep.contract_id}`,
    );
    return 1;
  }

  const planned = planCaptureInvocations({
    cells: sweep.cells,
    arms,
    warmup,
    measured,
  });

  const existing = await loadExistingJournal(resultsDir, sweepId);
  const remaining = remainingCaptureInvocations(planned, existing);

  if (existing.length > 0) {
    console.log(`Resuming from ${existing.length} existing journal entries`);
  }
  console.log(`Planned ${planned.length} invocations, ${remaining.length} remaining`);
  console.log(`Warmup: ${warmup}, Measured: ${measured}`);
  console.log(`Arms: ${arms.join(", ")}`);
  console.log();

  const startTime = Date.now();
  let previousStart: Date | null = null;

  for (let i = 0; i < remaining.length; i++) {
    const plannedInvocation = remaining[i]!;
    const elapsed = Date.now() - startTime;

    console.log(
      `[${i + 1}/${remaining.length}] ${plannedInvocation.scenario_id} / ${plannedInvocation.implementation}${plannedInvocation.warmup ? " (warmup)" : ""}`,
    );
    console.log(
      `  Elapsed: ${formatDuration(elapsed)}, ETA: ${formatRemaining(elapsed, i, remaining.length - i)}`,
    );

    const startInstant = await waitForSlot(previousStart, new Date());

    const { status, rowCount, isolateCold, runId, bodyText } = await invokeWorker(
      workerUrl,
      sharedSecret,
      plannedInvocation,
    );

    if (status < 200 || status >= 300 || rowCount === null || isolateCold === null) {
      console.error(
        status < 200 || status >= 300
          ? `Worker returned non-2xx status: ${status}`
          : `Worker returned ${status} with a result this runner cannot read`,
      );
      console.error(`Response body: ${bodyText ?? "<no body>"}`);
      console.error(
        `Planned invocation: scenario_id=${plannedInvocation.scenario_id}, implementation=${plannedInvocation.implementation}, fixture_prefix=${plannedInvocation.fixture_prefix}, warmup=${plannedInvocation.warmup}`,
      );
      return 1;
    }

    const window = collectionWindowFor(startInstant);

    const thermalClass: WorkloadCeilingThermalClass = isolateCold ? "cold" : "warm";

    const record: WorkloadCeilingInvocationRecord = {
      contract_id: WORKLOAD_CEILING_CONTRACT_ID,
      sweep_id: sweepId,
      run_id: runId,
      scenario_id: plannedInvocation.scenario_id,
      implementation: plannedInvocation.implementation,
      fixture_prefix: plannedInvocation.fixture_prefix,
      warmup: plannedInvocation.warmup,
      invoked_at: startInstant.toISOString(),
      window_gte: window.gte,
      window_lt: window.lt,
      http_status: status,
      row_count: rowCount,
      thermal_class: thermalClass,
    };

    await appendJournalRecord(resultsDir, sweepId, record);

    previousStart = startInstant;
  }

  const totalElapsed = Date.now() - startTime;
  const journalPath = resolve(resultsDir, `journal-${sweepId}.jsonl`);

  console.log();
  console.log(`Capture complete`);
  console.log(`  Journal: ${journalPath}`);
  console.log(`  Total invocations: ${remaining.length}`);
  console.log(`  Total time: ${formatDuration(totalElapsed)}`);
  console.log();
  console.log(
    `Wait ${WORKLOAD_CEILING_STUDY.capture.telemetry_settle_seconds} seconds for telemetry to settle, then run:`,
  );
  console.log();
  console.log(`  WORKLOAD_CEILING_SWEEP_ID=${sweepId} \\`);
  console.log(`  WORKLOAD_CEILING_COMPATIBILITY_DATE=<date> \\`);
  console.log(`  pnpm bench:workload-ceiling:collect-batch`);

  return 0;
};

await runAsCliEntrypoint(import.meta.url, main);

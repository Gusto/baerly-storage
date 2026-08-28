/**
 * Batch collector for ticket 4: replays the journal against the platform's
 * telemetry APIs, one collection window per invocation.
 *
 * This CLI reads a journal from the capture runner and collects BOTH
 * telemetry sources per non-warmup entry (Workers Observability as the
 * existence/outcome authority; `workersInvocationsAdaptive` for the CPU
 * measurement — see `workload-ceiling-harness.ts`'s evidence block), writing
 * raw and event files into per-arm directories.
 *
 * Collection is idempotent and re-runnable, and the retry policy is
 * preregistered in `WORKLOAD_CEILING_STUDY.capture.telemetry`: after the
 * initial pass, ONE further collection-only pass runs after a fixed delay
 * for every run whose evidence has not resolved (or whose CPU row has not
 * landed). Re-querying a fixed window is not a re-invocation — nothing is
 * ever re-rolled, no run id is ever re-minted, and the
 * warmup-tagged-only exclusion policy is untouched. A run that is still
 * unresolved after the retry stays in the record: it blocks the capture's
 * evidence completeness (or the cell's CPU sample floor) and there is no
 * sanctioned remedy after the fact — no top-up, no re-invoke.
 *
 * The shared secret is NOT used in this phase; only Cloudflare credentials
 * for the telemetry APIs.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  decodeWorkloadCeilingInvocationRecord,
  decodeWorkloadCeilingRawEvent,
  type WorkloadCeilingEvidenceStatus,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import { isResolvedOk } from "./workload-ceiling-compare.ts";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";

const REQUIRED_ENV = ["WORKLOAD_CEILING_SWEEP_ID", "WORKLOAD_CEILING_COMPATIBILITY_DATE"] as const;

const DEFAULT_RESULTS_DIR = "bench/results/workload-ceiling";

interface CollectionOutcome {
  readonly scenario_id: string;
  readonly implementation: string;
  readonly run_id: string;
  /** The collector ran without erroring. Says nothing about evidence resolution. */
  readonly success: boolean;
  /** Evidence status of the authoritative record after the final pass. */
  readonly evidence_status: WorkloadCeilingEvidenceStatus | "not-collected";
  /** Whether the event carries a finite CPU measurement. */
  readonly cpu_resolved: boolean;
  /** Collection passes that actually queried this run's window. */
  readonly attempts: number;
  /** Unresolved on a previous pass, resolved on this one. */
  readonly newly_resolved?: boolean;
  readonly outcome?: string | null;
  readonly error?: string;
}

interface BatchCollectionSummary {
  readonly sweep_id: string;
  readonly total: number;
  readonly skipped: number; // warmup entries
  readonly succeeded: number;
  readonly failed: number;
  readonly evidence_resolved: number;
  readonly evidence_missing: number;
  readonly evidence_ambiguous: number;
  readonly cpu_resolved: number;
  readonly cpu_missing: number;
  /** Records that were unresolved on a previous pass and resolved on this one. */
  readonly newly_resolved: number;
  readonly outcomes: readonly CollectionOutcome[];
}

/**
 * Loads and parses the journal from the capture runner.
 */
async function loadJournal(
  resultsDir: string,
  sweepId: string,
): Promise<WorkloadCeilingInvocationRecord[]> {
  const journalPath = resolve(resultsDir, `journal-${sweepId}.jsonl`);
  try {
    const raw = await readFile(journalPath, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "");
    return lines.map((line) => {
      try {
        return decodeWorkloadCeilingInvocationRecord(line);
      } catch (error) {
        throw new Error(
          `Failed to decode journal line: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      console.error(`Journal not found: ${journalPath}`);
      console.error(`Run the capture runner first to generate the journal.`);
      throw error;
    }
    throw error;
  }
}

/**
 * Groups journal entries by implementation for per-arm directory output.
 */
function groupByImplementation(
  records: readonly WorkloadCeilingInvocationRecord[],
): ReadonlyMap<string, readonly WorkloadCeilingInvocationRecord[]> {
  const groups = new Map<string, WorkloadCeilingInvocationRecord[]>();
  for (const record of records) {
    let group = groups.get(record.implementation);
    if (group === undefined) {
      group = [];
      groups.set(record.implementation, group);
    }
    group.push(record);
  }
  return groups;
}

/**
 * Spawns the single-run collector for one journal entry.
 *
 * Returns a promise that resolves when the collector exits. The collector
 * is spawned with all required env vars set, so it needs no additional state.
 * This is the ONLY actor that can touch the platform in this module, and it
 * only ever READS telemetry — the collection path has no way to invoke the
 * Worker, which is what makes "collection-only retry" structurally true.
 */
function spawnCollector(
  record: WorkloadCeilingInvocationRecord,
  compatibilityDate: string,
  outDir: string,
): Promise<{ readonly success: boolean; readonly error?: string }> {
  return new Promise((collectorResolve, _reject) => {
    const env: Record<string, string> = {
      ...process.env,
      WORKLOAD_CEILING_RUN_ID: record.run_id,
      WORKLOAD_CEILING_SCENARIO_ID: record.scenario_id,
      WORKLOAD_CEILING_COMPATIBILITY_DATE: compatibilityDate,
      WORKLOAD_CEILING_WINDOW_START: record.window_gte,
      WORKLOAD_CEILING_WINDOW_END: record.window_lt,
      WORKLOAD_CEILING_THERMAL_CLASS: record.thermal_class,
      WORKLOAD_CEILING_OUT_DIR: outDir,
    };

    const collector = spawn(
      "node",
      ["--import", "./bench/register-hooks.mjs", "bench/measurement/workload-ceiling-collect.ts"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    collector.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    collector.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    collector.on("close", (code) => {
      const success = code === 0;
      collectorResolve({
        success,
        error: success ? undefined : `exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      });
    });

    collector.on("error", (error) => {
      collectorResolve({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

/**
 * Reads the already-collected event for a run, or `undefined` when this run
 * has not been collected yet (either file missing, or the event unparseable).
 */
async function readCollectedEvent(
  outDir: string,
  runId: string,
): Promise<WorkloadCeilingRawEvent | undefined> {
  const rawPath = resolve(outDir, `raw-${runId}.json`);
  const eventPath = resolve(outDir, `event-${runId}.json`);
  let eventText: string;
  try {
    [, eventText] = await Promise.all([readFile(rawPath), readFile(eventPath, "utf-8")]);
  } catch {
    return undefined;
  }
  try {
    return decodeWorkloadCeilingRawEvent(eventText);
  } catch (error) {
    // Still "not collected" — the run is re-queried and the file overwritten,
    // which is the recovery we want. But a file that exists and does not
    // decode is codec drift or corruption, not an uncollected run, and
    // repairing it silently is how a schema mismatch survives a whole sweep.
    console.error(
      `workload-ceiling-collect-batch: ${eventPath} exists but does not decode; ` +
        `re-collecting and overwriting it. ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Pure. Whether an already-present collection counts as finished, i.e.
 * whether this pass should skip the run rather than re-query its window.
 *
 * Evidence-contract v2: presence of the files is NOT the criterion, and
 * neither is "usable measurement". A collection is finished when the
 * AUTHORITATIVE record resolved AND the run is not a success still missing
 * its CPU row (the one state a lagging `workersInvocationsAdaptive` row can
 * still fix). A resolved `exceededCpu` is finished — a kill is a terminal
 * platform fact, and re-querying cannot un-kill it. A missing or ambiguous
 * authoritative record is not finished until the preregistered retry count
 * is exhausted.
 */
export const isFinishedCollection = (event: WorkloadCeilingRawEvent | undefined): boolean =>
  event !== undefined &&
  event.evidence.status === "resolved" &&
  !(event.outcome === "success" && event.cpu_ms === null);

/**
 * Pure driver for the preregistered collection-retry policy. All effects are
 * injected (`readExisting`, `collect`, `sleep`), so the policy itself is
 * unit-testable without spawning or waiting.
 *
 * Invariants the driver exists to enforce:
 *
 *  - a run already finished on disk (per {@link isFinishedCollection}) is
 *    never re-queried;
 *  - an unfinished run is re-queried with its SAME journal record — the same
 *    run id and the same fixed window — so a retry can never mint or sanction
 *    a new invocation (and the `collect` callback is the only platform actor);
 *  - at most `retries` retry passes run, each preceded by exactly one
 *    `retryDelayMs` sleep (no sleep when nothing is unresolved);
 *  - a run still unresolved after the last pass stays in the record with its
 *    final evidence status — there is no third pass and no top-up.
 */
export const collectWithRetry = async (
  records: readonly WorkloadCeilingInvocationRecord[],
  options: {
    readonly retries: number;
    readonly retryDelayMs: number;
    readonly readExisting: (
      record: WorkloadCeilingInvocationRecord,
    ) => Promise<WorkloadCeilingRawEvent | undefined>;
    readonly collect: (
      record: WorkloadCeilingInvocationRecord,
    ) => Promise<WorkloadCeilingRawEvent | undefined>;
    readonly sleep: (ms: number) => Promise<void>;
  },
): Promise<readonly CollectionOutcome[]> => {
  const results = new Map<
    string,
    {
      readonly record: WorkloadCeilingInvocationRecord;
      success: boolean;
      error?: string;
      event: WorkloadCeilingRawEvent | undefined;
      attempts: number;
      newlyResolved: boolean;
      previouslySeen: boolean;
    }
  >();

  const outcomeOf = (runId: string): CollectionOutcome | undefined => {
    const entry = results.get(runId);
    if (entry === undefined) {
      return undefined;
    }
    const evidenceStatus: CollectionOutcome["evidence_status"] =
      entry.event !== undefined ? entry.event.evidence.status : "not-collected";
    return {
      scenario_id: entry.record.scenario_id,
      implementation: entry.record.implementation,
      run_id: entry.record.run_id,
      success: entry.success,
      evidence_status: evidenceStatus,
      cpu_resolved: entry.event !== undefined && isResolvedOk(entry.event),
      attempts: entry.attempts,
      newly_resolved: entry.newlyResolved || undefined,
      outcome: entry.event?.outcome ?? undefined,
      error: entry.error,
    };
  };

  // Initial pass: skip runs already finished on disk.
  let pending: WorkloadCeilingInvocationRecord[] = [];
  for (const record of records) {
    const existing = await options.readExisting(record);
    if (isFinishedCollection(existing)) {
      results.set(record.run_id, {
        record,
        success: true,
        event: existing,
        attempts: 0,
        newlyResolved: false,
        previouslySeen: true,
      });
      continue;
    }
    if (existing !== undefined) {
      // Present but unfinished. Seeded into `results` rather than only into
      // `pending`, so the collection below can see the prior unresolved state
      // and report `newly_resolved` — the recovery-on-re-run case the flag
      // exists for. The entry is overwritten by that pass; it is a baseline,
      // not a result.
      results.set(record.run_id, {
        record,
        success: false,
        event: existing,
        attempts: 0,
        newlyResolved: false,
        previouslySeen: true,
      });
    }
    pending.push(record);
  }

  let pass = 0;
  while (true) {
    if (pass > 0) {
      await options.sleep(options.retryDelayMs);
    }
    const stillPending: WorkloadCeilingInvocationRecord[] = [];
    for (const record of pending) {
      const existing = results.get(record.run_id);
      const collected = await options.collect(record);
      const success = collected !== undefined;
      const entry = {
        record,
        success,
        error: success ? undefined : "collector failed",
        event: collected,
        attempts: (existing?.attempts ?? 0) + 1,
        newlyResolved:
          existing !== undefined &&
          existing.event !== undefined &&
          existing.event.evidence.status !== "resolved" &&
          collected !== undefined &&
          collected.evidence.status === "resolved",
        previouslySeen: false,
      };
      results.set(record.run_id, entry);
      if (!isFinishedCollection(collected)) {
        stillPending.push(record);
      }
    }
    pending = stillPending;
    pass += 1;
    if (pending.length === 0 || pass > options.retries) {
      break;
    }
  }

  return records.map((record) => outcomeOf(record.run_id)!).filter((o) => o !== undefined);
};

/**
 * Pure. Output directory for one arm's collected events —
 * `<resultsDir>/<sweepId>/<implementation>/`, matching the layout
 * `workload-ceiling-aggregate.ts` reads (ticket 5's spec). The sweep-scoped
 * subdirectory is load-bearing: collected events carry no `sweep_id` field,
 * so directory scope is the only thing keeping sweeps separable.
 */
export const armOutputDir = (resultsDir: string, sweepId: string, implementation: string): string =>
  resolve(resultsDir, sweepId, implementation);

/**
 * Runs batch collection for one implementation arm.
 */
async function collectArm(
  records: readonly WorkloadCeilingInvocationRecord[],
  compatibilityDate: string,
  resultsDir: string,
  sweepId: string,
  implementation: string,
): Promise<readonly CollectionOutcome[]> {
  const armDir = armOutputDir(resultsDir, sweepId, implementation);
  await mkdir(armDir, { recursive: true });

  const nonWarmupRecords = records.filter((r) => !r.warmup);
  console.log(`Collecting ${nonWarmupRecords.length} non-warmup entries for ${implementation}`);

  const telemetry = WORKLOAD_CEILING_STUDY.capture.telemetry;
  const outcomes = await collectWithRetry(nonWarmupRecords, {
    retries: telemetry.collection_retries,
    retryDelayMs: telemetry.collection_retry_delay_seconds * 1000,
    readExisting: (record) => readCollectedEvent(armDir, record.run_id),
    collect: async (record) => {
      console.log(`  [${record.scenario_id} / ${record.run_id}]`);
      const existing = await readCollectedEvent(armDir, record.run_id);
      if (existing !== undefined) {
        console.log(`    Re-collecting: previous pass was ${existing.evidence.status}`);
      }
      const result = await spawnCollector(record, compatibilityDate, armDir);
      if (!result.success) {
        console.log(`    Failed: ${result.error ?? "unknown error"}`);
        return undefined;
      }
      const collected = await readCollectedEvent(armDir, record.run_id);
      if (collected === undefined) {
        console.log(`    Collected: UNREADABLE event`);
      } else if (collected.evidence.status === "resolved") {
        console.log(
          existing === undefined
            ? `    Collected: resolved (outcome=${String(collected.outcome)})`
            : `    Collected: NEWLY RESOLVED`,
        );
      } else {
        console.log(
          `    Collected: ${collected.evidence.status.toUpperCase()} — ${collected.evidence.detail}`,
        );
      }
      return collected;
    },
    sleep: async (ms) => {
      console.log(
        `Waiting ${Math.round(ms / 1000)}s before the one collection-only retry pass ` +
          `(preregistered delay; re-queries unresolved windows, never re-invokes)...`,
      );
      await new Promise((r) => setTimeout(r, ms));
    },
  });

  return outcomes;
}

/**
 * Writes the batch collection summary to disk.
 */
async function writeSummary(
  resultsDir: string,
  sweepId: string,
  summary: BatchCollectionSummary,
): Promise<void> {
  const summaryPath = resolve(resultsDir, `summary-${sweepId}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote summary to ${summaryPath}`);
}

async function main(): Promise<number> {
  // Validate required env vars
  for (const name of REQUIRED_ENV) {
    if (process.env[name] === undefined) {
      console.error(`Missing required environment variable: ${name}`);
      return 1;
    }
  }

  const sweepId = process.env["WORKLOAD_CEILING_SWEEP_ID"]!;
  const compatibilityDate = process.env["WORKLOAD_CEILING_COMPATIBILITY_DATE"]!;
  const resultsDir = process.env["WORKLOAD_CEILING_RESULTS_DIR"] ?? DEFAULT_RESULTS_DIR;

  console.log(`Batch collection for sweep ${sweepId}`);
  console.log(`Results directory: ${resultsDir}`);
  console.log();

  // Load the journal
  const records = await loadJournal(resultsDir, sweepId);
  console.log(`Loaded ${records.length} journal entries`);
  console.log();

  // Group by implementation
  const groups = groupByImplementation(records);

  const allOutcomes: CollectionOutcome[] = [];
  let totalSkipped = 0; // warmup entries
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalEvidenceResolved = 0;
  let totalEvidenceMissing = 0;
  let totalEvidenceAmbiguous = 0;
  let totalCpuResolved = 0;
  let totalCpuMissing = 0;
  let totalNewlyResolved = 0;

  // Collect each arm
  for (const [implementation, implRecords] of groups.entries()) {
    const outcomes = await collectArm(
      implRecords,
      compatibilityDate,
      resultsDir,
      sweepId,
      implementation,
    );
    allOutcomes.push(...outcomes);

    for (const outcome of outcomes) {
      if (outcome.success) {
        totalSucceeded++;
      } else {
        totalFailed++;
      }
      if (outcome.evidence_status === "resolved") {
        totalEvidenceResolved++;
        if (outcome.newly_resolved === true) {
          totalNewlyResolved++;
        }
      } else if (outcome.evidence_status === "missing") {
        totalEvidenceMissing++;
      } else if (outcome.evidence_status === "ambiguous") {
        totalEvidenceAmbiguous++;
      }
      if (outcome.cpu_resolved) {
        totalCpuResolved++;
      } else {
        totalCpuMissing++;
      }
    }
  }

  // Count warmup entries (they weren't collected)
  totalSkipped = records.filter((r) => r.warmup).length;

  // Write summary
  const summary: BatchCollectionSummary = {
    sweep_id: sweepId,
    total: records.length,
    skipped: totalSkipped,
    succeeded: totalSucceeded,
    failed: totalFailed,
    evidence_resolved: totalEvidenceResolved,
    evidence_missing: totalEvidenceMissing,
    evidence_ambiguous: totalEvidenceAmbiguous,
    cpu_resolved: totalCpuResolved,
    cpu_missing: totalCpuMissing,
    newly_resolved: totalNewlyResolved,
    outcomes: allOutcomes,
  };
  await writeSummary(resultsDir, sweepId, summary);

  // Print final status
  console.log();
  console.log(`Batch collection complete:`);
  console.log(`  Total journal entries: ${summary.total}`);
  console.log(`  Skipped (warmup): ${summary.skipped}`);
  console.log(`  Collector succeeded / failed: ${summary.succeeded} / ${summary.failed}`);
  console.log(
    `  Evidence resolved: ${summary.evidence_resolved}` +
      `${summary.newly_resolved > 0 ? ` (${summary.newly_resolved} newly resolved this run)` : ""}`,
  );
  console.log(
    `  Evidence missing: ${summary.evidence_missing}, ambiguous: ${summary.evidence_ambiguous}`,
  );
  console.log(`  CPU resolved: ${summary.cpu_resolved}, CPU missing: ${summary.cpu_missing}`);

  if (summary.evidence_missing > 0 || summary.evidence_ambiguous > 0) {
    console.log();
    console.log(`Unresolved evidence — the invocation happened (the journal says so) but the`);
    console.log(`authoritative record did not resolve. The preregistered collection retry has`);
    console.log(`already run; there is no further sanctioned pass. These runs stay in the`);
    console.log(`record and BLOCK the capture's evidence completeness. Do NOT re-invoke, and`);
    console.log(`do NOT top up — additional attempts may only be planned before a capture,`);
    console.log(`never selected after observing missingness.`);
    for (const outcome of summary.outcomes) {
      if (outcome.evidence_status === "missing" || outcome.evidence_status === "ambiguous") {
        console.log(
          `  ${outcome.scenario_id} / ${outcome.implementation} / ${outcome.run_id}: ${outcome.evidence_status}`,
        );
      }
    }
  }

  if (summary.cpu_missing > 0) {
    console.log();
    console.log(`CPU-missing runs — the invocation succeeded but workersInvocationsAdaptive`);
    console.log(`never produced an attributable row. These are NOT execution failures; they`);
    console.log(`leave their cells short of the CPU sample floor, which blocks admission.`);
    for (const outcome of summary.outcomes) {
      if (!outcome.cpu_resolved) {
        console.log(
          `  ${outcome.scenario_id} / ${outcome.implementation} / ${outcome.run_id}: outcome=${String(outcome.outcome)}`,
        );
      }
    }
  }

  if (summary.failed > 0) {
    console.log();
    console.log(`Failed runs (collector errors):`);
    for (const outcome of summary.outcomes) {
      if (!outcome.success) {
        console.log(
          `  ${outcome.scenario_id} / ${outcome.implementation} / ${outcome.run_id}: ${outcome.error ?? "unknown"}`,
        );
      }
    }
    console.log();
    console.log(`Re-run collect-batch to retry failed collections.`);
    return 1;
  }

  return 0;
}

await runAsCliEntrypoint(import.meta.url, main);

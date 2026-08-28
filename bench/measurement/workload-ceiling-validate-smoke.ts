/**
 * Post-collection correlation-field validator for the deployed
 * workload-ceiling smoke run (Lane A, ticket 3/4 of
 * `docs/superpowers/programs/increase-workload-ceiling/`).
 *
 * `workload-ceiling-collect.ts` already round-trips its output through
 * {@link decodeWorkloadCeilingRawEvent}, so a malformed event never reaches
 * disk. What this script checks is the *content* the strict codec doesn't:
 * that `run_id` looks like the UUID provisioning generated, that
 * `compatibility_date` actually matches the deployed Worker's
 * `wrangler.jsonc`, that `cpu_ms` is sane when `outcome` is a success,
 * etc. — the correlation fields a maintainer would otherwise have to eyeball in
 * `event-<runId>.json` by hand after every smoke run.
 */
import { readFile } from "node:fs/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  decodeWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_KNOWN_OUTCOMES,
  WORKLOAD_CEILING_SUCCESS_OUTCOME,
  WORKLOAD_CEILING_THERMAL_CLASSES,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";

/** The `wrangler.jsonc` value `bench/workload-ceiling-worker/README.md` §"Runbook" pins the collector to. */
const EXPECTED_COMPATIBILITY_DATE = "2026-08-15";

interface ValidationResult {
  readonly field: string;
  readonly passed: boolean;
  readonly message: string;
}

function validateField(field: string, passed: boolean, message: string): ValidationResult {
  return { field, passed, message };
}

/** Pure. One row per correlation field; callers decide how to report failures. */
export function validateWorkloadCeilingRawEvent(
  event: WorkloadCeilingRawEvent,
): readonly ValidationResult[] {
  return [
    validateField(
      "run_id",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.run_id),
      "must be a UUID (provisioning generates one via randomUUID unless overridden)",
    ),
    validateField("scenario_id", event.scenario_id.trim().length > 0, "must be non-empty"),
    validateField(
      "script_version",
      /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]+)$/i.test(
        event.script_version,
      ),
      "must be a hex version hash or dashed UUID — the GraphQL scriptVersion " +
        "dimension returns dashed UUIDs (verified in lane-b-preflight.md Q1)",
    ),
    validateField(
      "compatibility_date",
      event.compatibility_date === EXPECTED_COMPATIBILITY_DATE,
      `must equal "${EXPECTED_COMPATIBILITY_DATE}" (bench/workload-ceiling-worker/wrangler.jsonc)`,
    ),
    validateField(
      "runtime_period",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
        event.runtime_period,
      ) &&
        (() => {
          const [start, end] = event.runtime_period.split("/") as [string, string];
          return Date.parse(start) < Date.parse(end);
        })(),
      "must be a `<start>/<end>` ISO 8601 interval with start before end " +
        "(fractional seconds allowed — the collector emits .000Z instants)",
    ),
    validateField(
      "colo",
      /^[A-Z]{3}$/.test(event.colo),
      "must be a 3-letter Cloudflare datacenter code",
    ),
    validateField(
      "thermal_class",
      (WORKLOAD_CEILING_THERMAL_CLASSES as readonly string[]).includes(event.thermal_class),
      `must be one of ${WORKLOAD_CEILING_THERMAL_CLASSES.join(", ")}`,
    ),
    validateField(
      "thermal_class/classified",
      process.env["WORKLOAD_CEILING_REQUIRE_THERMAL"] !== "1" || event.thermal_class !== "unknown",
      'must be "warm" or "cold" for a capture run (set WORKLOAD_CEILING_REQUIRE_THERMAL=1); ' +
        '"unknown" means the invoker did not relay the Worker\'s isolate_cold flag',
    ),
    validateField(
      "outcome",
      event.outcome !== null &&
        (WORKLOAD_CEILING_KNOWN_OUTCOMES as readonly string[]).includes(event.outcome),
      event.outcome === null
        ? "must be a platform outcome — the authoritative evidence did not resolve " +
            "(see the event's evidence block; blocks evidence completeness)"
        : `must be one of ${WORKLOAD_CEILING_KNOWN_OUTCOMES.join(", ")}`,
    ),
    validateField(
      "cpu_ms",
      event.outcome === WORKLOAD_CEILING_SUCCESS_OUTCOME
        ? event.cpu_ms !== null && Number.isFinite(event.cpu_ms) && event.cpu_ms >= 0
        : true,
      `must be a finite, non-negative number when outcome is "${WORKLOAD_CEILING_SUCCESS_OUTCOME}" — ` +
        "a success without CPU fails CPU completeness (it is not an execution failure)",
    ),
    validateField(
      "observed_at",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(event.observed_at),
      "must be an ISO 8601 timestamp",
    ),
  ];
}

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:validate-smoke`). Reads the
 * `event-<runId>.json` a prior `workload-ceiling-collect.ts` run wrote and
 * asserts every correlation field is present and well-formed.
 *
 * Required env: `WORKLOAD_CEILING_RUN_ID` (the same run ID passed to
 * provision/collect).
 * Optional: `WORKLOAD_CEILING_OUT_DIR` (must match the collector's — default
 * `bench/results/workload-ceiling/smoke-control`).
 */
async function main(): Promise<number> {
  const runId = process.env["WORKLOAD_CEILING_RUN_ID"];
  if (runId === undefined || runId.trim() === "") {
    console.error("workload-ceiling-validate-smoke: requires WORKLOAD_CEILING_RUN_ID");
    return 1;
  }

  const outDir =
    process.env["WORKLOAD_CEILING_OUT_DIR"] ?? "bench/results/workload-ceiling/smoke-control";
  const eventPath = `${outDir}/event-${runId}.json`;

  let raw: string;
  try {
    raw = await readFile(eventPath, "utf8");
  } catch {
    console.error(`workload-ceiling-validate-smoke: cannot read ${eventPath}`);
    return 1;
  }

  let event: WorkloadCeilingRawEvent;
  try {
    event = decodeWorkloadCeilingRawEvent(raw);
  } catch (error) {
    console.error(
      `workload-ceiling-validate-smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const validations = validateWorkloadCeilingRawEvent(event);
  const failed = validations.filter((v) => !v.passed);
  if (failed.length > 0) {
    console.error("workload-ceiling-validate-smoke: validation failures:");
    for (const f of failed) {
      console.error(`  - ${f.field}: ${f.message}`);
    }
    return 1;
  }

  console.log(`workload-ceiling-validate-smoke: all ${validations.length} validations passed`);
  console.log(`  run_id: ${event.run_id}`);
  console.log(`  scenario_id: ${event.scenario_id}`);
  console.log(`  outcome: ${event.outcome}`);
  console.log(`  cpu_ms: ${event.cpu_ms}`);
  console.log(`  colo: ${event.colo}`);
  return 0;
}

await runAsCliEntrypoint(import.meta.url, main);

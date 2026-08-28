/**
 * Raw event collection for the deployed workload-ceiling study (parent plan
 * Task 8 Step 6).
 *
 * Evidence-contract v2 queries TWO platform telemetry sources per invocation
 * and records field-level provenance for both:
 *
 *  - **Workers Observability** (the authority for invocation existence and
 *    execution outcome): the
 *    `/accounts/:id/workers/observability/telemetry/query` events view over
 *    the invocation's collection window, filtered to the fixed study
 *    `scriptName` (see `bench/workload-ceiling-worker/README.md` §"Join
 *    mechanism"). One authoritative record per invocation is assembled from
 *    two Observability events sharing a platform `requestId`: the Worker's
 *    own join line (carrying `workload_ceiling_run_id`) and the platform
 *    fetch-summary line (carrying `outcome`, `cpuTimeMs`, `scriptVersion`,
 *    `colo`, `responseStatus`). A window that yields zero join lines, more
 *    than one, or an ambiguous summary produces a `missing` or `ambiguous`
 *    evidence status — never a guess.
 *  - **`workersInvocationsAdaptive`** (the CPU measurement): the GraphQL
 *    Analytics API, bounded by the same window. A missing, multi-row, or
 *    multi-request-aggregate row is CPU-measurement missingness
 *    (`cpu_source: "none"`), never an execution failure.
 *
 * Both UNMODIFIED responses are stored before deriving the strict
 * `WorkloadCeilingRawEvent`. Live validation of both response shapes is
 * recorded in `runbooks/lane-b-preflight.md` Q5; the account's Observability
 * responses redact request `authorization` headers, so retaining them raw
 * leaks no credential.
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
  cloudflareDeployCredsFilename,
  loadCloudflareDeployCredsWithEnvTier,
  resolveCloudflareTier,
} from "../../tests/fixtures/endpoint-creds.ts";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  canonicalizeWorkloadCeilingOutcome,
  decodeWorkloadCeilingRawEvent,
  encodeWorkloadCeilingRawEvent,
  unresolvedWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  WORKLOAD_CEILING_KNOWN_OUTCOMES,
  WORKLOAD_CEILING_THERMAL_CLASSES,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
  type WorkloadCeilingThermalClass,
} from "./workload-ceiling-harness.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const OBSERVABILITY_QUERY_PATH = "https://api.cloudflare.com/client/v4/accounts" as const;

/**
 * The single already-deployed Worker this Step 10 smoke run targets (see
 * `bench/workload-ceiling-worker/README.md` §"Join mechanism" and §"Token
 * scope"). A per-run uniquely-named deployment would disambiguate concurrent
 * or repeated invocations by `scriptName` alone; reusing one fixed name
 * means disambiguation for this one-off run rests entirely on the narrow
 * `WorkloadCeilingCollectWindow` bounding the single invocation. That's an
 * accepted narrowing for Task 8's single authorized smoke run — a later,
 * bulk multi-run study (out of this plan's scope) would need to restore
 * per-run uniqueness or another explicit correlation mechanism.
 */
export const WORKLOAD_CEILING_WORKER_NAME = "baerly-storage";

export interface WorkloadCeilingCollectWindow {
  readonly gte: string;
  readonly lt: string;
}

export interface WorkloadCeilingCollectInput {
  readonly accountTag: string;
  readonly apiToken: string;
  readonly window: WorkloadCeilingCollectWindow;
  readonly fetchImpl?: typeof fetch;
}

// Cloudflare's Analytics GraphQL schema is nonstandard: it defines a
// lowercase `string` scalar and its documented examples use
// `$accountTag: string!` verbatim. `Time` is likewise their custom scalar.
// Field names here (`cpuTimeUs`, `requests`) were confirmed live via
// GraphQL schema introspection during the Step 10 smoke run — the dataset
// docs the README links use `cpuTime`, but that field does not exist on
// the live `AccountWorkersInvocationsAdaptiveSum` schema.
const WORKERS_INVOCATIONS_QUERY = `
  query WorkloadCeilingInvocations(
    $accountTag: string!
    $scriptName: string!
    $gte: Time!
    $lt: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10
          filter: { scriptName: $scriptName, datetime_geq: $gte, datetime_lt: $lt }
        ) {
          dimensions {
            datetime
            scriptName
            scriptVersion
            status
            coloCode
          }
          sum {
            cpuTimeUs
            requests
          }
        }
      }
    }
  }
`;

/** The one HTTP call to the official platform telemetry source. Returns the response UNPARSED-into-any-study-shape — callers persist it verbatim before deriving anything. */
export const queryWorkersInvocationsAdaptive = async (
  input: WorkloadCeilingCollectInput,
): Promise<unknown> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: WORKERS_INVOCATIONS_QUERY,
      variables: {
        accountTag: input.accountTag,
        scriptName: WORKLOAD_CEILING_WORKER_NAME,
        gte: input.window.gte,
        lt: input.window.lt,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`workers invocations query failed with HTTP ${response.status}: ${text}`);
  }

  const body: unknown = await response.json();

  // GraphQL errors arrive as HTTP 200 with {errors: [...], data: null}.
  // A successful response still includes the `errors` key, set to `null`
  // (not omitted), so the guard must tolerate both absent and null.
  const errors = (body as { errors?: unknown[] | null })?.errors;
  if (errors != null && errors.length > 0) {
    throw new Error(`GraphQL query returned errors: ${JSON.stringify(errors)}`);
  }

  return body;
};

/**
 * The one HTTP call to Workers Observability — the study's AUTHORITY for
 * invocation existence and execution outcome. Returns the response body
 * unparsed — callers persist it verbatim before deriving anything.
 *
 * Request shape (validated live over the 2026-08-24 rehearsal window; field
 * provenance in `runbooks/lane-b-preflight.md` Q5): the `events` view of the
 * `cloudflare-workers` dataset, filtered to the fixed study service, over a
 * timeframe in epoch milliseconds. Per-invocation records arrive as TWO
 * events sharing a platform `requestId`:
 *
 *  - the Worker's join line, carrying `workload_ceiling_run_id` (and the
 *    other `workload_ceiling_*` fields) under `source`, and
 *  - the platform fetch-summary line, carrying `$workers.outcome`,
 *    `$workers.cpuTimeMs` (integer ms), `$workers.scriptVersion.id`,
 *    `$workers.event.request.cf.colo`, and
 *    `$workers.event.response.status`.
 *
 * `authorization` request headers come back redacted (`"********"`), so the
 * retained raw response carries no credential.
 */
export const queryWorkersObservability = async (
  input: WorkloadCeilingCollectInput,
): Promise<unknown> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${OBSERVABILITY_QUERY_PATH}/${input.accountTag}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        queryId: "workload-ceiling-collect",
        timeframe: {
          from: Date.parse(input.window.gte),
          to: Date.parse(input.window.lt),
        },
        parameters: {
          datasets: ["cloudflare-workers"],
          filters: [
            {
              key: "$metadata.service",
              operation: "eq",
              value: WORKLOAD_CEILING_WORKER_NAME,
              type: "string",
            },
          ],
        },
        view: "events",
        limit: 200,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`observability query failed with HTTP ${response.status}: ${text}`);
  }

  const body = (await response.json()) as { success?: unknown; errors?: unknown };
  // The REST envelope reports failures as HTTP 200 with success:false. A
  // scope or auth failure must throw, not read downstream as "no events" —
  // which would mark every invocation in the window as evidence-missing.
  if (body?.success !== true) {
    throw new Error(`observability query failed: ${JSON.stringify(body?.errors ?? body)}`);
  }

  return body;
};

interface GraphQlInvocationRow {
  readonly dimensions: {
    readonly datetime: string;
    readonly scriptName: string;
    readonly scriptVersion: string;
    readonly status: string;
    readonly coloCode: string;
  };
  readonly sum: { readonly cpuTimeUs: number; readonly requests: number };
}

/**
 * Extracts the invocation rows from the GraphQL envelope, or `[]` for any
 * shape this reader does not recognize — never throws on a malformed or
 * empty response, because the caller's job at that point is to represent
 * the invocation as unresolved, not to crash the collection run.
 */
function extractRows(response: unknown): readonly GraphQlInvocationRow[] {
  const rows =
    (
      response as {
        readonly data?: {
          readonly viewer?: {
            readonly accounts?: readonly {
              readonly workersInvocationsAdaptive?: readonly unknown[];
            }[];
          };
        };
      }
    )?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return rows.filter((row): row is GraphQlInvocationRow => {
    const r = row as Partial<GraphQlInvocationRow> | null;
    return (
      r !== null &&
      typeof r === "object" &&
      typeof r.dimensions?.datetime === "string" &&
      typeof r.dimensions.scriptName === "string" &&
      typeof r.dimensions.scriptVersion === "string" &&
      typeof r.dimensions.status === "string" &&
      typeof r.dimensions.coloCode === "string" &&
      typeof r.sum?.cpuTimeUs === "number" &&
      typeof r.sum?.requests === "number"
    );
  });
}

export interface ExtractWorkloadCeilingRawEventInput {
  /** The unmodified Workers Observability query response (the authority). */
  readonly observabilityResponse: unknown;
  /** The unmodified GraphQL `workersInvocationsAdaptive` response (the CPU source). */
  readonly adaptiveResponse: unknown;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly compatibility_date: string;
  readonly window: WorkloadCeilingCollectWindow;
  readonly observed_at: string;
  /**
   * The invocation's warm/cold classification, supplied by whoever performed
   * the invocation — the Worker's own `isolate_cold` flag, relayed by the
   * capture runner. Absent means the caller genuinely does not know (a manual
   * `curl`, or the Lane A smoke), and `"unknown"` is recorded honestly rather
   * than guessed. The platform's telemetry carries no cold-start marker, so
   * this is the only place a real classification can enter the study.
   */
  readonly thermal_class?: WorkloadCeilingThermalClass;
}

/** Pulls the events array out of an Observability response, or `[]` for any shape this reader does not recognize. */
function extractObservabilityEvents(response: unknown): readonly unknown[] {
  const events = (
    response as {
      readonly result?: { readonly events?: { readonly events?: unknown } };
    }
  )?.result?.events?.events;
  return Array.isArray(events) ? (events as readonly unknown[]) : [];
}

const observabilityRequestId = (event: unknown): string | undefined => {
  const workers = (event as { readonly $workers?: { readonly requestId?: unknown } })?.$workers;
  const metadata = (event as { readonly $metadata?: { readonly requestId?: unknown } })?.$metadata;
  for (const candidate of [workers?.requestId, metadata?.requestId]) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return undefined;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const isKnownOutcome = (outcome: string): boolean =>
  (WORKLOAD_CEILING_KNOWN_OUTCOMES as readonly string[]).includes(outcome);

/**
 * Pure. Derives one strict `WorkloadCeilingRawEvent` from the two unmodified
 * platform responses.
 *
 * The authoritative record is assembled from the Workers Observability events
 * in the window: exactly one join line carrying the run id, joined by platform
 * `requestId` to exactly one fetch-summary line. Zero join lines (or a join
 * line with no summary) is evidence `missing`; duplicates or a summary line
 * missing required fields is evidence `ambiguous` — never a guess at which
 * line was "the" invocation, and never an invented outcome.
 *
 * The CPU number comes from the adaptive dataset only: a window holding
 * exactly one single-request row yields `cpu_ms` (µs → ms); anything else is
 * CPU-measurement missingness (`cpu_source: "none"`), which is NOT an
 * execution failure. When both sources report a KNOWN canonical outcome and
 * the literals disagree, the evidence is `ambiguous` — the disagreement
 * means at least one source is wrong about the invocation. An unrecognized
 * outcome literal is not a divergence: it passes through uncanonicalized and
 * reads as non-success, the conservative direction for a zero-failure claim.
 */
export function extractWorkloadCeilingRawEvent(
  input: ExtractWorkloadCeilingRawEventInput,
): WorkloadCeilingRawEvent {
  const runtimePeriod = `${input.window.gte}/${input.window.lt}`;
  const base = {
    run_id: input.run_id,
    scenario_id: input.scenario_id,
    compatibility_date: input.compatibility_date,
    runtime_period: runtimePeriod,
    thermal_class: input.thermal_class ?? ("unknown" satisfies WorkloadCeilingThermalClass),
    observed_at: input.observed_at,
  };

  const unresolved = (status: "missing" | "ambiguous", detail: string): WorkloadCeilingRawEvent =>
    unresolvedWorkloadCeilingRawEvent({ status, detail, ...base });

  // --- Authority: Workers Observability -------------------------------------
  const obsEvents = extractObservabilityEvents(input.observabilityResponse);
  const joinLines = obsEvents.filter(
    (event) =>
      nonEmptyString(
        (event as { readonly source?: { readonly workload_ceiling_run_id?: unknown } })?.source
          ?.workload_ceiling_run_id,
      ) === input.run_id,
  );
  if (joinLines.length === 0) {
    return unresolved("missing", "no workers-observability join line for run_id in window");
  }
  if (joinLines.length > 1) {
    return unresolved(
      "ambiguous",
      `${joinLines.length} join lines carry this run_id in one window`,
    );
  }
  const requestId = observabilityRequestId(joinLines[0]);
  if (requestId === undefined) {
    return unresolved("ambiguous", "join line carries no requestId to join its summary by");
  }
  const summaryLines = obsEvents.filter(
    (event) =>
      observabilityRequestId(event) === requestId &&
      nonEmptyString(
        (event as { readonly $workers?: { readonly outcome?: unknown } })?.$workers?.outcome,
      ) !== undefined,
  );
  if (summaryLines.length === 0) {
    return unresolved(
      "missing",
      "join line present but no invocation summary line shares its requestId",
    );
  }
  if (summaryLines.length > 1) {
    return unresolved(
      "ambiguous",
      `${summaryLines.length} invocation summary lines share one requestId`,
    );
  }
  const summary = (summaryLines[0] as { readonly $workers?: Record<string, unknown> })?.$workers;
  const authoritativeOutcome = nonEmptyString(summary?.["outcome"]);
  const scriptVersion = nonEmptyString(
    (summary?.["scriptVersion"] as { readonly id?: unknown } | undefined)?.id,
  );
  const colo = nonEmptyString(
    (summary?.["event"] as { readonly request?: { readonly cf?: { readonly colo?: unknown } } })
      ?.request?.cf?.colo,
  );
  if (authoritativeOutcome === undefined || scriptVersion === undefined || colo === undefined) {
    return unresolved(
      "ambiguous",
      "invocation summary line is missing outcome, scriptVersion, or colo",
    );
  }
  const rawCpuMs = summary?.["cpuTimeMs"];
  const authoritativeCpuMs =
    typeof rawCpuMs === "number" && Number.isFinite(rawCpuMs) && rawCpuMs >= 0 ? rawCpuMs : null;
  const rawResponseStatus = (
    summary?.["event"] as { readonly response?: { readonly status?: unknown } }
  )?.response?.status;
  const responseStatus =
    typeof rawResponseStatus === "number" &&
    Number.isInteger(rawResponseStatus) &&
    rawResponseStatus >= 100 &&
    rawResponseStatus <= 599
      ? rawResponseStatus
      : null;
  const canonicalOutcome = canonicalizeWorkloadCeilingOutcome(authoritativeOutcome);

  // --- CPU measurement: workersInvocationsAdaptive --------------------------
  const adaptiveRows = extractRows(input.adaptiveResponse);
  const usableAdaptiveRow =
    adaptiveRows.length === 1 && adaptiveRows[0]!.sum.requests === 1 ? adaptiveRows[0]! : undefined;
  if (usableAdaptiveRow !== undefined) {
    const adaptiveOutcome = canonicalizeWorkloadCeilingOutcome(usableAdaptiveRow.dimensions.status);
    if (
      adaptiveOutcome !== canonicalOutcome &&
      isKnownOutcome(adaptiveOutcome) &&
      isKnownOutcome(canonicalOutcome)
    ) {
      return unresolved(
        "ambiguous",
        `outcome divergence: observability reports "${authoritativeOutcome}" but the adaptive row reports "${usableAdaptiveRow.dimensions.status}"`,
      );
    }
  }

  return {
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
    ...base,
    script_version: scriptVersion,
    colo,
    outcome: canonicalOutcome,
    cpu_ms: usableAdaptiveRow === undefined ? null : usableAdaptiveRow.sum.cpuTimeUs / 1000,
    observed_at: input.observed_at,
    evidence: {
      status: "resolved",
      detail: null,
      authority: "workers-observability",
      authoritative_outcome: authoritativeOutcome,
      authoritative_cpu_ms: authoritativeCpuMs,
      authoritative_response_status: responseStatus,
      cpu_source: usableAdaptiveRow === undefined ? "none" : "workers-invocations-adaptive",
      cpu_outcome_verbatim:
        usableAdaptiveRow === undefined ? null : usableAdaptiveRow.dimensions.status,
    },
  };
}

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:collect`). Takes the run's join
 * identifiers from the environment (it reads no provisioning report — the
 * `run_id` an operator passes here is the one
 * `workload-ceiling-provision.ts` printed), queries the platform, stores the
 * unmodified response, then the derived strict event.
 *
 * Required auth: `CF_API_TOKEN` + `CF_ACCOUNT_ID` env vars (the same source
 * variables `tests/integration/day-one-handshake.test.ts` reads — never
 * `wrangler login`), or, when either is unset, a repo-scoped
 * `credentials/cloudflare-deploy.json` (gitignored — see
 * {@link loadCloudflareDeployCreds}). The env vars win when both are
 * present, so a CI override never silently loses to a stale local file.
 * Required env: `WORKLOAD_CEILING_RUN_ID`, `WORKLOAD_CEILING_SCENARIO_ID`,
 * `WORKLOAD_CEILING_COMPATIBILITY_DATE`.
 * Optional: `WORKLOAD_CEILING_WINDOW_START` / `WORKLOAD_CEILING_WINDOW_END`
 * (RFC 3339; default to a 10-minute window ending now — see
 * {@link resolveCollectWindow}, which rejects an unparseable or inverted
 * window by name),
 * `WORKLOAD_CEILING_THERMAL_CLASS` (one of `warm`, `cold`, or `unknown`; defaults to `unknown`),
 * and `WORKLOAD_CEILING_OUT_DIR` (where `raw-*` / `event-*` are written; see
 * {@link resolveCollectOutDir} — set it per implementation so compare
 * receives two clean directories).
 */
const WORKLOAD_CEILING_COLLECT_DEFAULT_OUT_DIR = "bench/results/workload-ceiling";

/**
 * Pure. Resolves the directory this CLI writes `raw-<runId>.json` and
 * `event-<runId>.json` to. Unset (or blank) → the shared default above.
 *
 * `WORKLOAD_CEILING_OUT_DIR` exists because the runbook's smoke run
 * invokes the Worker once per implementation and
 * `workload-ceiling-compare.ts` joins TWO event directories — one per
 * side. Both implementations reuse the same `scenario_id`s, so collecting
 * both sides into the one default directory makes every scenario arrive
 * twice there and get evicted as a duplicate, leaving zero pairs. Each
 * invocation must route its artifacts to its own side's directory; this
 * resolver is the only place that routing is decided.
 */
export function resolveCollectOutDir(env: Record<string, string | undefined>): string {
  const outDir = env["WORKLOAD_CEILING_OUT_DIR"];
  return outDir !== undefined && outDir.trim() !== ""
    ? outDir
    : WORKLOAD_CEILING_COLLECT_DEFAULT_OUT_DIR;
}

// Blank-but-defined env values must fall through to the credentials file
// (or the usage error) — never pass validation as real credentials.
const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

/** Parses one operator-supplied window bound, naming the offending env var on rejection. */
const parseWindowBound = (name: string, value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new WorkloadCeilingHarnessError(
      name,
      `must be an RFC 3339 timestamp; got ${JSON.stringify(value)}`,
    );
  }
  return parsed.toISOString();
};

/**
 * Pure. Resolves the collection window, rejecting an unparseable operator-set
 * bound by name.
 *
 * Every other operator-supplied input to this CLI fails with an explicit,
 * named usage error, and these two must too. Unvalidated, a malformed
 * `WORKLOAD_CEILING_WINDOW_END` either reaches `new Date(NaN).toISOString()`
 * and throws a bare `RangeError: Invalid time value` naming nothing, or — with
 * `WINDOW_START` also set — passes a garbage timestamp straight into the
 * GraphQL query, where it comes back as a window that resolved no rows and
 * reads as a missed invocation rather than a typo. The runbook's whole
 * correctness argument rests on these two bounds, so they fail loud.
 */
export function resolveCollectWindow(
  env: Record<string, string | undefined>,
  now: Date,
): WorkloadCeilingCollectWindow {
  const rawEnd = env["WORKLOAD_CEILING_WINDOW_END"];
  const end = present(rawEnd)
    ? parseWindowBound("WORKLOAD_CEILING_WINDOW_END", rawEnd)
    : now.toISOString();
  const rawStart = env["WORKLOAD_CEILING_WINDOW_START"];
  const start = present(rawStart)
    ? parseWindowBound("WORKLOAD_CEILING_WINDOW_START", rawStart)
    : new Date(new Date(end).getTime() - 10 * 60_000).toISOString();
  if (new Date(start).getTime() >= new Date(end).getTime()) {
    throw new WorkloadCeilingHarnessError(
      "WORKLOAD_CEILING_WINDOW_START",
      `must be strictly before WORKLOAD_CEILING_WINDOW_END; got ${start} >= ${end}`,
    );
  }
  return { gte: start, lt: end };
}

async function main(): Promise<number> {
  const tier = resolveCloudflareTier();
  const deployCredsFilename = cloudflareDeployCredsFilename(tier);
  const deployCreds =
    !present(process.env["CF_API_TOKEN"]) || !present(process.env["CF_ACCOUNT_ID"])
      ? await loadCloudflareDeployCredsWithEnvTier()
      : null;
  const apiToken = present(process.env["CF_API_TOKEN"])
    ? process.env["CF_API_TOKEN"]
    : deployCreds?.api_token;
  const accountTag = present(process.env["CF_ACCOUNT_ID"])
    ? process.env["CF_ACCOUNT_ID"]
    : deployCreds?.account_id;
  const runId = process.env["WORKLOAD_CEILING_RUN_ID"];
  const scenarioId = process.env["WORKLOAD_CEILING_SCENARIO_ID"];
  const compatibilityDate = process.env["WORKLOAD_CEILING_COMPATIBILITY_DATE"];
  if (
    apiToken === undefined ||
    accountTag === undefined ||
    runId === undefined ||
    scenarioId === undefined ||
    compatibilityDate === undefined
  ) {
    console.error(
      `workload-ceiling-collect: requires CF_API_TOKEN + CF_ACCOUNT_ID ` +
        `(env vars or credentials/${deployCredsFilename}), plus ` +
        "WORKLOAD_CEILING_RUN_ID, WORKLOAD_CEILING_SCENARIO_ID, and " +
        "WORKLOAD_CEILING_COMPATIBILITY_DATE in the environment.\n" +
        `Set WORKLOAD_CEILING_TIER=free to use credentials/cloudflare-deploy-free.json ` +
        `instead of credentials/cloudflare-deploy.json.`,
    );
    return 1;
  }
  console.log(`workload-ceiling-collect: using ${tier} tier (credentials/${deployCredsFilename})`);

  const now = new Date();
  let window: WorkloadCeilingCollectWindow;
  try {
    window = resolveCollectWindow(process.env, now);
  } catch (error) {
    console.error(
      `workload-ceiling-collect: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const thermalClass = process.env["WORKLOAD_CEILING_THERMAL_CLASS"];
  if (
    thermalClass !== undefined &&
    !(WORKLOAD_CEILING_THERMAL_CLASSES as readonly string[]).includes(thermalClass)
  ) {
    console.error(
      `workload-ceiling-collect: WORKLOAD_CEILING_THERMAL_CLASS must be one of ` +
        `${WORKLOAD_CEILING_THERMAL_CLASSES.join(", ")}; got ${thermalClass}`,
    );
    return 1;
  }

  const observabilityResponse = await queryWorkersObservability({
    accountTag,
    apiToken,
    window,
  });
  const graphqlResponse = await queryWorkersInvocationsAdaptive({
    accountTag,
    apiToken,
    window,
  });

  const outDir = resolveCollectOutDir(process.env);
  await mkdir(outDir, { recursive: true });
  const rawObservabilityPath = `${outDir}/raw-obs-${runId}.json`;
  await writeFile(rawObservabilityPath, JSON.stringify(observabilityResponse, null, 2));
  console.log(`wrote unmodified observability response to ${rawObservabilityPath}`);
  const rawPath = `${outDir}/raw-${runId}.json`;
  await writeFile(rawPath, JSON.stringify(graphqlResponse, null, 2));
  console.log(`wrote unmodified adaptive response to ${rawPath}`);

  const event = extractWorkloadCeilingRawEvent({
    observabilityResponse,
    adaptiveResponse: graphqlResponse,
    run_id: runId,
    scenario_id: scenarioId,
    compatibility_date: compatibilityDate,
    window,
    observed_at: now.toISOString(),
    thermal_class: thermalClass as WorkloadCeilingThermalClass | undefined,
  });

  let encoded: string;
  try {
    encoded = encodeWorkloadCeilingRawEvent(event);
    // Round-trip through the strict decoder too, so a malformed event can
    // never reach disk under the name the compare step trusts.
    decodeWorkloadCeilingRawEvent(encoded);
  } catch (error) {
    const detail = error instanceof WorkloadCeilingHarnessError ? error.message : String(error);
    console.error(`workload-ceiling-collect: derived event failed strict validation: ${detail}`);
    return 1;
  }
  const eventPath = `${outDir}/event-${runId}.json`;
  await writeFile(eventPath, encoded);
  console.log(
    `wrote strict event to ${eventPath} (evidence=${event.evidence.status}, outcome=${String(event.outcome)}, cpu_ms=${String(event.cpu_ms)})`,
  );
  return 0;
}

// CLI entrypoint guard: `main()` runs only when this module is executed
// directly (`node --import ./bench/register-hooks.mjs …`), never when a test
// imports it — `CF_API_TOKEN`/`CF_ACCOUNT_ID` or a credentials file being
// present in the environment must not turn an import into a live network call.
await runAsCliEntrypoint(import.meta.url, main);

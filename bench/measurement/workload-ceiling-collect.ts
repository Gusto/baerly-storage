/**
 * Raw event collection for the deployed workload-ceiling study (parent plan
 * Task 8 Step 6).
 *
 * Queries the OFFICIAL platform telemetry source — the GraphQL Analytics
 * API's `workersInvocationsAdaptive` dataset — bounded by the study's fixed
 * `scriptName` (see `bench/workload-ceiling-worker/README.md` §"Join
 * mechanism") and an explicit, narrow time window. Stores the UNMODIFIED
 * response before deriving its strict `WorkloadCeilingRawEvent`, and
 * represents a collection window that closes without a matching row as an
 * explicit `missing-terminal-event` outcome rather than dropping the
 * invocation.
 *
 * Docs this rests on: `bench/workload-ceiling-worker/README.md` §"Platform
 * documentation this rests on" links the GraphQL Analytics API reference and
 * the `workersInvocationsAdaptive` dataset directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadCloudflareDeployCreds } from "../../tests/fixtures/endpoint-creds.ts";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  decodeWorkloadCeilingRawEvent,
  encodeWorkloadCeilingRawEvent,
  missingTerminalWorkloadCeilingRawEvent,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
  type WorkloadCeilingThermalClass,
} from "./workload-ceiling-harness.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

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
// Field names here (`cpuTime`, `requests`) follow the dataset docs the
// README links; the Step 10 smoke run verifies them live against the
// verbatim-persisted raw response.
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
            cpuTime
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

  // GraphQL errors arrive as HTTP 200 with {errors: [...], data: null}
  const errors = (body as { errors?: unknown[] })?.errors;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(`GraphQL query returned errors: ${JSON.stringify(errors)}`);
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
  readonly sum: { readonly cpuTime: number; readonly requests: number };
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
      typeof r.sum?.cpuTime === "number" &&
      typeof r.sum?.requests === "number"
    );
  });
}

export interface ExtractWorkloadCeilingRawEventInput {
  readonly graphqlResponse: unknown;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly compatibility_date: string;
  readonly window: WorkloadCeilingCollectWindow;
  readonly observed_at: string;
}

/**
 * Pure. Reduces one already-fetched GraphQL response to a strict
 * `WorkloadCeilingRawEvent`. Zero rows, more than one row, or a single
 * row aggregating more than one request are all treated the same way —
 * the collection window did not resolve to exactly one single-request
 * invocation — and become an explicit `missing-terminal-event`, never a
 * silently dropped run and never a guess at which of several rows was
 * "the" invocation.
 */
export function extractWorkloadCeilingRawEvent(
  input: ExtractWorkloadCeilingRawEventInput,
): WorkloadCeilingRawEvent {
  const rows = extractRows(input.graphqlResponse);
  const runtimePeriod = `${input.window.gte}/${input.window.lt}`;

  // Zero rows, more than one row, or multi-request aggregation → unresolved
  if (rows.length !== 1 || rows[0]!.sum.requests !== 1) {
    return missingTerminalWorkloadCeilingRawEvent({
      run_id: input.run_id,
      scenario_id: input.scenario_id,
      script_version: "unresolved",
      compatibility_date: input.compatibility_date,
      runtime_period: runtimePeriod,
      colo: "unknown",
      thermal_class: "unknown",
      observed_at: input.observed_at,
    });
  }

  const row = rows[0]!;
  return {
    run_id: input.run_id,
    scenario_id: input.scenario_id,
    script_version: row.dimensions.scriptVersion,
    compatibility_date: input.compatibility_date,
    runtime_period: runtimePeriod,
    colo: row.dimensions.coloCode,
    thermal_class: "unknown" satisfies WorkloadCeilingThermalClass,
    outcome: row.dimensions.status,
    // UNITS ASSUMPTION: `workersInvocationsAdaptive`'s `sum.cpuTime` is
    // reported in microseconds per the dataset documentation linked from
    // `bench/workload-ceiling-worker/README.md` §"Platform documentation
    // this rests on" (GraphQL Analytics API → workersInvocationsAdaptive
    // metrics), so /1000 reaches the ms this study reports everywhere
    // else. The Step 10 smoke run MUST cross-check this assumption against
    // the verbatim-persisted raw response (`raw-<runId>.json`) — a
    // milliseconds-reported field would make every cpu_ms 1000× too small —
    // before the study trusts any number derived from it.
    cpu_ms: row.sum.cpuTime / 1000,
    observed_at: input.observed_at,
  };
}

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:collect`). Reads a
 * provisioning report written by `workload-ceiling-provision.ts`, queries
 * the platform, stores the unmodified response, then the derived strict
 * event.
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
 * (RFC 3339; default to a 10-minute window ending now), and
 * `WORKLOAD_CEILING_OUT_DIR` (where `raw-*` / `event-*` are written; see
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

async function main(): Promise<number> {
  const deployCreds =
    !present(process.env["CF_API_TOKEN"]) || !present(process.env["CF_ACCOUNT_ID"])
      ? await loadCloudflareDeployCreds()
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
      "workload-ceiling-collect: requires CF_API_TOKEN + CF_ACCOUNT_ID " +
        "(env vars or credentials/cloudflare-deploy.json), plus " +
        "WORKLOAD_CEILING_RUN_ID, WORKLOAD_CEILING_SCENARIO_ID, and " +
        "WORKLOAD_CEILING_COMPATIBILITY_DATE in the environment.",
    );
    return 1;
  }

  const now = new Date();
  const windowEnd = process.env["WORKLOAD_CEILING_WINDOW_END"] ?? now.toISOString();
  const windowStart =
    process.env["WORKLOAD_CEILING_WINDOW_START"] ??
    new Date(new Date(windowEnd).getTime() - 10 * 60_000).toISOString();
  const window: WorkloadCeilingCollectWindow = { gte: windowStart, lt: windowEnd };

  const graphqlResponse = await queryWorkersInvocationsAdaptive({
    accountTag,
    apiToken,
    window,
  });

  const outDir = resolveCollectOutDir(process.env);
  await mkdir(outDir, { recursive: true });
  const rawPath = `${outDir}/raw-${runId}.json`;
  await writeFile(rawPath, JSON.stringify(graphqlResponse, null, 2));
  console.log(`wrote unmodified platform response to ${rawPath}`);

  const event = extractWorkloadCeilingRawEvent({
    graphqlResponse,
    run_id: runId,
    scenario_id: scenarioId,
    compatibility_date: compatibilityDate,
    window,
    observed_at: now.toISOString(),
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
    `wrote strict event to ${eventPath} (outcome=${event.outcome}, cpu_ms=${String(event.cpu_ms)})`,
  );
  return 0;
}

// CLI entrypoint guard: `main()` runs only when this module is executed
// directly (`node --import ./bench/register-hooks.mjs …`), never when a test
// imports it — `CF_API_TOKEN`/`CF_ACCOUNT_ID` or a credentials file being
// present in the environment must not turn an import into a live network call.
await runAsCliEntrypoint(import.meta.url, main);

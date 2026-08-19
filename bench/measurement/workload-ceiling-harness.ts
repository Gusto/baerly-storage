/**
 * Strict wire codecs for the deployed workload-ceiling evidence harness
 * (parent plan Task 8).
 *
 * Three shapes cross the trust boundary between the local measurement tooling
 * and the deployed study Worker:
 *
 *  - `WorkloadCeilingRunRequest` — what `workload-ceiling-provision.ts` /
 *    a future orchestrator sends to invoke one authenticated run against one
 *    exact fixture.
 *  - `WorkloadCeilingFixtureDescriptor` — the `fixture.json`
 *    `workload-ceiling-provision.ts` writes into the bucket and the Worker
 *    reads back to locate both representations of one fixture. It crosses the
 *    boundary through R2 rather than over HTTP, which makes a single codec
 *    here MORE load-bearing, not less: the two ends deploy independently, so
 *    a field renamed on the provisioning side would otherwise pass its own
 *    build and only surface as a runtime 502 from the deployed Worker.
 *  - `WorkloadCeilingRawEvent` — the strict normalized shape
 *    `workload-ceiling-collect.ts` derives from the official platform
 *    telemetry source. The Worker never emits this itself and never
 *    self-reports CPU (Task 8 Steps 5-6; see `bench/workload-ceiling-worker/README.md`
 *    for the platform documentation this rests on).
 *
 * Both codecs reject any field outside their exact set and round-trip
 * through `canonical-json.ts`'s sorted-key canonical form — the same
 * byte-stability discipline `snapshot-manifest.ts` / `snapshot-chunk.ts` use
 * for durable wire shapes, applied here to a measurement-only wire shape.
 *
 * This module is measurement-only: importing it changes no production
 * behavior and it is not reachable from `packages/server/src/index.ts`.
 */
import { canonicalJson, type CanonicalJsonValue } from "./canonical-json.ts";

export const WORKLOAD_CEILING_CONTRACT_ID = "baerly.workload-ceiling/chunked-snapshot/v1" as const;

/**
 * The ONE R2 bucket both ends of the study must agree on.
 *
 * `bench/workload-ceiling-worker/wrangler.jsonc` binds `env.BUCKET` to this
 * name, and `workload-ceiling-provision.ts` writes fixtures to whatever
 * `credentials/cloudflare.json` names. Those are configured independently, and
 * a mismatch is silent at provisioning time and unrecognizable at run time —
 * every `POST /run` returns a 502 `fixture descriptor is missing`, which reads
 * as a provisioning bug rather than a bucket-name mismatch. This constant is
 * what `workload-ceiling-provision.ts` preflights the credentials file
 * against, so the mismatch fails loudly before anything is written. Wrangler
 * config is JSONC and cannot import it — the name is repeated there under a
 * comment pointing back here.
 */
export const WORKLOAD_CEILING_BUCKET_NAME = "baerly-storage-eval" as const;

export const WORKLOAD_CEILING_IMPLEMENTATIONS = [
  "monolithic-control",
  "chunked-candidate",
] as const;
export type WorkloadCeilingImplementation = (typeof WORKLOAD_CEILING_IMPLEMENTATIONS)[number];

export interface WorkloadCeilingRunRequest {
  readonly contract_id: typeof WORKLOAD_CEILING_CONTRACT_ID;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly fixture_prefix: string;
}

export const WORKLOAD_CEILING_THERMAL_CLASSES = ["warm", "cold", "unknown"] as const;
export type WorkloadCeilingThermalClass = (typeof WORKLOAD_CEILING_THERMAL_CLASSES)[number];

/**
 * Known outcome strings this harness gives special handling to. `outcome`
 * on the wire (see {@link WorkloadCeilingRawEvent}) is a plain `string`, not
 * a union of this list — the platform's own invocation-outcome vocabulary
 * (linked from the harness Worker README) is not this repo's to close over,
 * and a future outcome string must still decode. Two entries are load-bearing
 * here regardless:
 *
 *  - `"exceededCpu"` — reproduced verbatim from the platform's own
 *    vocabulary so a study reader can grep the platform docs for the exact
 *    string; this module never remaps or drops it.
 *  - `"missing-terminal-event"` — not a platform outcome. It is what
 *    `workload-ceiling-collect.ts` records when the bounded collection
 *    window closes without a matching terminal telemetry row, so an
 *    unresolved invocation is an explicit study outcome instead of a
 *    silently dropped run.
 */
export const WORKLOAD_CEILING_KNOWN_OUTCOMES = [
  "ok",
  "exceededCpu",
  "exceededMemory",
  "scriptThrewException",
  "responseStreamDisconnected",
  "missing-terminal-event",
] as const;
export type WorkloadCeilingKnownOutcome = (typeof WORKLOAD_CEILING_KNOWN_OUTCOMES)[number];

export interface WorkloadCeilingRawEvent {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly script_version: string;
  readonly compatibility_date: string;
  readonly runtime_period: string;
  readonly colo: string;
  readonly thermal_class: WorkloadCeilingThermalClass;
  readonly outcome: string;
  readonly cpu_ms: number | null;
  readonly observed_at: string;
}

/**
 * Invalid input to a harness codec. Assert on `code`, never on `message`
 * (repo test convention: docs/contributing/conventions/tests.md §"Asserting
 * on errors").
 */
export class WorkloadCeilingHarnessError extends Error {
  readonly code = "WorkloadCeilingHarnessInvalid" as const;
  readonly field: string;
  constructor(field: string, detail: string, cause?: unknown) {
    super(
      `bench/measurement/workload-ceiling-harness: invalid ${field} — ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "WorkloadCeilingHarnessError";
    this.field = field;
  }
}

function invalid(field: string, detail: string, cause?: unknown): never {
  throw new WorkloadCeilingHarnessError(field, detail, cause);
}

function assertExactFields(
  value: unknown,
  fields: readonly string[],
  where: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(where, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(where, "must be a plain object");
  }
  const expected = new Set(fields);
  const seen = new Set<string>();
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      invalid(where, `unknown field ${key}`);
    }
    seen.add(key);
  }
  for (const field of fields) {
    if (!seen.has(field)) {
      invalid(where, `missing field ${field}`);
    }
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(field, "must be a nonempty string");
  }
}

/** Round-trips `value` through the harness's canonical serialization and returns the bytes. */
function toCanonicalJson(value: CanonicalJsonValue, where: string): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    invalid(where, "is not representable as canonical JSON", error);
  }
}

function parseJson(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    invalid(where, "is not valid JSON", error);
  }
}

const RUN_REQUEST_FIELDS = [
  "contract_id",
  "run_id",
  "scenario_id",
  "implementation",
  "fixture_prefix",
] as const;

function canonicalizeRunRequest(value: unknown): WorkloadCeilingRunRequest {
  assertExactFields(value, RUN_REQUEST_FIELDS, "run request");
  if (value["contract_id"] !== WORKLOAD_CEILING_CONTRACT_ID) {
    invalid("contract_id", `must be ${WORKLOAD_CEILING_CONTRACT_ID}`);
  }
  assertNonEmptyString(value["run_id"], "run_id");
  assertNonEmptyString(value["scenario_id"], "scenario_id");
  const implementation = value["implementation"];
  if (!(WORKLOAD_CEILING_IMPLEMENTATIONS as readonly unknown[]).includes(implementation)) {
    invalid(
      "implementation",
      `must be one of ${WORKLOAD_CEILING_IMPLEMENTATIONS.join(", ")}; got ${String(implementation)}`,
    );
  }
  assertNonEmptyString(value["fixture_prefix"], "fixture_prefix");
  const fixturePrefix = value["fixture_prefix"];
  if (
    fixturePrefix.startsWith("/") ||
    fixturePrefix.endsWith("/") ||
    fixturePrefix.includes("//") ||
    fixturePrefix.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    invalid("fixture_prefix", "must be a clean relative key prefix");
  }
  return {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    run_id: value["run_id"],
    scenario_id: value["scenario_id"],
    implementation: implementation as WorkloadCeilingImplementation,
    fixture_prefix: fixturePrefix,
  };
}

/** Canonical-JSON-serializes a validated request. Rejects a request outside the exact field set. */
export const encodeWorkloadCeilingRunRequest = (request: WorkloadCeilingRunRequest): string => {
  const canonical = canonicalizeRunRequest(request);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "run request");
};

/**
 * Decodes and validates a `WorkloadCeilingRunRequest`. Rejects any field
 * outside the exact set, an invalid `implementation`, and any body whose
 * bytes are not already the canonical serialization of its own parsed
 * value (RFC 8785 sorted-key form via `canonical-json.ts`).
 */
export const decodeWorkloadCeilingRunRequest = (raw: string): WorkloadCeilingRunRequest => {
  const parsed = parseJson(raw, "run request body");
  const canonical = canonicalizeRunRequest(parsed);
  const canonicalRaw = toCanonicalJson(canonical as unknown as CanonicalJsonValue, "run request");
  if (canonicalRaw !== raw) {
    invalid("run request body", "is not canonical JSON");
  }
  return canonical;
};

/**
 * The `fixture.json` descriptor `workload-ceiling-provision.ts` writes at
 * `<fixture_prefix>/fixture.json`, and the only thing the deployed Worker
 * reads to find the two representations of one provisioned fixture.
 */
export interface WorkloadCeilingFixtureDescriptor {
  readonly contract_id: typeof WORKLOAD_CEILING_CONTRACT_ID;
  readonly collection: string;
  /** Key of the single-blob control representation. */
  readonly monolithic_key: string;
  /** Key of the manifest heading the candidate chunk layout. */
  readonly manifest_key: string;
  readonly log_seq_start: number;
}

const FIXTURE_DESCRIPTOR_FIELDS = [
  "contract_id",
  "collection",
  "monolithic_key",
  "manifest_key",
  "log_seq_start",
] as const;

function canonicalizeFixtureDescriptor(value: unknown): WorkloadCeilingFixtureDescriptor {
  assertExactFields(value, FIXTURE_DESCRIPTOR_FIELDS, "fixture descriptor");
  if (value["contract_id"] !== WORKLOAD_CEILING_CONTRACT_ID) {
    invalid("contract_id", `must be ${WORKLOAD_CEILING_CONTRACT_ID}`);
  }
  assertNonEmptyString(value["collection"], "collection");
  assertNonEmptyString(value["monolithic_key"], "monolithic_key");
  assertNonEmptyString(value["manifest_key"], "manifest_key");
  const logSeqStart = value["log_seq_start"];
  if (typeof logSeqStart !== "number" || !Number.isSafeInteger(logSeqStart) || logSeqStart < 0) {
    invalid("log_seq_start", "must be a non-negative safe integer");
  }
  return {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    collection: value["collection"],
    monolithic_key: value["monolithic_key"],
    manifest_key: value["manifest_key"],
    log_seq_start: logSeqStart,
  };
}

/** Canonical-JSON-serializes a validated fixture descriptor. Rejects a field outside the exact set. */
export const encodeWorkloadCeilingFixtureDescriptor = (
  descriptor: WorkloadCeilingFixtureDescriptor,
): string => {
  const canonical = canonicalizeFixtureDescriptor(descriptor);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "fixture descriptor");
};

/**
 * Decodes and validates a `WorkloadCeilingFixtureDescriptor` read back out of
 * the bucket. Enforces canonical bytes, which is what makes the
 * `descriptor_canonical_hash` the provisioning report persists meaningful
 * end-to-end: the Worker will only accept the exact bytes that hash covers.
 */
export const decodeWorkloadCeilingFixtureDescriptor = (
  raw: string,
): WorkloadCeilingFixtureDescriptor => {
  const parsed = parseJson(raw, "fixture descriptor body");
  const canonical = canonicalizeFixtureDescriptor(parsed);
  const canonicalRaw = toCanonicalJson(
    canonical as unknown as CanonicalJsonValue,
    "fixture descriptor",
  );
  if (canonicalRaw !== raw) {
    invalid("fixture descriptor body", "is not canonical JSON");
  }
  return canonical;
};

/** The key `workload-ceiling-provision.ts` writes the descriptor to and the Worker reads it from. */
export const workloadCeilingFixtureDescriptorKey = (fixturePrefix: string): string =>
  `${fixturePrefix}/fixture.json`;

const RAW_EVENT_FIELDS = [
  "run_id",
  "scenario_id",
  "script_version",
  "compatibility_date",
  "runtime_period",
  "colo",
  "thermal_class",
  "outcome",
  "cpu_ms",
  "observed_at",
] as const;

const OBSERVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function canonicalizeRawEvent(value: unknown): WorkloadCeilingRawEvent {
  assertExactFields(value, RAW_EVENT_FIELDS, "raw event");
  assertNonEmptyString(value["run_id"], "run_id");
  assertNonEmptyString(value["scenario_id"], "scenario_id");
  assertNonEmptyString(value["script_version"], "script_version");
  assertNonEmptyString(value["compatibility_date"], "compatibility_date");
  assertNonEmptyString(value["runtime_period"], "runtime_period");
  assertNonEmptyString(value["colo"], "colo");
  const thermalClass = value["thermal_class"];
  if (!(WORKLOAD_CEILING_THERMAL_CLASSES as readonly unknown[]).includes(thermalClass)) {
    invalid(
      "thermal_class",
      `must be one of ${WORKLOAD_CEILING_THERMAL_CLASSES.join(", ")}; got ${String(thermalClass)}`,
    );
  }
  assertNonEmptyString(value["outcome"], "outcome");
  const outcome = value["outcome"];
  const cpuMs = value["cpu_ms"];
  if (cpuMs !== null && (typeof cpuMs !== "number" || !Number.isFinite(cpuMs) || cpuMs < 0)) {
    invalid("cpu_ms", "must be null or a finite non-negative number");
  }
  // No synthesized CPU: an "ok" invocation always carries the platform's own
  // telemetry number, never a null this module would otherwise have to fill
  // in; a "missing-terminal-event" record can never carry a number, because
  // nothing genuine produced one — a non-null value there would be exactly
  // the fabricated evidence this codec exists to refuse.
  if (outcome === "ok" && cpuMs === null) {
    invalid("cpu_ms", 'must be a finite number when outcome is "ok"');
  }
  if (outcome === "missing-terminal-event" && cpuMs !== null) {
    invalid("cpu_ms", 'must be null when outcome is "missing-terminal-event"');
  }
  assertNonEmptyString(value["observed_at"], "observed_at");
  const observedAt = value["observed_at"];
  if (!OBSERVED_AT_PATTERN.test(observedAt)) {
    invalid("observed_at", "must be an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z)");
  }
  return {
    run_id: value["run_id"],
    scenario_id: value["scenario_id"],
    script_version: value["script_version"],
    compatibility_date: value["compatibility_date"],
    runtime_period: value["runtime_period"],
    colo: value["colo"],
    thermal_class: thermalClass as WorkloadCeilingThermalClass,
    outcome,
    cpu_ms: cpuMs,
    observed_at: observedAt,
  };
}

/** Canonical-JSON-serializes a validated raw event. Rejects a field outside the exact set. */
export const encodeWorkloadCeilingRawEvent = (event: WorkloadCeilingRawEvent): string => {
  const canonical = canonicalizeRawEvent(event);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "raw event");
};

/**
 * Decodes and validates a `WorkloadCeilingRawEvent` from an unmodified
 * platform response that `workload-ceiling-collect.ts` has already reduced
 * to one candidate JSON record. Preserves `exceededCpu` and
 * `missing-terminal-event` as explicit outcomes rather than collapsing them,
 * and never derives `cpu_ms` — it is required on the wire and passed
 * through unchanged.
 */
export const decodeWorkloadCeilingRawEvent = (raw: string): WorkloadCeilingRawEvent => {
  const parsed = parseJson(raw, "raw event body");
  const canonical = canonicalizeRawEvent(parsed);
  const canonicalRaw = toCanonicalJson(canonical as unknown as CanonicalJsonValue, "raw event");
  if (canonicalRaw !== raw) {
    invalid("raw event body", "is not canonical JSON");
  }
  return canonical;
};

/** Builds the strict raw-event record for an invocation the collection window never resolved. */
export const missingTerminalWorkloadCeilingRawEvent = (input: {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly script_version: string;
  readonly compatibility_date: string;
  readonly runtime_period: string;
  readonly colo: string;
  readonly thermal_class: WorkloadCeilingThermalClass;
  readonly observed_at: string;
}): WorkloadCeilingRawEvent =>
  canonicalizeRawEvent({
    ...input,
    outcome: "missing-terminal-event",
    cpu_ms: null,
  });

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
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";

export const WORKLOAD_CEILING_CONTRACT_ID = "baerly.workload-ceiling/chunked-snapshot/v1" as const;

/**
 * The revision of the per-invocation EVIDENCE artifacts — the strict raw
 * event codec, the derived events, and the axis reports built from them.
 *
 * Distinct from {@link WORKLOAD_CEILING_CONTRACT_ID}, which versions the
 * wire shapes the deployed Worker itself validates (run request, fixture
 * descriptor); those did not change. This one changed for the evidence
 * contract v2 amendment, which separates three previously conflated
 * concepts — Worker execution outcome, evidence completeness, and
 * CPU-sample completeness — after the 2026-08-24 rehearsal showed
 * `workersInvocationsAdaptive` permanently dropping rows for invocations
 * that Workers Observability recorded in full.
 *
 * Every raw event carries this identifier on the wire, so a v1-era event
 * file (which has no such field) fails the strict decode and can never be
 * silently aggregated with v2 artifacts.
 */
export const WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID = "baerly.workload-ceiling/evidence/v2" as const;

/** Whether the AUTHORITATIVE per-invocation record resolved. Collection status, never an execution outcome. */
export type WorkloadCeilingEvidenceStatus = "resolved" | "missing" | "ambiguous";

/**
 * Field-level telemetry provenance for one collected invocation, plus the
 * evidence status of its authoritative record.
 *
 * Evidence contract v2 splits telemetry authority:
 *
 *  - **Workers Observability** is the authority for invocation EXISTENCE and
 *    EXECUTION OUTCOME. One correlatable record per invocation is assembled
 *    from two Observability events sharing a platform `requestId` — the
 *    Worker's own join line (carrying `workload_ceiling_run_id`) and the
 *    platform fetch-summary line (carrying `outcome`, `cpuTimeMs`,
 *    `scriptVersion`, `colo`, `responseStatus`). Live validation over the
 *    2026-08-24 rehearsal window joined 24/24 invocations this way,
 *    including the two invocations whose `workersInvocationsAdaptive` rows
 *    never landed.
 *  - **`workersInvocationsAdaptive`** owns the CPU MEASUREMENT
 *    (`sum.cpuTimeUs`, microsecond resolution). That dataset demonstrably
 *    drops rows permanently (~15 % on the study account), which is
 *    CPU-measurement missingness — never an execution failure — and is
 *    gated separately by the preregistered CPU sample floor.
 */
export interface WorkloadCeilingEvidenceBlock {
  /** Status of the authoritative (Workers Observability) record for this invocation. */
  readonly status: WorkloadCeilingEvidenceStatus;
  /** Why the record did not resolve; `null` exactly when `status === "resolved"`. */
  readonly detail: string | null;
  /** The platform API that supplied the authoritative record. */
  readonly authority: "workers-observability";
  /** Verbatim authoritative outcome literal (`"ok"`, `"exceededCpu"`, …); `null` when unresolved. */
  readonly authoritative_outcome: string | null;
  /**
   * Observability's own `cpuTimeMs` — integer milliseconds, i.e. coarser than
   * the adaptive dataset's `cpuTimeUs`. Retained as cross-check provenance
   * only; it never enters a quantile.
   */
  readonly authoritative_cpu_ms: number | null;
  /** HTTP response status the authority observed (cross-check against the journal's `http_status`). */
  readonly authoritative_response_status: number | null;
  /** Which dataset supplied the event's `cpu_ms`. */
  readonly cpu_source: "workers-invocations-adaptive" | "none";
  /** Verbatim Analytics status literal of the row `cpu_ms` came from; `null` when no row. */
  readonly cpu_outcome_verbatim: string | null;
}

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

/**
 * The arms one deployed script serves, selected per request.
 *
 * `monolithic-control` and `chunked-candidate` are the two SUBJECTS the study
 * compares. `monolithic-control-unhashed` is neither: it is a measurement-only
 * probe that reads the identical bytes at the identical key as
 * `monolithic-control` and differs by exactly one operation — the SHA-256
 * digest verification `loadSnapshotAsMap` performs before parsing. Its only
 * purpose is to make the control's hash cost a difference of two
 * platform-reported CPU numbers, because a Worker may not time itself
 * (`bench/workload-ceiling-worker/README.md` §"Why CPU is never
 * self-reported").
 *
 * It must never be handed to `workload-ceiling-compare.ts` as a side. It is
 * not a candidate, it is not a control, and pairing it against either would
 * report a format comparison that was really a hash measurement.
 */
export const WORKLOAD_CEILING_IMPLEMENTATIONS = [
  "monolithic-control",
  "monolithic-control-unhashed",
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
 * Known CANONICAL outcome strings this harness gives special handling to.
 * `outcome` on the wire (see {@link WorkloadCeilingRawEvent}) is a plain
 * `string` in this canonical vocabulary — or `null`, when the authoritative
 * evidence did not resolve — because the platform's own invocation-outcome
 * vocabulary is not this repo's to close over, and a future outcome string
 * must still decode.
 *
 * The two telemetry sources spell their outcomes differently: Workers
 * Observability reports `ok` where the GraphQL Analytics dataset reports
 * `success` (verified live against both, 2026-08-24; provenance in
 * `runbooks/lane-b-preflight.md` Q5). The collector canonicalizes via
 * {@link WORKLOAD_CEILING_OUTCOME_CANONICALIZATIONS} and retains the
 * verbatim literal in the evidence block. Two entries are load-bearing
 * regardless:
 *
 *  - `"success"` — the canonical literal for an invocation that completed
 *    normally, matching the verified Analytics `status` literal.
 *  - `"exceededCpu"` — identical in both vocabularies, reproduced verbatim
 *    so a study reader can grep the platform docs for the exact string;
 *    this module never remaps or drops it.
 */
export const WORKLOAD_CEILING_KNOWN_OUTCOMES = [
  "success",
  "exceededCpu",
  "exceededMemory",
  "scriptThrewException",
  "responseStreamDisconnected",
] as const;
export type WorkloadCeilingKnownOutcome = (typeof WORKLOAD_CEILING_KNOWN_OUTCOMES)[number];

/** The one canonical literal for an invocation that completed normally. */
export const WORKLOAD_CEILING_SUCCESS_OUTCOME = "success" as const;

/**
 * Per-source success literals mapped onto the canonical vocabulary.
 * Everything else (including `exceededCpu`) is identical across the two
 * platform vocabularies and passes through unchanged; an unrecognized
 * literal also passes through unchanged and is classified as a non-success
 * (the conservative direction: it blocks a zero-failure claim rather than
 * granting one).
 */
export const WORKLOAD_CEILING_OUTCOME_CANONICALIZATIONS = {
  ok: WORKLOAD_CEILING_SUCCESS_OUTCOME,
} as const;

/** Maps a verbatim platform outcome literal onto the canonical vocabulary. Pure, total. */
export const canonicalizeWorkloadCeilingOutcome = (verbatim: string): string =>
  WORKLOAD_CEILING_OUTCOME_CANONICALIZATIONS[verbatim as "ok"] ?? verbatim;

export interface WorkloadCeilingRawEvent {
  readonly evidence_contract_id: typeof WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID;
  readonly run_id: string;
  readonly scenario_id: string;
  /**
   * The script version the AUTHORITY reported served the invocation; the
   * {@link WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION} sentinel exactly when
   * the evidence did not resolve.
   */
  readonly script_version: string;
  readonly compatibility_date: string;
  readonly runtime_period: string;
  /** The colo the authority reported; `"unknown"` exactly when the evidence did not resolve. */
  readonly colo: string;
  readonly thermal_class: WorkloadCeilingThermalClass;
  /**
   * The CANONICAL Worker execution outcome, or `null` exactly when the
   * authoritative evidence did not resolve. `null` is not an outcome and is
   * never counted as an execution failure — it blocks evidence completeness
   * instead. (The v1 pseudo-outcome `missing-terminal-event` is retired.)
   */
  readonly outcome: string | null;
  /**
   * The CPU measurement, from `workersInvocationsAdaptive` ONLY (see
   * {@link WorkloadCeilingEvidenceBlock}). `null` when that dataset dropped
   * the row — CPU-measurement missingness, gated by the CPU sample floor,
   * never an execution failure. A non-success outcome may carry a censored
   * partial value, preserved deliberately.
   */
  readonly cpu_ms: number | null;
  readonly observed_at: string;
  readonly evidence: WorkloadCeilingEvidenceBlock;
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
  "evidence_contract_id",
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
  "evidence",
] as const;

const EVIDENCE_BLOCK_FIELDS = [
  "status",
  "detail",
  "authority",
  "authoritative_outcome",
  "authoritative_cpu_ms",
  "authoritative_response_status",
  "cpu_source",
  "cpu_outcome_verbatim",
] as const;

const OBSERVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function canonicalizeEvidenceBlock(value: unknown, where: string): WorkloadCeilingEvidenceBlock {
  assertExactFields(value, EVIDENCE_BLOCK_FIELDS, where);
  const status = value["status"];
  if (status !== "resolved" && status !== "missing" && status !== "ambiguous") {
    invalid(`${where}.status`, `must be "resolved", "missing", or "ambiguous"`);
  }
  const detail = value["detail"];
  if (detail !== null && typeof detail !== "string") {
    invalid(`${where}.detail`, "must be a string or null");
  }
  if (status === "resolved" && detail !== null) {
    invalid(`${where}.detail`, 'must be null when status is "resolved"');
  }
  if (status !== "resolved" && (detail === null || detail.trim() === "")) {
    invalid(`${where}.detail`, "must be a nonempty string when status is not resolved");
  }
  if (value["authority"] !== "workers-observability") {
    invalid(`${where}.authority`, 'must be "workers-observability"');
  }
  const authoritativeOutcome = value["authoritative_outcome"];
  if (
    authoritativeOutcome !== null &&
    (typeof authoritativeOutcome !== "string" || authoritativeOutcome.trim() === "")
  ) {
    invalid(`${where}.authoritative_outcome`, "must be a nonempty string or null");
  }
  if (status === "resolved" && authoritativeOutcome === null) {
    invalid(`${where}.authoritative_outcome`, 'must be a string when status is "resolved"');
  }
  const authoritativeCpuMs = value["authoritative_cpu_ms"];
  if (
    authoritativeCpuMs !== null &&
    (typeof authoritativeCpuMs !== "number" ||
      !Number.isFinite(authoritativeCpuMs) ||
      authoritativeCpuMs < 0)
  ) {
    invalid(`${where}.authoritative_cpu_ms`, "must be null or a finite non-negative number");
  }
  const authoritativeResponseStatus = value["authoritative_response_status"];
  if (
    authoritativeResponseStatus !== null &&
    (typeof authoritativeResponseStatus !== "number" ||
      !Number.isInteger(authoritativeResponseStatus) ||
      authoritativeResponseStatus < 100 ||
      authoritativeResponseStatus > 599)
  ) {
    invalid(`${where}.authoritative_response_status`, "must be null or an HTTP status code");
  }
  const cpuSource = value["cpu_source"];
  if (cpuSource !== "workers-invocations-adaptive" && cpuSource !== "none") {
    invalid(`${where}.cpu_source`, 'must be "workers-invocations-adaptive" or "none"');
  }
  const cpuOutcomeVerbatim = value["cpu_outcome_verbatim"];
  if (
    cpuOutcomeVerbatim !== null &&
    (typeof cpuOutcomeVerbatim !== "string" || cpuOutcomeVerbatim.trim() === "")
  ) {
    invalid(`${where}.cpu_outcome_verbatim`, "must be a nonempty string or null");
  }
  if (cpuSource === "workers-invocations-adaptive" && cpuOutcomeVerbatim === null) {
    invalid(
      `${where}.cpu_outcome_verbatim`,
      'must record the row\'s verbatim status when cpu_source is "workers-invocations-adaptive"',
    );
  }
  return {
    status,
    detail,
    authority: "workers-observability",
    authoritative_outcome: authoritativeOutcome,
    authoritative_cpu_ms: authoritativeCpuMs,
    authoritative_response_status: authoritativeResponseStatus,
    cpu_source: cpuSource,
    cpu_outcome_verbatim: cpuOutcomeVerbatim,
  };
}

function canonicalizeRawEvent(value: unknown): WorkloadCeilingRawEvent {
  assertExactFields(value, RAW_EVENT_FIELDS, "raw event");
  if (value["evidence_contract_id"] !== WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID) {
    invalid(
      "evidence_contract_id",
      `must be ${WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID} — v1-era event files cannot mix with v2 artifacts`,
    );
  }
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
  const evidence = canonicalizeEvidenceBlock(value["evidence"], "evidence");
  const outcome = value["outcome"];
  if (outcome !== null && (typeof outcome !== "string" || outcome.trim() === "")) {
    invalid("outcome", "must be a nonempty canonical platform outcome or null");
  }
  // outcome is null exactly when the authoritative evidence did not resolve.
  // A null outcome is NOT an execution failure (that is the v1 conflation
  // this contract revision removes) — it blocks evidence completeness.
  if (evidence.status === "resolved" && outcome === null) {
    invalid("outcome", 'must be a platform outcome when evidence.status is "resolved"');
  }
  if (evidence.status !== "resolved" && outcome !== null) {
    invalid("outcome", "must be null when the authoritative evidence did not resolve");
  }
  const cpuMs = value["cpu_ms"];
  if (cpuMs !== null && (typeof cpuMs !== "number" || !Number.isFinite(cpuMs) || cpuMs < 0)) {
    invalid("cpu_ms", "must be null or a finite non-negative number");
  }
  // No synthesized CPU: cpu_ms is non-null exactly when its provenance says
  // the adaptive dataset supplied it. A number without that provenance (or a
  // claimed source with no number) is fabricated evidence.
  const hasAdaptiveCpu = evidence.cpu_source === "workers-invocations-adaptive";
  if (hasAdaptiveCpu !== (cpuMs !== null)) {
    invalid(
      "cpu_ms",
      hasAdaptiveCpu
        ? 'must be a number when cpu_source is "workers-invocations-adaptive"'
        : 'must be null when cpu_source is "none"',
    );
  }
  // A successful invocation without a CPU number is LEGAL under evidence
  // contract v2: the adaptive dataset dropping a row is CPU-measurement
  // missingness, gated by the CPU sample floor — never a reason to reject
  // the event or to invent a number.
  if (
    value["script_version"] === WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION &&
    evidence.status === "resolved"
  ) {
    invalid("script_version", "must not be the sentinel when the evidence resolved");
  }
  if (
    value["script_version"] !== WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION &&
    evidence.status !== "resolved"
  ) {
    invalid("script_version", "must be the unresolved sentinel when the evidence did not resolve");
  }
  if (evidence.status === "resolved" && value["colo"] === "unknown") {
    invalid("colo", 'must not be "unknown" when the evidence resolved');
  }
  if (evidence.status !== "resolved" && value["colo"] !== "unknown") {
    invalid("colo", 'must be "unknown" when the evidence did not resolve');
  }
  assertNonEmptyString(value["observed_at"], "observed_at");
  const observedAt = value["observed_at"];
  if (!OBSERVED_AT_PATTERN.test(observedAt)) {
    invalid("observed_at", "must be an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z)");
  }
  return {
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
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
    evidence,
  };
}

/** Canonical-JSON-serializes a validated raw event. Rejects a field outside the exact set. */
export const encodeWorkloadCeilingRawEvent = (event: WorkloadCeilingRawEvent): string => {
  const canonical = canonicalizeRawEvent(event);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "raw event");
};

/**
 * Decodes and validates a `WorkloadCeilingRawEvent`. Rejects any field
 * outside the exact set, any event whose `evidence_contract_id` is not the
 * current evidence-contract revision (so v1-era files can never mix with
 * v2 artifacts), and every provenance/evidence-status combination the
 * canonicalizer above refuses. Preserves `exceededCpu` and a `null`
 * (unresolved) outcome as explicit states rather than collapsing them, and
 * never derives `cpu_ms` — it is passed through with its recorded source.
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

/**
 * The `script_version` an unresolved-evidence event carries: the authority
 * never reported a version, so the field holds an explicit sentinel.
 *
 * Readers comparing deployment metadata across a cell must treat this as
 * "absent", never as a version — see `hasResolvedDeployment` in
 * `workload-ceiling-compare.ts`. The codec enforces that the sentinel
 * appears exactly when `evidence.status !== "resolved"`.
 */
export const WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION = "unresolved";

/**
 * Builds the strict raw-event record for an invocation whose AUTHORITATIVE
 * evidence did not resolve. The outcome is `null` — an unresolved
 * collection window is an evidence-completeness fact, never an execution
 * outcome (the v1 `missing-terminal-event` pseudo-outcome is retired) — and
 * no CPU is recorded, because the CPU source's row is only trusted when the
 * invocation it belongs to is established.
 */
export const unresolvedWorkloadCeilingRawEvent = (input: {
  readonly status: "missing" | "ambiguous";
  readonly detail: string;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly compatibility_date: string;
  readonly runtime_period: string;
  readonly thermal_class: WorkloadCeilingThermalClass;
  readonly observed_at: string;
}): WorkloadCeilingRawEvent =>
  canonicalizeRawEvent({
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
    run_id: input.run_id,
    scenario_id: input.scenario_id,
    script_version: WORKLOAD_CEILING_UNRESOLVED_SCRIPT_VERSION,
    compatibility_date: input.compatibility_date,
    runtime_period: input.runtime_period,
    colo: "unknown",
    thermal_class: input.thermal_class,
    outcome: null,
    cpu_ms: null,
    observed_at: input.observed_at,
    evidence: {
      status: input.status,
      detail: input.detail,
      authority: "workers-observability",
      authoritative_outcome: null,
      authoritative_cpu_ms: null,
      authoritative_response_status: null,
      cpu_source: "none",
      cpu_outcome_verbatim: null,
    },
  });

/** Sweep report codec for ticket 2: byte-axis cell catalog and calibrated sweep provisioning. */

export interface WorkloadCeilingSweepCell {
  readonly scenario_id: string;
  readonly axis: "byte" | "row";
  readonly target_bytes: number;
  readonly achieved_bytes: number;
  readonly row_count: number;
  readonly document_bytes: number;
  readonly manifest_descriptors: number;
  readonly fixture_prefix: string;
  readonly incarnation: string;
  readonly monolithic_key: string;
  readonly manifest_key: string;
  readonly descriptor_canonical_hash: string;
}

export interface WorkloadCeilingSweepCleanup {
  readonly scenario_id: string;
  readonly fixture_prefix: string;
  readonly written_keys: readonly string[];
  readonly cleanup_authority: unknown;
}

export interface WorkloadCeilingSweepReport {
  readonly contract_id: typeof WORKLOAD_CEILING_CONTRACT_ID;
  readonly sweep_id: string;
  readonly collection: string;
  readonly cells: readonly WorkloadCeilingSweepCell[];
  readonly cleanup: readonly WorkloadCeilingSweepCleanup[];
}

const SWEEP_CELL_FIELDS = [
  "scenario_id",
  "axis",
  "target_bytes",
  "achieved_bytes",
  "row_count",
  "document_bytes",
  "manifest_descriptors",
  "fixture_prefix",
  "incarnation",
  "monolithic_key",
  "manifest_key",
  "descriptor_canonical_hash",
] as const;

const SWEEP_CLEANUP_FIELDS = [
  "scenario_id",
  "fixture_prefix",
  "written_keys",
  "cleanup_authority",
] as const;

const SWEEP_REPORT_FIELDS = ["contract_id", "sweep_id", "collection", "cells", "cleanup"] as const;

function canonicalizeSweepCell(value: unknown): WorkloadCeilingSweepCell {
  assertExactFields(value, SWEEP_CELL_FIELDS, "sweep cell");
  assertNonEmptyString(value["scenario_id"], "scenario_id");
  const axis = value["axis"];
  if (axis !== "byte" && axis !== "row") {
    invalid("axis", `must be "byte" or "row"; got ${String(axis)}`);
  }
  const targetBytes = value["target_bytes"];
  if (typeof targetBytes !== "number" || !Number.isSafeInteger(targetBytes) || targetBytes < 1) {
    invalid("target_bytes", "must be a positive safe integer");
  }
  const achievedBytes = value["achieved_bytes"];
  if (
    typeof achievedBytes !== "number" ||
    !Number.isSafeInteger(achievedBytes) ||
    achievedBytes < 1
  ) {
    invalid("achieved_bytes", "must be a positive safe integer");
  }
  const rowCount = value["row_count"];
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 1) {
    invalid("row_count", "must be a positive safe integer");
  }
  const documentBytes = value["document_bytes"];
  if (
    typeof documentBytes !== "number" ||
    !Number.isSafeInteger(documentBytes) ||
    documentBytes < 32
  ) {
    invalid("document_bytes", "must be a safe integer >= 32");
  }
  const manifestDescriptors = value["manifest_descriptors"];
  if (
    typeof manifestDescriptors !== "number" ||
    !Number.isSafeInteger(manifestDescriptors) ||
    manifestDescriptors < 1
  ) {
    invalid("manifest_descriptors", "must be a positive safe integer");
  }
  assertNonEmptyString(value["fixture_prefix"], "fixture_prefix");
  assertNonEmptyString(value["incarnation"], "incarnation");
  assertNonEmptyString(value["monolithic_key"], "monolithic_key");
  assertNonEmptyString(value["manifest_key"], "manifest_key");
  assertNonEmptyString(value["descriptor_canonical_hash"], "descriptor_canonical_hash");
  return {
    scenario_id: value["scenario_id"],
    axis,
    target_bytes: targetBytes,
    achieved_bytes: achievedBytes,
    row_count: rowCount,
    document_bytes: documentBytes,
    manifest_descriptors: manifestDescriptors,
    fixture_prefix: value["fixture_prefix"],
    incarnation: value["incarnation"],
    monolithic_key: value["monolithic_key"],
    manifest_key: value["manifest_key"],
    descriptor_canonical_hash: value["descriptor_canonical_hash"],
  };
}

function canonicalizeSweepCleanup(value: unknown): WorkloadCeilingSweepCleanup {
  assertExactFields(value, SWEEP_CLEANUP_FIELDS, "sweep cleanup");
  assertNonEmptyString(value["scenario_id"], "scenario_id");
  assertNonEmptyString(value["fixture_prefix"], "fixture_prefix");
  const writtenKeys = value["written_keys"];
  if (!Array.isArray(writtenKeys)) {
    invalid("written_keys", "must be an array");
  }
  for (const key of writtenKeys) {
    assertNonEmptyString(key, "written_keys entry");
  }
  return {
    scenario_id: value["scenario_id"],
    fixture_prefix: value["fixture_prefix"],
    written_keys: writtenKeys as readonly string[],
    cleanup_authority: value["cleanup_authority"],
  };
}

function canonicalizeSweepReport(value: unknown): WorkloadCeilingSweepReport {
  assertExactFields(value, SWEEP_REPORT_FIELDS, "sweep report");
  if (value["contract_id"] !== WORKLOAD_CEILING_CONTRACT_ID) {
    invalid("contract_id", `must be ${WORKLOAD_CEILING_CONTRACT_ID}`);
  }
  assertNonEmptyString(value["sweep_id"], "sweep_id");
  assertNonEmptyString(value["collection"], "collection");
  const cells = value["cells"];
  if (!Array.isArray(cells)) {
    invalid("cells", "must be an array");
  }
  const canonicalCells = cells.map(canonicalizeSweepCell);
  const cleanup = value["cleanup"];
  if (!Array.isArray(cleanup)) {
    invalid("cleanup", "must be an array");
  }
  const canonicalCleanup = cleanup.map(canonicalizeSweepCleanup);
  return {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    sweep_id: value["sweep_id"],
    collection: value["collection"],
    cells: canonicalCells,
    cleanup: canonicalCleanup,
  };
}

/** Canonical-JSON-serializes a validated sweep report. Rejects a field outside the exact set. */
export const encodeWorkloadCeilingSweepReport = (report: WorkloadCeilingSweepReport): string => {
  const canonical = canonicalizeSweepReport(report);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "sweep report");
};

/** Decodes and validates a `WorkloadCeilingSweepReport`. Enforces canonical bytes. */
export const decodeWorkloadCeilingSweepReport = (raw: string): WorkloadCeilingSweepReport => {
  const parsed = parseJson(raw, "sweep report body");
  const canonical = canonicalizeSweepReport(parsed);
  const canonicalRaw = toCanonicalJson(canonical as unknown as CanonicalJsonValue, "sweep report");
  if (canonicalRaw !== raw) {
    invalid("sweep report body", "is not canonical JSON");
  }
  return canonical;
};

/**
 * Journal codec for ticket 4: unattended capture runner and batch collector.
 */

/**
 * One invocation the capture runner performed. Written to a JSONL journal
 * BEFORE the next invocation starts, so a crashed or killed run leaves an
 * exact, replayable record of everything it did.
 *
 * This is the join between the invoke phase and the collect phase: the collect
 * phase performs no invocation and derives its collection window from
 * `window_gte` / `window_lt` here, never from a clock of its own. That is what
 * makes collection re-runnable — a second collect pass over the same journal
 * asks the platform the identical question.
 *
 * `warmup: true` records an invocation excluded BEFORE it ran, per
 * `WORKLOAD_CEILING_STUDY.capture.exclusion_policy`. It stays in the journal;
 * exclusion is a tag, not a deletion.
 *
 * There is deliberately no field for the shared secret, and none for anything
 * derived from it.
 */
export interface WorkloadCeilingInvocationRecord {
  readonly contract_id: typeof WORKLOAD_CEILING_CONTRACT_ID;
  readonly sweep_id: string;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly implementation: WorkloadCeilingImplementation;
  readonly fixture_prefix: string;
  readonly warmup: boolean;
  readonly invoked_at: string;
  readonly window_gte: string;
  readonly window_lt: string;
  readonly http_status: number;
  /** The Worker's own reported row count — a cheap check that the fold ran over the expected fixture. */
  readonly row_count: number;
  readonly thermal_class: WorkloadCeilingThermalClass;
}

const INVOCATION_RECORD_FIELDS = [
  "contract_id",
  "sweep_id",
  "run_id",
  "scenario_id",
  "implementation",
  "fixture_prefix",
  "warmup",
  "invoked_at",
  "window_gte",
  "window_lt",
  "http_status",
  "row_count",
  "thermal_class",
] as const;

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!OBSERVED_AT_PATTERN.test(value)) {
    invalid(field, "must be an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z)");
  }
}

function canonicalizeInvocationRecord(value: unknown): WorkloadCeilingInvocationRecord {
  assertExactFields(value, INVOCATION_RECORD_FIELDS, "invocation record");
  if (value["contract_id"] !== WORKLOAD_CEILING_CONTRACT_ID) {
    invalid("contract_id", `must be ${WORKLOAD_CEILING_CONTRACT_ID}`);
  }
  assertNonEmptyString(value["sweep_id"], "sweep_id");
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
  const warmup = value["warmup"];
  if (typeof warmup !== "boolean") {
    invalid("warmup", "must be a boolean");
  }
  assertIsoTimestamp(value["invoked_at"], "invoked_at");
  assertIsoTimestamp(value["window_gte"], "window_gte");
  assertIsoTimestamp(value["window_lt"], "window_lt");
  const httpStatus = value["http_status"];
  if (
    typeof httpStatus !== "number" ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  ) {
    invalid("http_status", "must be an integer HTTP status code (100-599)");
  }
  const rowCount = value["row_count"];
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    invalid("row_count", "must be a non-negative safe integer");
  }
  const thermalClass = value["thermal_class"];
  if (!(WORKLOAD_CEILING_THERMAL_CLASSES as readonly unknown[]).includes(thermalClass)) {
    invalid(
      "thermal_class",
      `must be one of ${WORKLOAD_CEILING_THERMAL_CLASSES.join(", ")}; got ${String(thermalClass)}`,
    );
  }
  return {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    sweep_id: value["sweep_id"],
    run_id: value["run_id"],
    scenario_id: value["scenario_id"],
    implementation: implementation as WorkloadCeilingImplementation,
    fixture_prefix: value["fixture_prefix"],
    warmup,
    invoked_at: value["invoked_at"],
    window_gte: value["window_gte"],
    window_lt: value["window_lt"],
    http_status: httpStatus,
    row_count: rowCount,
    thermal_class: thermalClass as WorkloadCeilingThermalClass,
  };
}

/** Canonical-JSON-serializes a validated invocation record. Rejects a field outside the exact set. */
export const encodeWorkloadCeilingInvocationRecord = (
  record: WorkloadCeilingInvocationRecord,
): string => {
  const canonical = canonicalizeInvocationRecord(record);
  return toCanonicalJson(canonical as unknown as CanonicalJsonValue, "invocation record");
};

/**
 * Decodes and validates a `WorkloadCeilingInvocationRecord` from a journal line.
 * Enforces canonical bytes.
 */
export const decodeWorkloadCeilingInvocationRecord = (
  raw: string,
): WorkloadCeilingInvocationRecord => {
  const parsed = parseJson(raw, "invocation record body");
  const canonical = canonicalizeInvocationRecord(parsed);
  const canonicalRaw = toCanonicalJson(
    canonical as unknown as CanonicalJsonValue,
    "invocation record",
  );
  if (canonicalRaw !== raw) {
    invalid("invocation record body", "is not canonical JSON");
  }
  return canonical;
};

/**
 * Pure. The earliest instant an invocation may start, given when the previous
 * one started.
 *
 * Two constraints, both from `WORKLOAD_CEILING_STUDY.capture`:
 *
 *  - at least `invocation_spacing_seconds` after the previous start, so no two
 *    invocations share a telemetry minute bucket (any two instants ≥ 60 s apart
 *    are necessarily in different buckets; 70 is skew headroom);
 *  - not within the last `MINUTE_TAIL_GUARD_SECONDS` of a minute, so the
 *    invocation cannot straddle a boundary and land its telemetry row in the
 *    NEXT bucket — which would put it outside the window the runner derives
 *    from its own start instant.
 */
export const MINUTE_TAIL_GUARD_SECONDS = 10 as const;

export const nextInvocationStart = (previousStart: Date | null, now: Date): Date => {
  const spacingMs = WORKLOAD_CEILING_STUDY.capture.invocation_spacing_seconds * 1000;
  let candidate: Date;
  if (previousStart === null) {
    candidate = new Date(now.getTime());
  } else {
    candidate = new Date(previousStart.getTime() + spacingMs);
  }
  if (candidate < now) {
    candidate = new Date(now.getTime());
  }
  const seconds = candidate.getUTCSeconds();
  if (seconds >= 60 - MINUTE_TAIL_GUARD_SECONDS) {
    // Move to the start of the next minute
    candidate.setUTCSeconds(0, 0);
    candidate.setTime(candidate.getTime() + 60_000);
  }
  return candidate;
};

/**
 * Pure. The collection window for an invocation that started at `start`:
 * the whole minute containing it.
 *
 * Correct whether the platform's `datetime` dimension is the raw invocation
 * instant or the minute-bucket start — see ticket 4's pre-research. A window
 * bounded by the actual invocation instants is correct ONLY under the raw
 * reading, and silently loses every row under the other.
 */
export const collectionWindowFor = (start: Date): { readonly gte: string; readonly lt: string } => {
  const floor = new Date(Math.floor(start.getTime() / 60_000) * 60_000);
  return {
    gte: floor.toISOString(),
    lt: new Date(floor.getTime() + 60_000).toISOString(),
  };
};

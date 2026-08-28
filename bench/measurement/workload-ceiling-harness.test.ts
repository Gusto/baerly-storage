import { describe, expect, test } from "vitest";
import {
  decodeWorkloadCeilingRawEvent,
  decodeWorkloadCeilingRunRequest,
  encodeWorkloadCeilingRawEvent,
  encodeWorkloadCeilingRunRequest,
  unresolvedWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_CONTRACT_ID,
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  WORKLOAD_CEILING_OUTCOME_CANONICALIZATIONS,
  type WorkloadCeilingRawEvent,
  type WorkloadCeilingRunRequest,
} from "./workload-ceiling-harness.ts";

const VALID_REQUEST: WorkloadCeilingRunRequest = {
  contract_id: WORKLOAD_CEILING_CONTRACT_ID,
  run_id: "run-0001",
  scenario_id: "byte-axis/collection-1mib/doc-2048/hot-key",
  implementation: "chunked-candidate",
  fixture_prefix: "tenants/study/collections/workload-ceiling-run-0001",
};

const VALID_OK_EVENT: WorkloadCeilingRawEvent = {
  evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  run_id: "run-0001",
  scenario_id: "byte-axis/collection-1mib/doc-2048/hot-key",
  script_version: "abc123",
  compatibility_date: "2026-08-01",
  runtime_period: "2026-08-15T00:00:00.000Z/2026-08-15T00:05:00.000Z",
  colo: "SJC",
  thermal_class: "warm",
  outcome: "success",
  cpu_ms: 12.5,
  observed_at: "2026-08-15T00:01:00.000Z",
  evidence: {
    status: "resolved",
    detail: null,
    authority: "workers-observability",
    authoritative_outcome: "ok",
    authoritative_cpu_ms: 12,
    authoritative_response_status: 200,
    cpu_source: "workers-invocations-adaptive",
    cpu_outcome_verbatim: "success",
  },
};

describe("WorkloadCeilingRunRequest codec", () => {
  test("round-trips a valid request through canonical serialization", () => {
    const encoded = encodeWorkloadCeilingRunRequest(VALID_REQUEST);
    expect(decodeWorkloadCeilingRunRequest(encoded)).toEqual(VALID_REQUEST);
  });

  test("canonical serialization is stable regardless of caller field order", () => {
    const reordered = {
      fixture_prefix: VALID_REQUEST.fixture_prefix,
      scenario_id: VALID_REQUEST.scenario_id,
      run_id: VALID_REQUEST.run_id,
      implementation: VALID_REQUEST.implementation,
      contract_id: VALID_REQUEST.contract_id,
    } as WorkloadCeilingRunRequest;
    expect(encodeWorkloadCeilingRunRequest(reordered)).toBe(
      encodeWorkloadCeilingRunRequest(VALID_REQUEST),
    );
  });

  test("rejects a body with an unknown field", () => {
    const withExtra = JSON.stringify({ ...VALID_REQUEST, extra_field: "nope" });
    expect(() => decodeWorkloadCeilingRunRequest(withExtra)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects a body missing a required field", () => {
    const { fixture_prefix: _drop, ...rest } = VALID_REQUEST;
    const missing = JSON.stringify(rest);
    expect(() => decodeWorkloadCeilingRunRequest(missing)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects an unknown contract_id", () => {
    const wrongContract = JSON.stringify({
      ...VALID_REQUEST,
      contract_id: "baerly.workload-ceiling/chunked-snapshot/v2",
    });
    expect(() => decodeWorkloadCeilingRunRequest(wrongContract)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects an invalid implementation value", () => {
    const badImplementation = JSON.stringify({ ...VALID_REQUEST, implementation: "hybrid" });
    expect(() => decodeWorkloadCeilingRunRequest(badImplementation)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects a fixture_prefix with a leading slash or dot segment", () => {
    for (const fixture_prefix of ["/absolute/prefix", "tenants/../escape", "tenants//double"]) {
      const bad = JSON.stringify({ ...VALID_REQUEST, fixture_prefix });
      expect(() => decodeWorkloadCeilingRunRequest(bad)).toThrowError(
        expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
      );
    }
  });

  test("rejects non-canonical JSON bytes (whitespace) even when the parsed value is valid", () => {
    const encoded = encodeWorkloadCeilingRunRequest(VALID_REQUEST);
    const withWhitespace = `${encoded} `;
    expect(() => decodeWorkloadCeilingRunRequest(withWhitespace)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });
});

describe("WorkloadCeilingRawEvent codec", () => {
  test("round-trips a valid ok event through canonical serialization", () => {
    const encoded = encodeWorkloadCeilingRawEvent(VALID_OK_EVENT);
    expect(decodeWorkloadCeilingRawEvent(encoded)).toEqual(VALID_OK_EVENT);
  });

  test("rejects evidence-contract v1 bytes — old and new artifacts cannot mix", () => {
    // A rehearsal-era event file: the exact v1 field set, no evidence block,
    // outcome "missing-terminal-event" acting as a collection status.
    const v1 = JSON.stringify({
      run_id: "run-0001",
      scenario_id: "byte-axis/collection-1mib/doc-2048/hot-key",
      script_version: "unresolved",
      compatibility_date: "2026-08-01",
      runtime_period: "2026-08-15T00:00:00.000Z/2026-08-15T00:05:00.000Z",
      colo: "unknown",
      thermal_class: "warm",
      outcome: "missing-terminal-event",
      cpu_ms: null,
      observed_at: "2026-08-15T00:01:00.000Z",
    });
    expect(() => decodeWorkloadCeilingRawEvent(v1)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "raw event" }),
    );
  });

  test("rejects an unknown evidence_contract_id value", () => {
    const wrongRevision = JSON.stringify({
      ...VALID_OK_EVENT,
      evidence_contract_id: "baerly.workload-ceiling/evidence/v1",
    });
    expect(() => decodeWorkloadCeilingRawEvent(wrongRevision)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("outcome is null exactly when the authoritative evidence did not resolve", () => {
    // Both fabrication directions are refused: a resolved status with a null
    // outcome claims knowledge the authority never supplied, and a non-null
    // outcome on unresolved evidence invents an execution result.
    const resolvedWithoutOutcome = JSON.stringify({
      ...VALID_OK_EVENT,
      outcome: null,
    });
    expect(() => decodeWorkloadCeilingRawEvent(resolvedWithoutOutcome)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "outcome" }),
    );
    const unresolvedWithOutcome = unresolvedWorkloadCeilingRawEvent({
      status: "missing",
      detail: "no workers-observability join line for run_id in window",
      run_id: VALID_OK_EVENT.run_id,
      scenario_id: VALID_OK_EVENT.scenario_id,
      compatibility_date: VALID_OK_EVENT.compatibility_date,
      runtime_period: VALID_OK_EVENT.runtime_period,
      thermal_class: "warm",
      observed_at: VALID_OK_EVENT.observed_at,
    });
    const fabricated = JSON.stringify({ ...unresolvedWithOutcome, outcome: "success" });
    expect(() => decodeWorkloadCeilingRawEvent(fabricated)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "outcome" }),
    );
  });

  test("a successful outcome without a CPU number is legal — CPU missingness is not fabrication", () => {
    // Evidence-contract v2: `workersInvocationsAdaptive` demonstrably drops
    // rows for invocations that succeeded. A success with cpu_ms null is the
    // honest record of that state (CPU completeness is a separate gate), not
    // a malformed event.
    const cpuMissing: WorkloadCeilingRawEvent = {
      ...VALID_OK_EVENT,
      cpu_ms: null,
      evidence: {
        ...VALID_OK_EVENT.evidence,
        cpu_source: "none",
        cpu_outcome_verbatim: null,
      },
    };
    const decoded = decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(cpuMissing));
    expect(decoded.outcome).toBe("success");
    expect(decoded.cpu_ms).toBeNull();
  });

  test("refuses a cpu_ms that its own provenance says was never measured", () => {
    // cpu_source "none" with a number present is exactly the fabricated
    // evidence this codec exists to refuse.
    const fabricatedCpu = JSON.stringify({
      ...VALID_OK_EVENT,
      evidence: { ...VALID_OK_EVENT.evidence, cpu_source: "none" },
    });
    expect(() => decodeWorkloadCeilingRawEvent(fabricatedCpu)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "cpu_ms" }),
    );
  });

  test("a cpu_ms from the adaptive dataset records the row's verbatim status", () => {
    const withoutVerbatim = JSON.stringify({
      ...VALID_OK_EVENT,
      evidence: { ...VALID_OK_EVENT.evidence, cpu_outcome_verbatim: null },
    });
    expect(() => decodeWorkloadCeilingRawEvent(withoutVerbatim)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("preserves exceededCpu as an explicit outcome with a null cpu_ms", () => {
    const exceeded: WorkloadCeilingRawEvent = {
      ...VALID_OK_EVENT,
      outcome: "exceededCpu",
      cpu_ms: null,
      evidence: {
        ...VALID_OK_EVENT.evidence,
        authoritative_outcome: "exceededCpu",
        cpu_source: "none",
        cpu_outcome_verbatim: null,
      },
    };
    const encoded = encodeWorkloadCeilingRawEvent(exceeded);
    const decoded = decodeWorkloadCeilingRawEvent(encoded);
    expect(decoded.outcome).toBe("exceededCpu");
    expect(decoded.cpu_ms).toBeNull();
  });

  test("preserves exceededCpu when the platform still reports a partial cpu_ms", () => {
    const exceeded: WorkloadCeilingRawEvent = {
      ...VALID_OK_EVENT,
      outcome: "exceededCpu",
      cpu_ms: 50,
    };
    const decoded = decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(exceeded));
    expect(decoded.outcome).toBe("exceededCpu");
    expect(decoded.cpu_ms).toBe(50);
  });

  test("represents unresolved evidence explicitly rather than dropping the invocation", () => {
    const missing = unresolvedWorkloadCeilingRawEvent({
      status: "missing",
      detail: "no workers-observability join line for run_id in window",
      run_id: VALID_OK_EVENT.run_id,
      scenario_id: VALID_OK_EVENT.scenario_id,
      compatibility_date: VALID_OK_EVENT.compatibility_date,
      runtime_period: VALID_OK_EVENT.runtime_period,
      thermal_class: "unknown",
      observed_at: VALID_OK_EVENT.observed_at,
    });
    // Evidence status and execution outcome are separate concepts: the
    // unresolved record carries a null outcome (never a pseudo-outcome like
    // the retired `missing-terminal-event`), the sentinel script_version,
    // and no CPU.
    expect(missing.evidence.status).toBe("missing");
    expect(missing.outcome).toBeNull();
    expect(missing.script_version).toBe("unresolved");
    expect(missing.colo).toBe("unknown");
    expect(missing.cpu_ms).toBeNull();
    expect(missing.evidence.cpu_source).toBe("none");
    const roundTripped = decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(missing));
    expect(roundTripped).toEqual(missing);

    const ambiguous = unresolvedWorkloadCeilingRawEvent({
      status: "ambiguous",
      detail: "2 workers-observability join lines for one run_id",
      run_id: VALID_OK_EVENT.run_id,
      scenario_id: VALID_OK_EVENT.scenario_id,
      compatibility_date: VALID_OK_EVENT.compatibility_date,
      runtime_period: VALID_OK_EVENT.runtime_period,
      thermal_class: "warm",
      observed_at: VALID_OK_EVENT.observed_at,
    });
    expect(ambiguous.evidence.status).toBe("ambiguous");
    expect(decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(ambiguous))).toEqual(
      ambiguous,
    );
  });

  test("a resolved event may not keep the sentinel script_version or an unknown colo", () => {
    const sentinelVersion = JSON.stringify({ ...VALID_OK_EVENT, script_version: "unresolved" });
    expect(() => decodeWorkloadCeilingRawEvent(sentinelVersion)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "script_version" }),
    );
    const unknownColo = JSON.stringify({ ...VALID_OK_EVENT, colo: "unknown" });
    expect(() => decodeWorkloadCeilingRawEvent(unknownColo)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "colo" }),
    );
  });

  test("detail is required exactly when the evidence did not resolve", () => {
    const resolvedWithDetail = JSON.stringify({
      ...VALID_OK_EVENT,
      evidence: { ...VALID_OK_EVENT.evidence, detail: "never mind" },
    });
    expect(() => decodeWorkloadCeilingRawEvent(resolvedWithDetail)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid", field: "evidence.detail" }),
    );
  });

  test("maps each platform vocabulary's success literal to the canonical outcome", () => {
    // Workers Observability reports `ok`; the GraphQL Analytics dataset
    // reports `success`. The canonical event vocabulary is `success`, and
    // verbatim literals survive in the evidence block instead.
    expect(WORKLOAD_CEILING_OUTCOME_CANONICALIZATIONS).toEqual({ ok: "success" });
  });

  test("rejects a body with an unknown field", () => {
    const withExtra = JSON.stringify({ ...VALID_OK_EVENT, extra: true });
    expect(() => decodeWorkloadCeilingRawEvent(withExtra)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects a body missing cpu_ms rather than defaulting it", () => {
    const { cpu_ms: _drop, ...rest } = VALID_OK_EVENT;
    const missing = JSON.stringify(rest);
    expect(() => decodeWorkloadCeilingRawEvent(missing)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects an unknown thermal_class", () => {
    const bad = JSON.stringify({ ...VALID_OK_EVENT, thermal_class: "toasty" });
    expect(() => decodeWorkloadCeilingRawEvent(bad)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects a negative cpu_ms", () => {
    const bad = JSON.stringify({ ...VALID_OK_EVENT, cpu_ms: -1 });
    expect(() => decodeWorkloadCeilingRawEvent(bad)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("rejects a malformed observed_at timestamp", () => {
    const bad = JSON.stringify({ ...VALID_OK_EVENT, observed_at: "not-a-timestamp" });
    expect(() => decodeWorkloadCeilingRawEvent(bad)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });
});

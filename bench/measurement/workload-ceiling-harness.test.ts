import { describe, expect, test } from "vitest";
import {
  decodeWorkloadCeilingRawEvent,
  decodeWorkloadCeilingRunRequest,
  encodeWorkloadCeilingRawEvent,
  encodeWorkloadCeilingRunRequest,
  missingTerminalWorkloadCeilingRawEvent,
  WORKLOAD_CEILING_CONTRACT_ID,
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
  run_id: "run-0001",
  scenario_id: "byte-axis/collection-1mib/doc-2048/hot-key",
  script_version: "abc123",
  compatibility_date: "2026-08-01",
  runtime_period: "2026-08-15T00:00:00.000Z/2026-08-15T00:05:00.000Z",
  colo: "SJC",
  thermal_class: "warm",
  outcome: "ok",
  cpu_ms: 12.5,
  observed_at: "2026-08-15T00:01:00.000Z",
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

  test("preserves exceededCpu as an explicit outcome with a null cpu_ms", () => {
    const exceeded: WorkloadCeilingRawEvent = {
      ...VALID_OK_EVENT,
      outcome: "exceededCpu",
      cpu_ms: null,
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

  test("represents a missing terminal event explicitly rather than dropping the invocation", () => {
    const missing = missingTerminalWorkloadCeilingRawEvent({
      run_id: VALID_OK_EVENT.run_id,
      scenario_id: VALID_OK_EVENT.scenario_id,
      script_version: VALID_OK_EVENT.script_version,
      compatibility_date: VALID_OK_EVENT.compatibility_date,
      runtime_period: VALID_OK_EVENT.runtime_period,
      colo: VALID_OK_EVENT.colo,
      thermal_class: "unknown",
      observed_at: VALID_OK_EVENT.observed_at,
    });
    expect(missing.outcome).toBe("missing-terminal-event");
    expect(missing.cpu_ms).toBeNull();
    const roundTripped = decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(missing));
    expect(roundTripped).toEqual(missing);
  });

  test("refuses to synthesize a cpu_ms for a missing-terminal-event outcome", () => {
    const withFabricatedCpu = JSON.stringify({
      ...VALID_OK_EVENT,
      outcome: "missing-terminal-event",
      cpu_ms: 9.9,
    });
    expect(() => decodeWorkloadCeilingRawEvent(withFabricatedCpu)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
  });

  test("refuses a null cpu_ms on an ok outcome", () => {
    const withoutCpu = JSON.stringify({ ...VALID_OK_EVENT, cpu_ms: null });
    expect(() => decodeWorkloadCeilingRawEvent(withoutCpu)).toThrowError(
      expect.objectContaining({ code: "WorkloadCeilingHarnessInvalid" }),
    );
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

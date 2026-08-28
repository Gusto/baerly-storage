import { describe, expect, test } from "vitest";
import {
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import { validateWorkloadCeilingRawEvent } from "./workload-ceiling-validate-smoke.ts";

const resolvedEvidence = {
  status: "resolved" as const,
  detail: null,
  authority: "workers-observability" as const,
  authoritative_outcome: "ok",
  authoritative_cpu_ms: 12,
  authoritative_response_status: 200,
  cpu_source: "workers-invocations-adaptive" as const,
  cpu_outcome_verbatim: "success",
};

const okEvent: WorkloadCeilingRawEvent = {
  evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  run_id: "12345678-1234-1234-1234-123456789abc",
  scenario_id: "byte-axis/default/hot-key",
  script_version: "a1b2c3d4",
  compatibility_date: "2026-08-15",
  runtime_period: "2026-08-18T00:00:00Z/2026-08-18T00:01:00Z",
  colo: "DFW",
  thermal_class: "unknown",
  outcome: "success",
  cpu_ms: 12.5,
  observed_at: "2026-08-18T00:01:30Z",
  evidence: resolvedEvidence,
};

// Verbatim from the lane-a smoke control event
// (bench/results/workload-ceiling/smoke-control/event-20e4c62f-….json) and
// the lane-b rehearsal events — the platform's actual wire shapes. The
// synthetic okEvent above must not be the only form that validates.
const realPlatformEvent: WorkloadCeilingRawEvent = {
  evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  run_id: "e49e9d9e-4144-4347-b5cc-303596720ed9",
  scenario_id: "byte-axis/512KiB",
  script_version: "bf21bd73-a366-4fa5-965d-9599100093f2",
  compatibility_date: "2026-08-15",
  runtime_period: "2026-08-20T06:19:00.000Z/2026-08-20T06:20:00.000Z",
  colo: "SEA",
  thermal_class: "warm",
  outcome: "success",
  cpu_ms: 9.518,
  observed_at: "2026-08-20T06:38:44.027Z",
  evidence: resolvedEvidence,
};

describe("validateWorkloadCeilingRawEvent", () => {
  test("passes every field for a well-formed ok event", () => {
    const results = validateWorkloadCeilingRawEvent(okEvent);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  test("passes every field for a verbatim platform event (dashed UUID script_version, millisecond runtime_period)", () => {
    const results = validateWorkloadCeilingRawEvent(realPlatformEvent);
    const failures = results.filter((r) => !r.passed);
    expect(failures.map((r) => r.field)).toEqual([]);
  });

  test("accepts the dashed-UUID script_version the GraphQL API actually returns", () => {
    // Verified literal from lane-b-preflight.md Q1: scriptVersion dimensions
    // arrive as dashed UUIDs, not bare hex hashes.
    const results = validateWorkloadCeilingRawEvent({
      ...okEvent,
      script_version: "b3043d69-ddf5-49d3-b6ab-80850bcd1935",
    });
    const result = results.find((r) => r.field === "script_version");
    expect(result?.passed).toBe(true);
  });

  test("still rejects a garbage script_version", () => {
    const results = validateWorkloadCeilingRawEvent({
      ...okEvent,
      script_version: "not-a-version!!",
    });
    const result = results.find((r) => r.field === "script_version");
    expect(result?.passed).toBe(false);
  });

  test("rejects a non-UUID run_id", () => {
    const results = validateWorkloadCeilingRawEvent({ ...okEvent, run_id: "not-a-uuid" });
    const runIdResult = results.find((r) => r.field === "run_id");
    expect(runIdResult?.passed).toBe(false);
  });

  test("rejects a compatibility_date that doesn't match wrangler.jsonc", () => {
    const results = validateWorkloadCeilingRawEvent({
      ...okEvent,
      compatibility_date: "2025-01-01",
    });
    const result = results.find((r) => r.field === "compatibility_date");
    expect(result?.passed).toBe(false);
  });

  test("rejects an inverted runtime_period", () => {
    const results = validateWorkloadCeilingRawEvent({
      ...okEvent,
      runtime_period: "2026-08-18T00:01:00Z/2026-08-18T00:00:00Z",
    });
    const result = results.find((r) => r.field === "runtime_period");
    expect(result?.passed).toBe(false);
  });

  test("rejects a colo that isn't a 3-letter code", () => {
    const results = validateWorkloadCeilingRawEvent({ ...okEvent, colo: "dallas" });
    const result = results.find((r) => r.field === "colo");
    expect(result?.passed).toBe(false);
  });

  test("requires a finite non-negative cpu_ms when outcome is success", () => {
    const results = validateWorkloadCeilingRawEvent({ ...okEvent, cpu_ms: -1 });
    const result = results.find((r) => r.field === "cpu_ms");
    expect(result?.passed).toBe(false);
  });

  test("a null outcome (unresolved evidence) fails validation on the outcome field", () => {
    // A `null` outcome is not a platform outcome; a smoke event carrying one
    // has not been validated as a sample of anything.
    const results = validateWorkloadCeilingRawEvent({ ...okEvent, outcome: null });
    const result = results.find((r) => r.field === "outcome");
    expect(result?.passed).toBe(false);
  });

  test("a successful outcome without a CPU number fails CPU completeness, not the outcome", () => {
    // The evidence-missingness shape: execution fine, CPU row never landed.
    // The outcome field passes; the cpu_ms field is what fails.
    const results = validateWorkloadCeilingRawEvent({
      ...okEvent,
      cpu_ms: null,
      evidence: { ...resolvedEvidence, cpu_source: "none", cpu_outcome_verbatim: null },
    });
    const outcome = results.find((r) => r.field === "outcome");
    const cpu = results.find((r) => r.field === "cpu_ms");
    expect(outcome?.passed).toBe(true);
    expect(cpu?.passed).toBe(false);
  });

  test("rejects an observed_at that isn't ISO 8601", () => {
    const results = validateWorkloadCeilingRawEvent({ ...okEvent, observed_at: "not-a-date" });
    const result = results.find((r) => r.field === "observed_at");
    expect(result?.passed).toBe(false);
  });
});

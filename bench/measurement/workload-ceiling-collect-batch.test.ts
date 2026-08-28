/**
 * Tests for workload-ceiling-collect-batch.ts — the batch collector's
 * retry policy and evidence-status reporting (evidence-contract v2).
 *
 * Pure — no network, no spawning, no I/O: the retry driver is exercised
 * through injected `collect`/`readExisting`/`sleep` functions.
 */
import { describe, expect, test } from "vitest";
import {
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import { collectWithRetry, isFinishedCollection } from "./workload-ceiling-collect-batch.ts";

const record = (runId: string, over: Partial<WorkloadCeilingInvocationRecord> = {}) =>
  ({
    contract_id: "baerly.workload-ceiling/chunked-snapshot/v1",
    sweep_id: "sweep-1",
    run_id: runId,
    scenario_id: "byte-axis/1MiB",
    implementation: "monolithic-control",
    fixture_prefix: "fixtures/1m",
    warmup: false,
    invoked_at: "2026-08-24T17:30:00.000Z",
    window_gte: "2026-08-24T17:30:00.000Z",
    window_lt: "2026-08-24T17:31:00.000Z",
    http_status: 200,
    row_count: 491,
    thermal_class: "warm",
    ...over,
  }) as WorkloadCeilingInvocationRecord;

const event = (over: {
  readonly outcome?: string | null;
  readonly cpu_ms?: number | null;
  readonly status?: "resolved" | "missing" | "ambiguous";
  readonly detail?: string | null;
}): WorkloadCeilingRawEvent => {
  const resolved = over.status === "resolved";
  let authoritativeOutcome: string | null = null;
  if (resolved && over.outcome === "success") {
    authoritativeOutcome = "ok";
  } else if (resolved && over.outcome != null) {
    authoritativeOutcome = over.outcome;
  }
  return {
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
    run_id: "run-1",
    scenario_id: "byte-axis/1MiB",
    script_version: resolved ? "027034f3-170b-466d-b1ad-914fad42024c" : "unresolved",
    compatibility_date: "2026-08-15",
    runtime_period: "2026-08-24T17:30:00.000Z/2026-08-24T17:31:00.000Z",
    colo: resolved ? "EWR" : "unknown",
    thermal_class: "warm",
    outcome: over.outcome ?? null,
    cpu_ms: over.cpu_ms ?? null,
    observed_at: "2026-08-24T17:53:54.083Z",
    evidence: {
      status: over.status ?? "missing",
      detail: over.detail ?? (resolved ? null : "no join line in window"),
      authority: "workers-observability",
      authoritative_outcome: authoritativeOutcome,
      authoritative_cpu_ms: null,
      authoritative_response_status: null,
      cpu_source: over.cpu_ms != null ? "workers-invocations-adaptive" : "none",
      cpu_outcome_verbatim: over.cpu_ms != null ? "success" : null,
    },
  };
};

describe("isFinishedCollection (evidence-contract v2)", () => {
  test("a fully resolved success is finished — never re-query its window", () => {
    expect(
      isFinishedCollection(event({ status: "resolved", outcome: "success", cpu_ms: 7.269 })),
    ).toBe(true);
  });

  test("an evidence-missing event is NOT finished — the retry pass re-queries it", () => {
    expect(isFinishedCollection(event({ status: "missing", outcome: null, cpu_ms: null }))).toBe(
      false,
    );
  });

  test("an evidence-ambiguous event is NOT finished", () => {
    expect(isFinishedCollection(event({ status: "ambiguous", outcome: null, cpu_ms: null }))).toBe(
      false,
    );
  });

  test("a resolved success without CPU is NOT finished — its CPU row gets the one retry too", () => {
    // CPU missingness is terminal in aggregate, but the single sanctioned
    // collection retry applies to it: the row may simply be lagging.
    expect(
      isFinishedCollection(event({ status: "resolved", outcome: "success", cpu_ms: null })),
    ).toBe(false);
  });

  test("a resolved exceededCpu IS finished — a kill is a terminal platform fact, not lag", () => {
    // Re-querying cannot un-kill an invocation; retrying it would only burn
    // API calls after the outcome is already authoritative.
    expect(
      isFinishedCollection(event({ status: "resolved", outcome: "exceededCpu", cpu_ms: 50 })),
    ).toBe(true);
  });

  test("nothing collected yet is not finished", () => {
    expect(isFinishedCollection(undefined)).toBe(false);
  });
});

describe("collectWithRetry", () => {
  const delayMs = 1234;

  test("re-queries an unresolved run once, with the same record — never a new invocation", async () => {
    const target = record("run-lagging");
    const collected: readonly WorkloadCeilingInvocationRecord[] = [];
    const collectCalls: WorkloadCeilingInvocationRecord[] = [];
    let callsForTarget = 0;
    const outcomes = await collectWithRetry([target, record("run-clean")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async (r) => {
        collectCalls.push(r);
        if (r.run_id === "run-lagging") {
          callsForTarget += 1;
          // First pass: evidence missing (lag). Retry pass: resolved.
          return callsForTarget === 1
            ? event({ status: "missing", outcome: null, cpu_ms: null })
            : event({ status: "resolved", outcome: "success", cpu_ms: 7 });
        }
        return event({ status: "resolved", outcome: "success", cpu_ms: 8 });
      },
      sleep: async () => {},
    });
    expect(collectCalls.filter((r) => r.run_id === "run-lagging")).toHaveLength(2);
    // The retry pass re-queried the SAME run id and the SAME collection
    // window — the journal's, not a re-derived or widened one.
    const [first, second] = collectCalls.filter((r) => r.run_id === "run-lagging");
    expect(second!.run_id).toBe(first!.run_id);
    expect(second!.window_gte).toBe(first!.window_gte);
    expect(second!.window_lt).toBe(first!.window_lt);
    // No record outside the journal was ever queried.
    expect(collectCalls.every((r) => r.run_id === "run-lagging" || r.run_id === "run-clean")).toBe(
      true,
    );
    const lagging = outcomes.find((o) => o.run_id === "run-lagging");
    expect(lagging?.attempts).toBe(2);
    expect(lagging?.newly_resolved).toBe(true);
    expect(collected).toHaveLength(0);
  });

  test("a run that recovers on the FIRST pass is reported as newly resolved", async () => {
    // The recovery-on-re-run case: a previous invocation of the collector left
    // an unresolved event on disk, and this run resolves it. Seeding only
    // `pending` from that on-disk state left pass 0 with no prior entry to
    // compare against, so `newly_resolved` was false for exactly the runs it
    // exists to report — only pass-1 resolutions were ever counted.
    const outcomes = await collectWithRetry([record("run-lagging")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => event({ status: "missing", outcome: null, cpu_ms: null }),
      collect: async () => event({ status: "resolved", outcome: "success", cpu_ms: 7 }),
      sleep: async () => {},
    });
    const lagging = outcomes.find((o) => o.run_id === "run-lagging");
    expect(lagging?.newly_resolved).toBe(true);
    expect(lagging?.attempts).toBe(1);
  });

  test("sleeps exactly once between passes, and never when nothing is unresolved", async () => {
    const sleeps: number[] = [];
    await collectWithRetry([record("run-clean")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async () => event({ status: "resolved", outcome: "success", cpu_ms: 8 }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([]);

    let calls = 0;
    await collectWithRetry([record("run-dropped")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async () => {
        calls += 1;
        return event({ status: "missing", outcome: null, cpu_ms: null });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([delayMs]);
  });

  test("no third pass, however unresolved the run stays — the retry count is preregistered", async () => {
    let calls = 0;
    const outcomes = await collectWithRetry([record("run-dropped")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async () => {
        calls += 1;
        return event({ status: "missing", outcome: null, cpu_ms: null });
      },
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(outcomes[0]!.evidence_status).toBe("missing");
  });

  test("a run already finished on disk is skipped, never re-queried", async () => {
    const onDisk = event({ status: "resolved", outcome: "success", cpu_ms: 7 });
    let collectCalls = 0;
    const outcomes = await collectWithRetry([record("run-done")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => onDisk,
      collect: async () => {
        collectCalls += 1;
        return event({ status: "resolved", outcome: "success", cpu_ms: 99 });
      },
      sleep: async () => {},
    });
    expect(collectCalls).toBe(0);
    expect(outcomes[0]!.attempts).toBe(0);
    expect(outcomes[0]!.evidence_status).toBe("resolved");
  });

  test("a CPU-missing success gets the retry, and stays CPU-missing if the row never lands", async () => {
    let calls = 0;
    const outcomes = await collectWithRetry([record("run-cpu-dropped")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async () => {
        calls += 1;
        return event({ status: "resolved", outcome: "success", cpu_ms: null });
      },
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    const outcome = outcomes[0]!;
    // A successful execution with CPU missingness: not a failure, not finished.
    expect(outcome.evidence_status).toBe("resolved");
    expect(outcome.cpu_resolved).toBe(false);
  });

  test("reports evidence-status counts the summary prints", async () => {
    const outcomes = await collectWithRetry([record("r1"), record("r2"), record("r3")], {
      retries: 1,
      retryDelayMs: delayMs,
      readExisting: async () => undefined,
      collect: async (r) => {
        if (r.run_id === "r1") {
          return event({ status: "resolved", outcome: "success", cpu_ms: 1 });
        }
        if (r.run_id === "r2") {
          return event({ status: "missing", outcome: null, cpu_ms: null });
        }
        return event({ status: "ambiguous", outcome: null, cpu_ms: null });
      },
      sleep: async () => {},
    });
    const counts = outcomes.reduce(
      (acc, o) => {
        acc[o.evidence_status] = (acc[o.evidence_status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    expect(counts).toEqual({ resolved: 1, missing: 1, ambiguous: 1 });
  });
});

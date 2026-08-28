/**
 * Tests for the capture runner and batch collector (ticket 4).
 *
 * These tests are pure — no network, no credentials, no I/O.
 */

import { describe, test, expect, vi } from "vitest";
import {
  MINUTE_TAIL_GUARD_SECONDS,
  nextInvocationStart,
  collectionWindowFor,
  decodeWorkloadCeilingRunRequest,
  WORKLOAD_CEILING_CONTRACT_ID,
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import {
  invokeWorker,
  planCaptureInvocations,
  remainingCaptureInvocations,
} from "./workload-ceiling-capture.ts";
import { armOutputDir, isFinishedCollection } from "./workload-ceiling-collect-batch.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";

describe("planCaptureInvocations", () => {
  const fourCells = [
    {
      scenario_id: "byte-512k",
      axis: "byte" as const,
      target_bytes: 512 * 1024,
      achieved_bytes: 512 * 1024,
      row_count: 245,
      document_bytes: 2048,
      manifest_descriptors: 8,
      fixture_prefix: "fixtures/byte-512k",
      incarnation: "00000000000000000000000000000000",
      monolithic_key: "fixtures/byte-512k/monolithic.json",
      manifest_key: "fixtures/byte-512k/manifest.json",
      descriptor_canonical_hash: "a".repeat(64),
    },
    {
      scenario_id: "byte-1m",
      axis: "byte" as const,
      target_bytes: 1024 * 1024,
      achieved_bytes: 1024 * 1024,
      row_count: 491,
      document_bytes: 2048,
      manifest_descriptors: 8,
      fixture_prefix: "fixtures/byte-1m",
      incarnation: "00000000000000000000000000000000",
      monolithic_key: "fixtures/byte-1m/monolithic.json",
      manifest_key: "fixtures/byte-1m/manifest.json",
      descriptor_canonical_hash: "b".repeat(64),
    },
    {
      scenario_id: "byte-2m",
      axis: "byte" as const,
      target_bytes: 2 * 1024 * 1024,
      achieved_bytes: 2 * 1024 * 1024,
      row_count: 982,
      document_bytes: 2048,
      manifest_descriptors: 8,
      fixture_prefix: "fixtures/byte-2m",
      incarnation: "00000000000000000000000000000000",
      monolithic_key: "fixtures/byte-2m/monolithic.json",
      manifest_key: "fixtures/byte-2m/manifest.json",
      descriptor_canonical_hash: "c".repeat(64),
    },
    {
      scenario_id: "byte-4m",
      axis: "byte" as const,
      target_bytes: 4 * 1024 * 1024,
      achieved_bytes: 4 * 1024 * 1024,
      row_count: 1964,
      document_bytes: 2048,
      manifest_descriptors: 8,
      fixture_prefix: "fixtures/byte-4m",
      incarnation: "00000000000000000000000000000000",
      monolithic_key: "fixtures/byte-4m/monolithic.json",
      manifest_key: "fixtures/byte-4m/manifest.json",
      descriptor_canonical_hash: "d".repeat(64),
    },
  ];

  const twoArms = ["monolithic-control", "monolithic-control-unhashed"] as const;

  test("emits cells × arms × (warmup + measured) invocations", () => {
    const plan = planCaptureInvocations({
      cells: fourCells,
      arms: twoArms,
      warmup: 2,
      measured: 30,
    });
    expect(plan).toHaveLength(4 * 2 * 32);
  });

  test("interleaves cells rather than blocking, so drift spreads evenly", () => {
    const plan = planCaptureInvocations({
      cells: fourCells,
      arms: twoArms,
      warmup: 0,
      measured: 3,
    });
    // Consecutive entries must not repeat a scenario until every other has run.
    expect(plan.slice(0, 4).map((p) => p.scenario_id)).toEqual(fourCells.map((c) => c.scenario_id));
    // Check that the pattern continues
    expect(plan.slice(4, 8).map((p) => p.scenario_id)).toEqual(fourCells.map((c) => c.scenario_id));
  });

  test("every warmup precedes every measured invocation of the same cell and arm", () => {
    const plan = planCaptureInvocations({
      cells: fourCells,
      arms: twoArms,
      warmup: 2,
      measured: 5,
    });
    for (const cell of fourCells) {
      for (const arm of twoArms) {
        const own = plan.filter(
          (p) => p.scenario_id === cell.scenario_id && p.implementation === arm,
        );
        expect(own.map((p) => p.warmup)).toEqual([true, true, false, false, false, false, false]);
      }
    }
  });

  test("index increases monotonically", () => {
    const plan = planCaptureInvocations({
      cells: fourCells,
      arms: twoArms,
      warmup: 2,
      measured: 3,
    });
    for (let i = 0; i < plan.length; i++) {
      expect(plan[i]!.index).toBe(i);
    }
  });
});

describe("nextInvocationStart", () => {
  test("spaces invocations by the preregistered interval", () => {
    const prev = new Date("2026-08-18T10:00:05.000Z");
    const next = nextInvocationStart(prev, prev);
    expect(next.getTime() - prev.getTime()).toBeGreaterThanOrEqual(
      WORKLOAD_CEILING_STUDY.capture.invocation_spacing_seconds * 1000,
    );
  });

  test("no two consecutive starts ever share a minute bucket", () => {
    let prev: Date | null = null;
    for (let i = 0; i < 200; i++) {
      const next = nextInvocationStart(prev, prev ?? new Date("2026-08-18T10:00:00.000Z"));
      if (prev !== null) {
        expect(Math.floor(next.getTime() / 60_000)).not.toBe(Math.floor(prev.getTime() / 60_000));
      }
      prev = next;
    }
  });

  test("never starts in the last 10 seconds of a minute", () => {
    // Straddling a boundary puts a raw-datetime telemetry row in the NEXT
    // bucket, outside the window derived from the start instant.
    let prev: Date | null = null;
    for (let i = 0; i < 200; i++) {
      const next = nextInvocationStart(prev, prev ?? new Date("2026-08-18T10:00:51.000Z"));
      expect(next.getUTCSeconds()).toBeLessThan(60 - MINUTE_TAIL_GUARD_SECONDS);
      prev = next;
    }
  });

  test("if candidate is in the past, returns now adjusted for guard", () => {
    const prev = new Date("2026-08-18T10:00:00.000Z");
    const now = new Date("2026-08-18T10:02:30.000Z"); // 2.5 minutes later
    const next = nextInvocationStart(prev, now);
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(next.getUTCSeconds()).toBeLessThan(60 - MINUTE_TAIL_GUARD_SECONDS);
  });
});

describe("invokeWorker", () => {
  const planned = {
    scenario_id: "byte-axis/512KiB",
    implementation: "monolithic-control" as const,
    fixture_prefix: "fixtures/512KiB",
    warmup: true,
    index: 0,
  };

  // The journal's run_id must be the run_id the Worker actually received
  // and logged as `workload_ceiling_run_id` — otherwise the ticket 6
  // independent dashboard join (Workers Logs line ↔ collected event) can
  // never match, and "correlation field" is reduced to a shape check.
  test("returns the run_id it sent, so journal records correlate to invocations", async () => {
    const bodies: string[] = [];
    const fetchStub = vi.fn<(_url: unknown, init: RequestInit | undefined) => Promise<Response>>(
      async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ row_count: 253, isolate_cold: true }), {
          status: 200,
        });
      },
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await invokeWorker("https://example.invalid/run", "secret", planned);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const sent = decodeWorkloadCeilingRunRequest(bodies[0]!);
      expect(result.runId).toBe(sent.run_id);
      expect(result.status).toBe(200);
      expect(result.rowCount).toBe(253);
      expect(result.isolateCold).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A 200 the runner cannot read is a broken Worker, not a warm zero-row
  // invocation. Defaulting it to row_count 0 / isolate_cold false would
  // journal a "warm" sample and hide the defect behind a thermal class the
  // study correlates against.
  test("a 2xx whose body does not parse reports no result rather than defaults", async () => {
    const fetchStub = vi.fn<() => Promise<Response>>(
      async () => new Response("<html>upstream proxy error</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await invokeWorker("https://example.invalid/run", "secret", planned);
      expect(result.status).toBe(200);
      expect(result.rowCount).toBeNull();
      expect(result.isolateCold).toBeNull();
      expect(result.bodyText).toBe("<html>upstream proxy error</html>");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a 2xx missing isolate_cold reports no result rather than assuming warm", async () => {
    const fetchStub = vi.fn<() => Promise<Response>>(
      async () => new Response(JSON.stringify({ row_count: 253 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await invokeWorker("https://example.invalid/run", "secret", planned);
      expect(result.isolateCold).toBeNull();
      expect(result.rowCount).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A non-2xx must not be followed by a second POST just to read the body —
  // every stray invocation is real telemetry that can collapse into another
  // sample's minute bucket.
  test("on non-2xx, reads the body from the same response without re-invoking", async () => {
    const fetchStub = vi.fn<() => Promise<Response>>(
      async () => new Response("fixture descriptor is missing", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await invokeWorker("https://example.invalid/run", "secret", planned);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(502);
      expect(result.bodyText).toBe("fixture descriptor is missing");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("armOutputDir", () => {
  // Aggregate reads `<resultsDir>/<sweepId>/<arm>/` (ticket 5 spec). Events
  // carry no sweep_id field, so if collect-batch ever writes a flat
  // `<resultsDir>/<arm>/` again, sweeps silently mix and aggregate ENOENTs.
  test("scopes collected events under the sweep id, as aggregate reads them", () => {
    const dir = armOutputDir(
      "bench/results/workload-ceiling",
      "lane-b-rehearsal-free-20260820",
      "monolithic-control",
    );
    expect(dir.endsWith("lane-b-rehearsal-free-20260820/monolithic-control")).toBe(true);
    expect(dir.includes("/lane-b-rehearsal-free-20260820/")).toBe(true);
  });
});

describe("isFinishedCollection", () => {
  // Evidence-contract v2. The batch collector's idempotency question is no
  // longer "did a usable measurement land" but "is the AUTHORITATIVE record
  // resolved, and is anything still fixable by re-querying" — see
  // workload-ceiling-collect-batch.ts for the full rule.
  const event = (overrides: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent => ({
    evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
    run_id: "run-1",
    scenario_id: "byte-axis/1MiB",
    script_version: "027034f3-170b-466d-b1ad-914fad42024c",
    compatibility_date: "2026-08-15",
    runtime_period: "2026-08-24T17:35:00.000Z/2026-08-24T17:36:00.000Z",
    colo: "EWR",
    thermal_class: "warm",
    outcome: "success",
    cpu_ms: 17.767,
    observed_at: "2026-08-24T17:53:54.083Z",
    evidence: {
      status: "resolved",
      detail: null,
      authority: "workers-observability",
      authoritative_outcome: "ok",
      authoritative_cpu_ms: 18,
      authoritative_response_status: 200,
      cpu_source: "workers-invocations-adaptive",
      cpu_outcome_verbatim: "success",
    },
    ...overrides,
  });

  test("a resolved event is finished — do not re-query its window", () => {
    expect(isFinishedCollection(event({}))).toBe(true);
  });

  test("an evidence-missing event is NOT finished — the retry pass must re-query it", () => {
    expect(
      isFinishedCollection(
        event({
          outcome: null,
          cpu_ms: null,
          script_version: "unresolved",
          colo: "unknown",
          evidence: {
            status: "missing",
            detail: "no workers-observability join line for run_id in window",
            authority: "workers-observability",
            authoritative_outcome: null,
            authoritative_cpu_ms: null,
            authoritative_response_status: null,
            cpu_source: "none",
            cpu_outcome_verbatim: null,
          },
        }),
      ),
    ).toBe(false);
  });

  test("a resolved success still missing its CPU row is not finished — lag is still possible", () => {
    expect(
      isFinishedCollection(
        event({
          cpu_ms: null,
          evidence: {
            status: "resolved",
            detail: null,
            authority: "workers-observability",
            authoritative_outcome: "ok",
            authoritative_cpu_ms: 18,
            authoritative_response_status: 200,
            cpu_source: "none",
            cpu_outcome_verbatim: null,
          },
        }),
      ),
    ).toBe(false);
  });

  test("a resolved exceededCpu event IS finished — a kill is terminal, not lag", () => {
    // The v1 behavior counted any non-usable measurement as unfinished; v2
    // reads the evidence block instead. An authoritative kill cannot be
    // un-killed by re-querying its window.
    expect(isFinishedCollection(event({ outcome: "exceededCpu", cpu_ms: 50 }))).toBe(true);
  });

  test("nothing collected yet is not finished", () => {
    expect(isFinishedCollection(undefined)).toBe(false);
  });
});

describe("collectionWindowFor", () => {
  test("spans exactly the minute containing the invocation", () => {
    const w = collectionWindowFor(new Date("2026-08-18T10:07:31.482Z"));
    expect(w.gte).toBe("2026-08-18T10:07:00.000Z");
    expect(w.lt).toBe("2026-08-18T10:08:00.000Z");
  });

  test("includes a row timestamped at the bucket start", () => {
    // The reason this is a whole-minute window and not [invoke, return]:
    // datetime_geq is inclusive of gte, so a minute-bucketed row survives.
    const w = collectionWindowFor(new Date("2026-08-18T10:07:31.482Z"));
    expect(Date.parse("2026-08-18T10:07:00.000Z")).toBeGreaterThanOrEqual(Date.parse(w.gte));
    expect(Date.parse("2026-08-18T10:07:00.000Z")).toBeLessThan(Date.parse(w.lt));
  });

  test("includes a row timestamped at the bucket end", () => {
    const w = collectionWindowFor(new Date("2026-08-18T10:07:00.500Z"));
    // The window ends at 10:08:00.000, exclusive
    expect(Date.parse("2026-08-18T10:07:59.999Z")).toBeGreaterThanOrEqual(Date.parse(w.gte));
    expect(Date.parse("2026-08-18T10:07:59.999Z")).toBeLessThan(Date.parse(w.lt));
  });

  test("handles invocation exactly at minute boundary", () => {
    const w = collectionWindowFor(new Date("2026-08-18T10:07:00.000Z"));
    expect(w.gte).toBe("2026-08-18T10:07:00.000Z");
    expect(w.lt).toBe("2026-08-18T10:08:00.000Z");
  });
});

describe("remainingCaptureInvocations", () => {
  const cells = ["byte-axis/512KiB", "byte-axis/1MiB"].map((scenario_id) => ({
    scenario_id,
    axis: "byte" as const,
    target_bytes: 524288,
    achieved_bytes: 524288,
    row_count: 1,
    document_bytes: 2048,
    manifest_descriptors: 8,
    fixture_prefix: `fixtures/${scenario_id}`,
    incarnation: "incarnation",
    monolithic_key: "monolithic",
    manifest_key: "manifest",
    descriptor_canonical_hash: "hash",
  }));
  const planned = planCaptureInvocations({
    cells,
    arms: ["monolithic-control", "chunked-candidate"],
    warmup: 1,
    measured: 3,
  });

  const journalled = (invocation: (typeof planned)[number]): WorkloadCeilingInvocationRecord => ({
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    sweep_id: "sweep-1",
    // A UUID, exactly as the runner mints it — the point of the helper is that
    // it never has to match this against anything.
    run_id: "0a5c6f8e-6f2a-4a1e-9f0a-2c3d4e5f6a7b",
    scenario_id: invocation.scenario_id,
    implementation: invocation.implementation,
    fixture_prefix: invocation.fixture_prefix,
    warmup: invocation.warmup,
    invoked_at: "2026-08-20T00:00:00.000Z",
    window_gte: "2026-08-20T00:00:00.000Z",
    window_lt: "2026-08-20T00:01:00.000Z",
    http_status: 200,
    row_count: 253,
    thermal_class: "warm",
  });

  test("an empty journal leaves the whole plan outstanding", () => {
    expect(remainingCaptureInvocations(planned, [])).toEqual(planned);
  });

  test("a complete journal leaves nothing outstanding", () => {
    // The regression: an earlier revision matched the journal's random
    // `run_id` against a synthetic `scenario-impl-index` key, which can never
    // be equal — so resume re-ran every completed invocation, doubling both
    // the attended hours and the telemetry the collector must disambiguate.
    expect(remainingCaptureInvocations(planned, planned.map(journalled))).toEqual([]);
  });

  test("resume drops exactly the completed prefix of each slot, warmups included", () => {
    const done = planned.slice(0, 5);
    const remaining = remainingCaptureInvocations(planned, done.map(journalled));
    expect(remaining).toHaveLength(planned.length - done.length);
    expect(remaining).toEqual(planned.slice(5));
  });

  test("a slot's warmup and measured invocations are counted separately", () => {
    // `exclusion_policy` is warmup-tagged-before-run-only, so a journalled
    // warmup must not retire a measured invocation of the same cell and arm.
    const oneWarmup = planned.filter((p) => p.warmup).slice(0, 1);
    const remaining = remainingCaptureInvocations(planned, oneWarmup.map(journalled));
    expect(remaining.filter((p) => p.warmup)).toHaveLength(
      planned.filter((p) => p.warmup).length - 1,
    );
    expect(remaining.filter((p) => !p.warmup)).toHaveLength(
      planned.filter((p) => !p.warmup).length,
    );
  });
});

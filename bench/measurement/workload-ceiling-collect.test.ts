import { describe, expect, test } from "vitest";
import {
  decodeWorkloadCeilingRawEvent,
  encodeWorkloadCeilingRawEvent,
  WorkloadCeilingHarnessError,
} from "./workload-ceiling-harness.ts";
import {
  extractWorkloadCeilingRawEvent,
  queryWorkersInvocationsAdaptive,
  queryWorkersObservability,
  resolveCollectOutDir,
  resolveCollectWindow,
  WORKLOAD_CEILING_WORKER_NAME,
} from "./workload-ceiling-collect.ts";

const window = { gte: "2026-08-18T00:00:00Z", lt: "2026-08-18T00:01:00Z" };

const envelope = (rows: readonly unknown[]) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

// `scriptVersion` and `coloCode` carry the SAME values as the observability
// summary line below, because in a real capture they do: across the 28
// captured rehearsal pairs under `bench/results/workload-ceiling/`, every
// single-request row agreed with its authoritative record on both. The
// collector requires that agreement before it attributes CPU, so a fixture
// that disagreed would be describing a foreign invocation.
const row = (
  sum: { cpuTimeUs: number; requests: number },
  status = "success",
  dimensions: Record<string, unknown> = {},
) => ({
  dimensions: {
    datetime: "2026-08-18T00:00:10.000Z",
    scriptName: "baerly-storage",
    scriptVersion: "027034f3-170b-466d-b1ad-914fad42024c",
    status,
    coloCode: "EWR",
    ...dimensions,
  },
  sum,
});

// ---------------------------------------------------------------------------
// Workers Observability response builders. Field names and shapes are pinned
// from the live 2026-08-24 rehearsal-window validation (sanitized: no
// credentials, no request headers) — see runbooks/lane-b-preflight.md Q5.
// ---------------------------------------------------------------------------

/** The Worker's own structured join line: carries the run identifiers, no outcome/cpu. */
const joinLine = (runId: string, requestId = "req-1") => ({
  dataset: "cloudflare-workers",
  timestamp: 1_787_592_920_061,
  source: {
    level: "info",
    message: "",
    workload_ceiling_run_id: runId,
    workload_ceiling_scenario_id: "scen-1",
    workload_ceiling_implementation: "monolithic-control",
    workload_ceiling_isolate_cold: false,
  },
  $workers: {
    eventType: "fetch",
    requestId,
    scriptVersion: { id: "027034f3-170b-466d-b1ad-914fad42024c" },
  },
});

/** The platform fetch-summary line: carries outcome/cpuTimeMs/colo/responseStatus. */
const summaryLine = (requestId = "req-1", over: Record<string, unknown> = {}) => ({
  dataset: "cloudflare-workers",
  timestamp: 1_787_592_920_308,
  source: {
    level: "info",
    message: "POST https://baerly-storage.baerly-free-eval.workers.dev/run",
  },
  $workers: {
    eventType: "fetch",
    requestId,
    outcome: "ok",
    cpuTimeMs: 7,
    wallTimeMs: 256,
    scriptVersion: { id: "027034f3-170b-466d-b1ad-914fad42024c" },
    event: { request: { cf: { colo: "EWR" } }, response: { status: 200 } },
    ...over,
  },
});

const obsEnvelope = (events: readonly unknown[]) => ({
  success: true,
  result: { events: { events, count: events.length, fields: [] }, run: {}, statistics: {} },
});

const input = (observabilityResponse: unknown, adaptiveResponse: unknown) => ({
  observabilityResponse,
  adaptiveResponse,
  run_id: "run-1",
  scenario_id: "scen-1",
  compatibility_date: "2026-08-15",
  window,
  observed_at: "2026-08-18T00:02:00Z",
});

const resolvedInput = (
  over: {
    readonly summary?: Record<string, unknown>;
    readonly adaptiveRows?: readonly unknown[];
    readonly obsEvents?: readonly unknown[];
  } = {},
) =>
  input(
    obsEnvelope(over.obsEvents ?? [joinLine("run-1"), summaryLine("req-1", over.summary)]),
    envelope(over.adaptiveRows ?? [row({ cpuTimeUs: 7_269, requests: 1 })]),
  );

describe("extractWorkloadCeilingRawEvent", () => {
  test("a joined observability pair plus an adaptive row resolves every field with provenance", () => {
    const event = extractWorkloadCeilingRawEvent(resolvedInput());
    // Canonical outcome (Observability's literal is "ok"), CPU in ms from the
    // adaptive dataset's microseconds.
    expect(event.outcome).toBe("success");
    expect(event.cpu_ms).toBe(7.269);
    expect(event.script_version).toBe("027034f3-170b-466d-b1ad-914fad42024c");
    expect(event.colo).toBe("EWR");
    expect(event.runtime_period).toBe(`${window.gte}/${window.lt}`);
    expect(event.evidence.status).toBe("resolved");
    expect(event.evidence.authority).toBe("workers-observability");
    expect(event.evidence.authoritative_outcome).toBe("ok");
    expect(event.evidence.authoritative_cpu_ms).toBe(7);
    expect(event.evidence.authoritative_response_status).toBe(200);
    expect(event.evidence.cpu_source).toBe("workers-invocations-adaptive");
    expect(event.evidence.cpu_outcome_verbatim).toBe("success");
  });

  test("a missing adaptive row with complete successful observability is NOT an execution failure", () => {
    // The rehearsal's actual failure mode: workersInvocationsAdaptive
    // permanently dropped the row; Workers Observability recorded the
    // invocation in full. The event records a successful execution with
    // CPU-measurement missingness — never a fabricated failure.
    const event = extractWorkloadCeilingRawEvent(resolvedInput({ adaptiveRows: [] }));
    expect(event.evidence.status).toBe("resolved");
    expect(event.outcome).toBe("success");
    expect(event.cpu_ms).toBeNull();
    expect(event.evidence.cpu_source).toBe("none");
    expect(event.evidence.cpu_outcome_verbatim).toBeNull();
    expect(decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(event))).toEqual(event);
  });

  test.each([
    ["a different deployment", { scriptVersion: "9a1122b4-0000-4000-8000-000000000000" }],
    ["a different colo", { coloCode: "SEA" }],
  ])("a single-request row from %s supplies no CPU for this invocation", (_case, dimensions) => {
    // The attribution failure this guards: the study Worker has ONE fixed
    // name, so "exactly one single-request row in the window" does not mean
    // "this run's row". With this run's row dropped and a foreign
    // invocation's landing in the same window, cardinality passes and that
    // invocation's CPU would be stamped on this run_id — invisibly, because
    // both outcomes are `success`.
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        adaptiveRows: [row({ cpuTimeUs: 40_000, requests: 1 }, "success", dimensions)],
      }),
    );
    // The outcome is still authoritative — it comes from the observability
    // pair joined by run_id, which the foreign row cannot touch.
    expect(event.evidence.status).toBe("resolved");
    expect(event.outcome).toBe("success");
    expect(event.cpu_ms).toBeNull();
    expect(event.evidence.cpu_source).toBe("none");
    expect(event.evidence.cpu_outcome_verbatim).toBeNull();
  });

  test("a foreign row's diverging outcome does not make this invocation ambiguous", () => {
    // Excluded from the divergence check as well: a row that is not this
    // invocation's says nothing about whether the two sources disagree
    // about this invocation, and reading it as disagreement would discard a
    // perfectly good authoritative record.
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        adaptiveRows: [row({ cpuTimeUs: 40_000, requests: 1 }, "exceededCpu", { coloCode: "SEA" })],
      }),
    );
    expect(event.evidence.status).toBe("resolved");
    expect(event.outcome).toBe("success");
    expect(event.evidence.cpu_source).toBe("none");
  });

  test("a missing authoritative observability event blocks evidence completeness", () => {
    const event = extractWorkloadCeilingRawEvent(input(obsEnvelope([]), envelope([])));
    expect(event.evidence.status).toBe("missing");
    expect(event.evidence.detail).toMatch(/join line/i);
    expect(event.outcome).toBeNull();
    expect(event.script_version).toBe("unresolved");
    expect(event.colo).toBe("unknown");
    expect(event.cpu_ms).toBeNull();
    expect(event.evidence.authoritative_outcome).toBeNull();
  });

  test("duplicate authoritative join lines are ambiguous, never a guess", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        obsEvents: [joinLine("run-1", "req-1"), joinLine("run-1", "req-2"), summaryLine("req-1")],
      }),
    );
    expect(event.evidence.status).toBe("ambiguous");
    expect(event.evidence.detail).toMatch(/2 join lines/i);
    expect(event.outcome).toBeNull();
  });

  test("duplicate summary lines for one requestId are ambiguous", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        obsEvents: [joinLine("run-1"), summaryLine("req-1"), summaryLine("req-1")],
      }),
    );
    expect(event.evidence.status).toBe("ambiguous");
    expect(event.outcome).toBeNull();
  });

  test("a join line with no platform summary line is missing evidence", () => {
    const event = extractWorkloadCeilingRawEvent(resolvedInput({ obsEvents: [joinLine("run-1")] }));
    expect(event.evidence.status).toBe("missing");
    expect(event.evidence.detail).toMatch(/summary/i);
  });

  test("a summary line without scriptVersion or colo is ambiguous, not resolved-with-holes", () => {
    const noVersion = extractWorkloadCeilingRawEvent(
      resolvedInput({ summary: { scriptVersion: {} } }),
    );
    expect(noVersion.evidence.status).toBe("ambiguous");
    const noColo = extractWorkloadCeilingRawEvent(
      resolvedInput({ summary: { event: { request: {}, response: { status: 200 } } } }),
    );
    expect(noColo.evidence.status).toBe("ambiguous");
  });

  test("an unrecognized observability shape is missing evidence, never a throw", () => {
    const event = extractWorkloadCeilingRawEvent(input({}, envelope([])));
    expect(event.evidence.status).toBe("missing");
  });

  test("exceededCpu stays an execution failure even though a partial CPU value exists", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        summary: { outcome: "exceededCpu", cpuTimeMs: 10 },
        adaptiveRows: [row({ cpuTimeUs: 9_800, requests: 1 }, "exceededCpu")],
      }),
    );
    expect(event.outcome).toBe("exceededCpu");
    expect(event.evidence.authoritative_outcome).toBe("exceededCpu");
    // The partial CPU is preserved as a censored observation with its source.
    expect(event.cpu_ms).toBe(9.8);
    expect(event.evidence.cpu_source).toBe("workers-invocations-adaptive");
    expect(event.evidence.cpu_outcome_verbatim).toBe("exceededCpu");
  });

  test("a divergent CPU-source status is ambiguous — the sources disagree about the invocation", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({ adaptiveRows: [row({ cpuTimeUs: 1_000, requests: 1 }, "exceededCpu")] }),
    );
    expect(event.evidence.status).toBe("ambiguous");
    expect(event.evidence.detail).toMatch(/diverg/i);
    expect(event.outcome).toBeNull();
  });

  test("an adaptive row aggregating multiple requests supplies no attributable CPU", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({ adaptiveRows: [row({ cpuTimeUs: 25_000, requests: 2 })] }),
    );
    expect(event.evidence.status).toBe("resolved");
    expect(event.outcome).toBe("success");
    expect(event.cpu_ms).toBeNull();
    expect(event.evidence.cpu_source).toBe("none");
  });

  test("multiple adaptive rows supply no attributable CPU", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({
        adaptiveRows: [
          row({ cpuTimeUs: 1_000, requests: 1 }),
          row({ cpuTimeUs: 2_000, requests: 1 }),
        ],
      }),
    );
    expect(event.outcome).toBe("success");
    expect(event.cpu_ms).toBeNull();
    expect(event.evidence.cpu_source).toBe("none");
  });

  test("an uncanonicalizable platform outcome literal passes through and reads as non-success", () => {
    const event = extractWorkloadCeilingRawEvent(
      resolvedInput({ summary: { outcome: "brandNewOutcomeLiteral" } }),
    );
    expect(event.outcome).toBe("brandNewOutcomeLiteral");
    expect(event.evidence.authoritative_outcome).toBe("brandNewOutcomeLiteral");
  });
});

describe("extractWorkloadCeilingRawEvent — correlation field plumbing", () => {
  // Every field `WorkloadCeilingRawEvent` carries must trace to a specific
  // input — either the collector's own call-site arguments (run_id,
  // scenario_id, compatibility_date, the window, observed_at, thermal_class)
  // or one of the two platform responses — never a value invented by this
  // function. Each assertion below pins one field to its source so a future
  // edit that silently drops or swaps a field fails here, not in a live run.
  test("a resolved event's every field traces to its declared source", () => {
    const event = extractWorkloadCeilingRawEvent(resolvedInput());
    // From the collector's call-site input, not the platform rows.
    expect(event.run_id).toBe("run-1");
    expect(event.scenario_id).toBe("scen-1");
    expect(event.compatibility_date).toBe("2026-08-15");
    expect(event.runtime_period).toBe(`${window.gte}/${window.lt}`);
    expect(event.observed_at).toBe("2026-08-18T00:02:00Z");
    // From the observability summary line, not the collector's input.
    expect(event.script_version).toBe("027034f3-170b-466d-b1ad-914fad42024c");
    expect(event.colo).toBe("EWR");
    expect(event.outcome).toBe("success");
    // Derived from the adaptive row: cpuTimeUs (microseconds) / 1000 = cpu_ms.
    expect(event.cpu_ms).toBe(7.269);
    // Reserved for the caller's warm/cold classification.
    expect(event.thermal_class).toBe("unknown");
  });

  test("an evidence-missing event still carries the caller's correlation fields", () => {
    const event = extractWorkloadCeilingRawEvent(input(obsEnvelope([]), envelope([])));
    expect(event.run_id).toBe("run-1");
    expect(event.scenario_id).toBe("scen-1");
    expect(event.compatibility_date).toBe("2026-08-15");
    expect(event.runtime_period).toBe(`${window.gte}/${window.lt}`);
    expect(event.observed_at).toBe("2026-08-18T00:02:00Z");
    expect(event.script_version).toBe("unresolved");
    expect(event.colo).toBe("unknown");
    expect(event.outcome).toBeNull();
    expect(event.cpu_ms).toBeNull();
  });

  test("a resolved event round-trips through the strict codec unchanged", () => {
    const event = extractWorkloadCeilingRawEvent(resolvedInput());
    expect(decodeWorkloadCeilingRawEvent(encodeWorkloadCeilingRawEvent(event))).toEqual(event);
  });

  test("a distinct run_id/scenario_id pair is threaded through untouched, not confused with another run's", () => {
    const event = extractWorkloadCeilingRawEvent({
      ...resolvedInput(),
      run_id: "9f8e7d6c-0000-4000-8000-000000000001",
      scenario_id: "byte-axis/collection-4mib/doc-512/cold-key",
    });
    expect(event.run_id).toBe("9f8e7d6c-0000-4000-8000-000000000001");
    expect(event.scenario_id).toBe("byte-axis/collection-4mib/doc-512/cold-key");
  });
});

describe("extractWorkloadCeilingRawEvent — thermal class plumbing", () => {
  test("stamps a caller-supplied thermal class onto the derived event", () => {
    const event = extractWorkloadCeilingRawEvent({
      ...resolvedInput(),
      thermal_class: "cold",
    });
    expect(event.thermal_class).toBe("cold");
  });

  test("records unknown when the caller supplies none", () => {
    const event = extractWorkloadCeilingRawEvent(resolvedInput());
    expect(event.thermal_class).toBe("unknown");
  });

  test("an evidence-missing event still carries the caller's classification", () => {
    const event = extractWorkloadCeilingRawEvent({
      ...input(obsEnvelope([]), envelope([])),
      thermal_class: "warm",
    });
    expect(event.evidence.status).toBe("missing");
    expect(event.thermal_class).toBe("warm");
  });
});

describe("queryWorkersObservability", () => {
  test("queries the fixed study service over the exact window, in epoch milliseconds", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(obsEnvelope([])), { status: 200 });
    }) as typeof fetch;

    await queryWorkersObservability({
      accountTag: "acct",
      apiToken: "tok",
      window,
      fetchImpl: fetchStub,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/accounts/acct/workers/observability/telemetry/query");
    expect(calls[0]!.body).toMatchObject({
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          { key: "$metadata.service", operation: "eq", value: WORKLOAD_CEILING_WORKER_NAME },
        ],
      },
      view: "events",
    });
    const timeframe = (calls[0]!.body as { timeframe: { from: number; to: number } }).timeframe;
    expect(timeframe.from).toBe(Date.parse(window.gte));
    expect(timeframe.to).toBe(Date.parse(window.lt));
  });

  test("a non-ok HTTP response throws with the status", async () => {
    const fetchStub = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await expect(
      queryWorkersObservability({
        accountTag: "acct",
        apiToken: "tok",
        window,
        fetchImpl: fetchStub,
      }),
    ).rejects.toThrow("HTTP 403");
  });

  test("an HTTP 200 with success:false throws instead of reading as zero events", async () => {
    // Otherwise an auth or scope failure would silently become "evidence
    // missing" for every invocation in the window.
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 10000, message: "bad scope" }] }),
        { status: 200 },
      )) as typeof fetch;
    await expect(
      queryWorkersObservability({
        accountTag: "acct",
        apiToken: "tok",
        window,
        fetchImpl: fetchStub,
      }),
    ).rejects.toThrow(/observability query failed[\s\S]*bad scope/);
  });
});

describe("resolveCollectOutDir", () => {
  test("unset falls back to the shared default results directory", () => {
    expect(resolveCollectOutDir({})).toBe("bench/results/workload-ceiling");
  });

  test("blank falls back like unset — a blank dir would resolve to the filesystem root", () => {
    expect(resolveCollectOutDir({ WORKLOAD_CEILING_OUT_DIR: "  " })).toBe(
      "bench/results/workload-ceiling",
    );
  });

  test("a set value is used verbatim, enabling per-implementation directories", () => {
    expect(resolveCollectOutDir({ WORKLOAD_CEILING_OUT_DIR: "bench/results/wc/control" })).toBe(
      "bench/results/wc/control",
    );
  });
});

describe("queryWorkersInvocationsAdaptive", () => {
  test("queries the fixed study scriptName with the exact window", async () => {
    const calls: unknown[] = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(envelope([])), { status: 200 });
    }) as typeof fetch;

    await queryWorkersInvocationsAdaptive({
      accountTag: "acct",
      apiToken: "tok",
      window,
      fetchImpl: fetchStub,
    });

    expect(calls).toEqual([
      {
        query: expect.stringContaining("workersInvocationsAdaptive"),
        variables: {
          accountTag: "acct",
          scriptName: WORKLOAD_CEILING_WORKER_NAME,
          gte: window.gte,
          lt: window.lt,
        },
      },
    ]);
  });

  test("a non-ok HTTP response throws with the status", async () => {
    const fetchStub = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await expect(
      queryWorkersInvocationsAdaptive({
        accountTag: "acct",
        apiToken: "tok",
        window,
        fetchImpl: fetchStub,
      }),
    ).rejects.toThrow("HTTP 403");
  });

  test("a 200 carrying GraphQL errors throws instead of returning a null-data envelope", async () => {
    // Cloudflare's Analytics API reports query-level failures — an unknown
    // field, an out-of-scope token — as HTTP 200 with {errors, data: null}.
    // Returning that body would let the row reader read it as zero rows and
    // record a legitimate-looking CPU-missing sample, silently converting an
    // auth or schema mistake into study evidence.
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "authentication error", path: ["viewer", "accounts"] }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await expect(
      queryWorkersInvocationsAdaptive({
        accountTag: "acct",
        apiToken: "tok",
        window,
        fetchImpl: fetchStub,
      }),
    ).rejects.toThrow(/GraphQL query returned errors[\s\S]*authentication error/);
  });

  test("a 200 with an empty errors array is not treated as a failure", async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ ...envelope([]), errors: [] }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      queryWorkersInvocationsAdaptive({
        accountTag: "acct",
        apiToken: "tok",
        window,
        fetchImpl: fetchStub,
      }),
    ).resolves.toMatchObject({ errors: [] });
  });
});

describe("resolveCollectWindow", () => {
  const now = new Date("2026-08-18T00:30:00.000Z");

  test("unset defaults to the ten minutes ending now", () => {
    expect(resolveCollectWindow({}, now)).toEqual({
      gte: "2026-08-18T00:20:00.000Z",
      lt: "2026-08-18T00:30:00.000Z",
    });
  });

  test("an explicit end still defaults the start ten minutes before it", () => {
    expect(
      resolveCollectWindow({ WORKLOAD_CEILING_WINDOW_END: "2026-08-18T00:05:00Z" }, now),
    ).toEqual({ gte: "2026-08-17T23:55:00.000Z", lt: "2026-08-18T00:05:00.000Z" });
  });

  test.each([
    ["WORKLOAD_CEILING_WINDOW_END", { WORKLOAD_CEILING_WINDOW_END: "not-a-timestamp" }],
    ["WORKLOAD_CEILING_WINDOW_START", { WORKLOAD_CEILING_WINDOW_START: "yesterday-ish" }],
  ] as const)("a malformed %s fails by name, not as a bare RangeError", (field, env) => {
    try {
      resolveCollectWindow(env, now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkloadCeilingHarnessError);
      expect((error as WorkloadCeilingHarnessError).field).toBe(field);
    }
  });

  test("an inverted window is rejected — it would resolve no rows and read as a missed run", () => {
    try {
      resolveCollectWindow(
        {
          WORKLOAD_CEILING_WINDOW_START: "2026-08-18T00:10:00Z",
          WORKLOAD_CEILING_WINDOW_END: "2026-08-18T00:05:00Z",
        },
        now,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkloadCeilingHarnessError);
      expect((error as WorkloadCeilingHarnessError).field).toBe("WORKLOAD_CEILING_WINDOW_START");
    }
  });

  test("a blank value falls back to the default like unset", () => {
    expect(resolveCollectWindow({ WORKLOAD_CEILING_WINDOW_END: "   " }, now).lt).toBe(
      "2026-08-18T00:30:00.000Z",
    );
  });
});

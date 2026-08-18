import { describe, expect, test } from "vitest";
import {
  extractWorkloadCeilingRawEvent,
  queryWorkersInvocationsAdaptive,
  resolveCollectOutDir,
  WORKLOAD_CEILING_WORKER_NAME,
} from "./workload-ceiling-collect.ts";

const window = { gte: "2026-08-18T00:00:00Z", lt: "2026-08-18T00:01:00Z" };

const envelope = (rows: readonly unknown[]) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

const row = (sum: { cpuTime: number; requests: number }) => ({
  dimensions: {
    datetime: "2026-08-18T00:00:10.000Z",
    scriptName: "baerly-storage",
    scriptVersion: "v1.2.3",
    status: "ok",
    coloCode: "SJC",
  },
  sum,
});

const input = (graphqlResponse: unknown) => ({
  graphqlResponse,
  run_id: "run-1",
  scenario_id: "scen-1",
  compatibility_date: "2026-08-15",
  window,
  observed_at: "2026-08-18T00:02:00Z",
});

describe("extractWorkloadCeilingRawEvent", () => {
  test("maps exactly one single-request row to a resolved event", () => {
    const event = extractWorkloadCeilingRawEvent(
      input(envelope([row({ cpuTime: 12_345, requests: 1 })])),
    );
    expect(event.outcome).toBe("ok");
    expect(event.cpu_ms).toBe(12.345);
    expect(event.script_version).toBe("v1.2.3");
    expect(event.colo).toBe("SJC");
    expect(event.runtime_period).toBe(`${window.gte}/${window.lt}`);
  });

  test("zero rows is an explicit missing-terminal-event", () => {
    const event = extractWorkloadCeilingRawEvent(input(envelope([])));
    expect(event.outcome).toBe("missing-terminal-event");
    expect(event.cpu_ms).toBeNull();
  });

  test("two rows is an explicit missing-terminal-event", () => {
    const event = extractWorkloadCeilingRawEvent(
      input(envelope([row({ cpuTime: 1, requests: 1 }), row({ cpuTime: 2, requests: 1 })])),
    );
    expect(event.outcome).toBe("missing-terminal-event");
  });

  test("a multi-request aggregate row is unresolved, never summed-and-guessed", () => {
    // Two invocations collapsed into one minute bucket would arrive as a
    // single row carrying requests: 2 with summed cpuTime.
    const event = extractWorkloadCeilingRawEvent(
      input(envelope([row({ cpuTime: 25_000, requests: 2 })])),
    );
    expect(event.outcome).toBe("missing-terminal-event");
    expect(event.cpu_ms).toBeNull();
  });

  test("a malformed row is filtered out, not trusted", () => {
    const event = extractWorkloadCeilingRawEvent(input(envelope([{ dimensions: {}, sum: {} }])));
    expect(event.outcome).toBe("missing-terminal-event");
  });

  test("an unrecognized envelope shape is unresolved, never a throw", () => {
    const event = extractWorkloadCeilingRawEvent(input({ data: null }));
    expect(event.outcome).toBe("missing-terminal-event");
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
});

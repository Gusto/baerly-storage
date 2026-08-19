import { describe, test, expect } from "vitest";
import { assembleResult, type PhaseResult } from "../assemble-result.ts";
import { getPreset } from "../presets.ts";
// Side-effect import: registers the preset `getPreset` below resolves.
// eslint-disable-next-line import/no-unassigned-import
import "../presets/recent-first-crud.ts";
import type { StorageSnapshot } from "../../types.ts";

const zeroPhase: PhaseResult = {
  metrics: {
    object_store: {
      get: 0,
      put: 0,
      head: 0,
      list: 0,
      delete: 0,
      bytes_read: 0,
      bytes_written: 0,
      retries: 0,
      conflict_412: 0,
      rate_limit_429: 0,
    },
    latency_ms: { by_op: {} },
    ops_by_prefix: {},
  } satisfies StorageSnapshot,
  wallclockMs: 1,
};

/** Descending, so the assertion also pins that the sample gets sorted. */
const descending = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let v = from; v >= to; v--) {
    out.push(v);
  }
  return out;
};

const assemble = (latencyByOp: Map<string, number[]>): ReturnType<typeof assembleResult> =>
  assembleResult({
    preset: getPreset("recent-first-crud"),
    variant: "memory",
    cacheMode: "metadata-warm",
    records: 10,
    totalOps: 10,
    seed: 42,
    startedIso: "2026-01-01T00:00:00.000Z",
    backendDetails: {},
    seedRes: zeroPhase,
    ingestRes: zeroPhase,
    queryPreRes: zeroPhase,
    compactRes: zeroPhase,
    queryPostRes: zeroPhase,
    cacheStats: { manifestHitRate: 0, snapshotHitRate: 0 },
    latencyByOp,
    tenants: 1,
  });

describe("assembleResult latency percentiles", () => {
  test("maps p50/p95/p99 per op and over the pooled sample", () => {
    // At n=100 (and n=200 pooled) all three ranks discriminate the
    // one-indexed `ceil(q*n)` from a zero-indexed `floor(n*q)` — 50 vs 51,
    // 95 vs 96, 99 vs 100 — so a reverted or swapped quantile fails here
    // rather than coinciding.
    const result = assemble(
      new Map([
        ["list-recent", descending(100, 1)],
        ["insert", descending(200, 101)],
      ]),
    );
    expect(result.latency_ms.by_op["list-recent"]).toEqual({ p50: 50, p95: 95, p99: 99 });
    expect(result.latency_ms.by_op["insert"]).toEqual({ p50: 150, p95: 195, p99: 199 });
    // Pooled across both ops: 1..200.
    expect(result.latency_ms.logical_op).toEqual({ p50: 100, p95: 190, p99: 198 });
  });

  test("reports zeros for an op with no samples and for an empty pooled sample", () => {
    // `quantileNearestRank` throws on an empty sample; the harness reports
    // a zeroed block instead, so this branch must never reach it.
    const result = assemble(new Map([["head", []]]));
    expect(result.latency_ms.by_op["head"]).toEqual({ p50: 0, p95: 0, p99: 0 });
    expect(result.latency_ms.logical_op).toEqual({ p50: 0, p95: 0, p99: 0 });
  });
});

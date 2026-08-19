/**
 * The canonical load-harness `RunResult` shape, and the pure function that
 * assembles one from the five phase snapshots.
 *
 * Lives outside `cli.ts` because that module reads `process.argv` and calls
 * `main()` at import time, so nothing declared there is reachable from a
 * test. Everything here is I/O-free and clock-free.
 */

import type { StorageSnapshot } from "../types.ts";
import type { ManifestCacheMode } from "./stores/manifest-cache.ts";
import type { Preset } from "./presets.ts";

export type Variant = "memory" | "local-fs" | "node-minio" | "cloudflare-r2" | "node-gcs";

export type RunResult = {
  run: {
    preset: string;
    variant: Variant;
    cache_mode: "cold" | "metadata-warm" | "data-warm" | "tiny-cache";
    records: number;
    ops: number;
    seed: number;
    timestamp: string;
    backend_details?: Record<string, string>;
  };
  latency_ms: {
    logical_op: { p50: number; p95: number; p99: number };
    by_op: Record<string, { p50: number; p95: number; p99: number }>;
  };
  object_store: {
    get: number;
    put: number;
    head: number;
    list: number;
    delete: number;
    bytes_read: number;
    bytes_written: number;
    retries: number;
    conflict_412: number;
    rate_limit_429: number;
  };
  derived: {
    get_per_op: number;
    put_per_op: number;
    bytes_read_per_op: number;
    bytes_written_per_op: number;
    class_a_per_tenant_per_hour: number;
  };
  cache: { manifest_hit_rate: number; snapshot_hit_rate: number };
  compaction: {
    bytes_read: number;
    bytes_written: number;
    objects_read: number;
    objects_written: number;
    bytes_ratio: number;
  };
};

export interface PhaseResult {
  readonly metrics: StorageSnapshot;
  readonly wallclockMs: number;
}

export interface AssembleOpts {
  readonly preset: Preset;
  readonly variant: Variant;
  readonly cacheMode: ManifestCacheMode;
  readonly records: number;
  readonly totalOps: number;
  readonly seed: number;
  readonly startedIso: string;
  readonly backendDetails: Record<string, string>;
  readonly seedRes: PhaseResult;
  readonly ingestRes: PhaseResult;
  readonly queryPreRes: PhaseResult;
  readonly compactRes: PhaseResult;
  readonly queryPostRes: PhaseResult;
  readonly cacheStats: { manifestHitRate: number; snapshotHitRate: number };
  readonly latencyByOp: Map<string, number[]>;
  readonly tenants: number;
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = [...arr].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

export function assembleResult(o: AssembleOpts): RunResult {
  const phases = [o.seedRes, o.ingestRes, o.queryPreRes, o.compactRes, o.queryPostRes];
  const sum = (pick: (s: StorageSnapshot) => number): number =>
    phases.reduce((acc, p) => acc + pick(p.metrics), 0);

  const get = sum((s) => s.object_store.get);
  const put = sum((s) => s.object_store.put);
  const head = sum((s) => s.object_store.head);
  const list = sum((s) => s.object_store.list);
  const del = sum((s) => s.object_store.delete);
  const bytesRead = sum((s) => s.object_store.bytes_read);
  const bytesWritten = sum((s) => s.object_store.bytes_written);
  const retries = sum((s) => s.object_store.retries);
  const conflict412 = sum((s) => s.object_store.conflict_412);
  const rateLimit429 = sum((s) => s.object_store.rate_limit_429);

  // Class A idle bound: measured during query-post phase only.
  // Billing-correct — DeleteObject is $0 on R2/S3, so it is excluded
  // (see docs/about/cost-model.md). The idle reader path issues neither
  // PUT nor LIST, so this is 0 on a healthy idle workload.
  const classAInQueryPost =
    o.queryPostRes.metrics.object_store.put + o.queryPostRes.metrics.object_store.list;
  const queryPostHours = Math.max(1e-6, o.queryPostRes.wallclockMs / 3_600_000);
  const classAPerTenantPerHour = classAInQueryPost / Math.max(1, o.tenants) / queryPostHours;

  // Compaction phase isolation.
  const compactObjectsRead = o.compactRes.metrics.object_store.get;
  const compactObjectsWritten = o.compactRes.metrics.object_store.put;
  const compactBytesRead = o.compactRes.metrics.object_store.bytes_read;
  const compactBytesWritten = o.compactRes.metrics.object_store.bytes_written;

  // Per-op latency percentiles.
  const allLatencies: number[] = [];
  const byOp: Record<string, { p50: number; p95: number; p99: number }> = {};
  for (const [kind, arr] of o.latencyByOp) {
    byOp[kind] = { p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99) };
    allLatencies.push(...arr);
  }
  const logicalOp = {
    p50: pct(allLatencies, 0.5),
    p95: pct(allLatencies, 0.95),
    p99: pct(allLatencies, 0.99),
  };

  return {
    run: {
      preset: o.preset.name,
      variant: o.variant,
      cache_mode: o.cacheMode,
      records: o.records,
      ops: o.totalOps,
      seed: o.seed,
      timestamp: o.startedIso,
      backend_details: o.backendDetails,
    },
    latency_ms: { logical_op: logicalOp, by_op: byOp },
    object_store: {
      get,
      put,
      head,
      list,
      delete: del,
      bytes_read: bytesRead,
      bytes_written: bytesWritten,
      retries,
      conflict_412: conflict412,
      rate_limit_429: rateLimit429,
    },
    derived: {
      get_per_op: get / Math.max(1, o.totalOps),
      put_per_op: put / Math.max(1, o.totalOps),
      bytes_read_per_op: bytesRead / Math.max(1, o.totalOps),
      bytes_written_per_op: bytesWritten / Math.max(1, o.totalOps),
      class_a_per_tenant_per_hour: classAPerTenantPerHour,
    },
    cache: {
      manifest_hit_rate: o.cacheStats.manifestHitRate,
      snapshot_hit_rate: o.cacheStats.snapshotHitRate,
    },
    compaction: {
      bytes_read: compactBytesRead,
      bytes_written: compactBytesWritten,
      objects_read: compactObjectsRead,
      objects_written: compactObjectsWritten,
      bytes_ratio: compactBytesWritten / Math.max(1, compactBytesRead),
    },
  };
}

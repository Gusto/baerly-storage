/**
 * Shared shapes for the R2-contention bench harness.
 *
 * The harness lives outside the protocol package (`bench/` is tool,
 * not protocol) so branded types aren't threaded through; plain
 * `string` keys are fine. Every interface is `readonly` so a
 * `RunResult` round-trips through `JSON.stringify` without mutation
 * concerns.
 */

export type Scenario = "S1" | "S2-idle" | "S2-multi" | "S3-toxic" | "S3-sigkill";

export type RetryPolicy = "no-jitter" | "full-jitter" | "decorrelated";

export type Network = "direct" | "wan-50ms" | "loss-5";

export interface SweepCell {
  readonly scenario: Scenario;
  /** S1, S3-toxic only. Ignored for S2-idle / S2-multi. */
  readonly concurrency: number;
  /** S2-idle only. Ignored elsewhere. */
  readonly pollerCount: number;
  /**
   * S2-multi only. Count of independent `current.json` keys the
   * single writer round-robins across. Ignored for every other
   * scenario.
   */
  readonly collections: number;
  readonly retryPolicy: RetryPolicy;
  readonly network: Network;
  /** Wall-clock budget per scenario run, in milliseconds. */
  readonly durationMs: number;
  /** From ticket 60. */
  readonly outDir?: string;
  /** From ticket 60. */
  readonly cellId?: string;
  /** S3-sigkill only. Number of kill-and-enumerate trials. Default 100. */
  readonly trials: number;
  /**
   * S3-sigkill only. After which methodology step the SIGKILL is
   * delivered:
   *   - 1: kill after content PUT, before log PUT (orphan content only)
   *   - 2: kill after log PUT, before CAS (orphan content + log) — methodology default
   */
  readonly killAfterStep: 1 | 2;
}

export interface MetricsSnapshot {
  readonly commit_count: number;
  readonly conflict_412_count: number;
  readonly rate_limit_429_count: number;
  readonly latency_p50_ms: number;
  readonly latency_p99_ms: number;
  readonly latency_p999_ms: number;
  readonly retry_tail_max: number;
}

/**
 * Per-op counter block for a single bench cell. Names mirror the S3 /
 * R2 verb taxonomy (GET, PUT, HEAD, LIST, DELETE). HEAD is always 0
 * in code paths that flow through the current protocol `Storage`
 * interface — the field exists so the run-JSON shape stays stable
 * if a future adapter starts using HEAD.
 */
export interface OpCounts {
  readonly get: number;
  readonly put: number;
  readonly head: number;
  readonly list: number;
  readonly delete: number;
}

/**
 * Per-op latency tail. Nearest-rank percentiles (matches the
 * approach in `bench/metrics.ts`). One block per verb that recorded
 * at least one sample; verbs with no samples are omitted (vs.
 * reported as zero) so the snapshot consumer can tell "verb never
 * happened" from "verb happened in 0ms".
 */
export interface OpLatencyTail {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface OpLatencyByOp {
  readonly get?: OpLatencyTail;
  readonly put?: OpLatencyTail;
  readonly head?: OpLatencyTail;
  readonly list?: OpLatencyTail;
  readonly delete?: OpLatencyTail;
}

/**
 * The `object_store` + `latency_ms` + `ops_by_prefix` portion of the
 * load-harness run-JSON shape. Ticket 54 (load-harness CLI) wraps this
 * inside a larger object with `run`, `derived`, `cache`, and
 * `compaction` blocks. This ticket only owns this inner portion.
 *
 * `ops_by_prefix` is keyed by the first two segments of each key —
 * e.g., `tenant-007/collection-notes` — so the load-bench operator
 * can attribute cost to (tenant, collection) without re-instrumenting
 * the protocol. Keys with fewer than two segments are bucketed under
 * their full key (degenerate but stable).
 */
export interface StorageSnapshot {
  readonly object_store: {
    readonly get: number;
    readonly put: number;
    readonly head: number;
    readonly list: number;
    readonly delete: number;
    readonly bytes_read: number;
    readonly bytes_written: number;
    /**
     * Retries are not tracked at the storage layer (retry policy is
     * owned by the bench harness, not the `Storage` adapter — the
     * harness constructs `S3HttpStorage` with `retries: 0` at
     * `bench/storage.ts:115`). Carried in the shape for run-JSON
     * compatibility; always 0 from this counter.
     */
    readonly retries: number;
    readonly conflict_412: number;
    readonly rate_limit_429: number;
  };
  readonly latency_ms: {
    readonly by_op: OpLatencyByOp;
  };
  readonly ops_by_prefix: Readonly<Record<string, OpCounts>>;
}

export interface RunResult {
  readonly cell: SweepCell;
  readonly started_iso: string;
  readonly wallclock_ms: number;
  readonly effective_throughput_per_sec: number;
  readonly cas_412_rate: number;
  readonly rate_limit_429_rate: number;
  readonly class_a_op_count: number; // PUT + DELETE + LIST
  readonly class_b_op_count: number; // GET (200+304)
  readonly class_a_per_writer_per_hour: number;
  readonly latency_p50_ms: number;
  readonly latency_p99_ms: number;
  readonly latency_p999_ms: number;
  readonly retry_tail_max: number;
  readonly cost_model_bound_holds: boolean; // class_a_per_writer_per_hour < 1
  readonly notes?: string;
}

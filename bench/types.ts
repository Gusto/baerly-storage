/**
 * Shared shapes for the bench storage snapshot (`bench/storage.ts`) and the
 * load harness result.
 */

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
 * approach in `bench/measurement/statistics.ts`). One block per verb that recorded
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
     * owned by the bench harness, not the `Storage` adapter).
     * Carried in the shape for run-JSON
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

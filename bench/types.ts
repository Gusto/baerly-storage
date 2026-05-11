/**
 * Shared shapes for the R2-contention bench harness.
 *
 * The harness lives outside the protocol package (`bench/` is tool,
 * not protocol) so branded types aren't threaded through; plain
 * `string` keys are fine. Every interface is `readonly` so a
 * `RunResult` round-trips through `JSON.stringify` without mutation
 * concerns.
 */

export type Scenario = "S1" | "S2-idle" | "S3-toxic";

export type RetryPolicy = "no-jitter" | "full-jitter" | "decorrelated";

export type Network = "direct" | "wan-50ms" | "loss-5";

export interface SweepCell {
  readonly scenario: Scenario;
  /** S1, S3-toxic only. Ignored for S2-idle (which uses pollerCount). */
  readonly concurrency: number;
  /** S2-idle only. Ignored elsewhere. */
  readonly pollerCount: number;
  readonly retryPolicy: RetryPolicy;
  readonly network: Network;
  /** Wall-clock budget per scenario run, in milliseconds. */
  readonly durationMs: number;
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

/**
 * In-process metric recorder for one bench cell. Tracks commit
 * latency, 412/429 counters, and the max retry tail. Percentiles are
 * nearest-rank — fine for ≤100k samples, which is the worst-case at
 * S1 c=32 × 60s × ~50 ops/sec ≈ 96 000.
 */

import { quantileNearestRank } from "./measurement/statistics.ts";
import type { MetricsSnapshot } from "./types.ts";

export class Metrics {
  private latencies: number[] = []; // ms; one entry per success
  private commits = 0;
  private conflicts412 = 0;
  private rateLimits429 = 0;
  private maxRetryTail = 0;

  recordCommit(latencyMs: number, retriesBeforeCommit: number): void {
    this.commits++;
    this.latencies.push(latencyMs);
    if (retriesBeforeCommit > this.maxRetryTail) {
      this.maxRetryTail = retriesBeforeCommit;
    }
  }

  recordConflict412(): void {
    this.conflicts412++;
  }

  recordRateLimit429(): void {
    this.rateLimits429++;
  }

  snapshot(): MetricsSnapshot {
    const pick = (q: number): number => {
      if (this.latencies.length === 0) {
        return 0;
      }
      return quantileNearestRank(this.latencies, q);
    };
    return {
      commit_count: this.commits,
      conflict_412_count: this.conflicts412,
      rate_limit_429_count: this.rateLimits429,
      latency_p50_ms: pick(0.5),
      latency_p99_ms: pick(0.99),
      latency_p999_ms: pick(0.999),
      retry_tail_max: this.maxRetryTail,
    };
  }
}

import { describe, test, expect } from "vitest";
import { Metrics } from "./metrics.ts";

describe("Metrics.snapshot() percentiles", () => {
  test("computes nearest-rank percentiles for a shuffled 1..10 sample", () => {
    const m = new Metrics();
    for (const latency of [7, 1, 9, 3, 5, 2, 8, 4, 6, 10]) {
      m.recordCommit(latency, 0);
    }
    const snap = m.snapshot();
    // sorted = [1..10], n=10. rank = ceil(q*n), value = sorted[rank-1].
    expect(snap.latency_p50_ms).toBe(5); // rank ceil(0.5*10)=5 -> sorted[4]=5
    expect(snap.latency_p99_ms).toBe(10); // rank ceil(0.99*10)=10 -> sorted[9]=10
    expect(snap.latency_p999_ms).toBe(10); // rank ceil(0.999*10)=10 -> sorted[9]=10
  });

  test("computes nearest-rank percentiles over 1..1000 where every rank lands on an exact integer", () => {
    const m = new Metrics();
    for (let latency = 1000; latency >= 1; latency--) {
      m.recordCommit(latency, 0);
    }
    const snap = m.snapshot();
    // sorted = [1..1000], n=1000. Values equal their own rank, so
    // rank = ceil(q*n) reads off the expected value directly.
    expect(snap.latency_p50_ms).toBe(500); // ceil(0.5*1000)=500
    expect(snap.latency_p99_ms).toBe(990); // ceil(0.99*1000)=990
    expect(snap.latency_p999_ms).toBe(999); // ceil(0.999*1000)=999
  });

  test("clamps rank into [1,n] for a single-sample snapshot", () => {
    const m = new Metrics();
    m.recordCommit(42, 0);
    const snap = m.snapshot();
    expect(snap.latency_p50_ms).toBe(42);
    expect(snap.latency_p99_ms).toBe(42);
    expect(snap.latency_p999_ms).toBe(42);
  });

  test("clamps rank into [1,n] for a two-sample snapshot", () => {
    const m = new Metrics();
    m.recordCommit(10, 0);
    m.recordCommit(20, 0);
    const snap = m.snapshot();
    // n=2. p50: ceil(1)=1 -> sorted[0]=10. p99/p999: ceil(1.98 or 1.998)=2 -> sorted[1]=20.
    expect(snap.latency_p50_ms).toBe(10);
    expect(snap.latency_p99_ms).toBe(20);
    expect(snap.latency_p999_ms).toBe(20);
  });

  test("returns zeroed percentiles when no commits were recorded", () => {
    const m = new Metrics();
    const snap = m.snapshot();
    expect(snap.latency_p50_ms).toBe(0);
    expect(snap.latency_p99_ms).toBe(0);
    expect(snap.latency_p999_ms).toBe(0);
  });

  test("tracks commit_count, conflict/rate-limit counters, and the retry tail alongside percentiles", () => {
    const m = new Metrics();
    m.recordCommit(5, 2);
    m.recordCommit(9, 7);
    m.recordConflict412();
    m.recordConflict412();
    m.recordRateLimit429();
    const snap = m.snapshot();
    expect(snap.commit_count).toBe(2);
    expect(snap.conflict_412_count).toBe(2);
    expect(snap.rate_limit_429_count).toBe(1);
    expect(snap.retry_tail_max).toBe(7);
  });
});

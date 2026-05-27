import { describe, expect, test } from "vitest";
import { RequestScopedMetricsRecorder } from "./recorder.ts";

describe("RequestScopedMetricsRecorder.snapshot", () => {
  test("returns empty arrays before any emission", () => {
    const r = new RequestScopedMetricsRecorder();
    const snap = r.snapshot();
    expect(snap.counters).toEqual([]);
    expect(snap.gauges).toEqual([]);
    expect(snap.histograms).toEqual([]);
  });

  test("appends counter, gauge, and histogram observations in insertion order", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("db.r2.put.412_total", 1, { collection: "tickets" });
    r.counter("db.r2.put.412_total", 2);
    r.gauge("db.manifest.lag_window_depth", 7);
    r.histogram("db.write.class_a_ops_per_logical_write", 3);
    r.histogram("db.write.class_a_ops_per_logical_write", 5);

    const snap = r.snapshot();
    expect(snap.counters).toEqual([
      { name: "db.r2.put.412_total", value: 1, labels: { collection: "tickets" } },
      { name: "db.r2.put.412_total", value: 2, labels: {} },
    ]);
    expect(snap.gauges).toEqual([{ name: "db.manifest.lag_window_depth", value: 7, labels: {} }]);
    expect(snap.histograms).toEqual([
      { name: "db.write.class_a_ops_per_logical_write", value: 3, labels: {} },
      { name: "db.write.class_a_ops_per_logical_write", value: 5, labels: {} },
    ]);
  });

  test("snapshot returns a copy — mutating it doesn't affect future emissions", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("x", 1);
    const snap = r.snapshot();
    // The returned arrays are readonly to TypeScript but are independent
    // copies — the recorder's own state must not be affected by the test
    // pushing into a different array.
    (snap.counters as { length: number }).length = 0;
    r.counter("x", 1);
    expect(r.snapshot().counters.length).toBe(2);
  });
});

describe("RequestScopedMetricsRecorder.summarize", () => {
  test("returns an empty object when nothing has been emitted", () => {
    expect(new RequestScopedMetricsRecorder().summarize()).toEqual({});
  });

  test("sums counters into `<name>_total`", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("db.r2.put.412_total", 1);
    r.counter("db.r2.put.412_total", 2);
    r.counter("db.r2.put.412_total", 3);
    expect(r.summarize()["db.r2.put.412_total"]).toBe(6);
  });

  test("keeps the last gauge value seen per name", () => {
    const r = new RequestScopedMetricsRecorder();
    r.gauge("db.manifest.lag_window_depth", 1);
    r.gauge("db.manifest.lag_window_depth", 9);
    r.gauge("db.manifest.lag_window_depth", 4);
    expect(r.summarize()["db.manifest.lag_window_depth"]).toBe(4);
  });

  test("derives count/sum from histogram observations", () => {
    const r = new RequestScopedMetricsRecorder();
    // 100 observations: 1..100. count = 100, sum = 5050.
    for (let i = 1; i <= 100; i++) {
      r.histogram("h", i);
    }
    const s = r.summarize();
    expect(s["h_count"]).toBe(100);
    expect(s["h_sum"]).toBe(5050);
  });

  test("histogram aggregation on a tiny set", () => {
    const r = new RequestScopedMetricsRecorder();
    r.histogram("h", 10);
    const s = r.summarize();
    expect(s["h_count"]).toBe(1);
    expect(s["h_sum"]).toBe(10);
  });

  test("composes counter + gauge + histogram into one flat object", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("c", 1);
    r.gauge("g", 5);
    r.histogram("h", 2);
    r.histogram("h", 4);
    expect(r.summarize()).toEqual({
      c_total: 1,
      g: 5,
      h_count: 2,
      h_sum: 6,
    });
  });

  test("does not double-append _total to counter names that already end in _total", () => {
    const r = new RequestScopedMetricsRecorder();
    r.counter("db.storage.class_a_ops_total", 3);
    r.counter("db.r2.put.412_total", 1);
    r.counter("db.write.requests_total", 5);
    // A counter without the convention suffix still gets it appended.
    r.counter("custom.events", 2);

    const summary = r.summarize();
    expect(summary["db.storage.class_a_ops_total"]).toBe(3);
    expect(summary["db.r2.put.412_total"]).toBe(1);
    expect(summary["db.write.requests_total"]).toBe(5);
    expect(summary["custom.events_total"]).toBe(2);
    // No double-suffix variants exist.
    expect(summary["db.storage.class_a_ops_total_total"]).toBeUndefined();
    expect(summary["db.r2.put.412_total_total"]).toBeUndefined();
  });
});

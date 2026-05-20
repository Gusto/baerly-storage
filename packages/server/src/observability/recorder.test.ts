import { describe, expect, test } from "vitest";
import { createObservabilityContext, runWithContext } from "./context.ts";
import { InMemoryMetricsRecorder } from "./in-memory-metrics.ts";
import { alsAwareRecorder, RequestScopedMetricsRecorder } from "./recorder.ts";

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

  test("derives p50/p99/count/sum from histogram observations", () => {
    const r = new RequestScopedMetricsRecorder();
    // 100 observations: 1..100. p50 = 50 (nearest-rank ceil),
    // p99 = 99, count = 100, sum = 5050.
    for (let i = 1; i <= 100; i++) {
      r.histogram("h", i);
    }
    const s = r.summarize();
    expect(s["h_p50"]).toBe(50);
    expect(s["h_p99"]).toBe(99);
    expect(s["h_count"]).toBe(100);
    expect(s["h_sum"]).toBe(5050);
  });

  test("histogram percentiles on a tiny set", () => {
    const r = new RequestScopedMetricsRecorder();
    r.histogram("h", 10);
    const s = r.summarize();
    expect(s["h_p50"]).toBe(10);
    expect(s["h_p99"]).toBe(10);
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
      h_p50: 2,
      h_p99: 4,
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

describe("alsAwareRecorder", () => {
  test("emissions outside a context land only in the operator sink", () => {
    const operator = new InMemoryMetricsRecorder();
    const tee = alsAwareRecorder(operator);
    tee.counter("c", 1);
    tee.gauge("g", 5);
    tee.histogram("h", 7);
    expect(operator.counters).toHaveLength(1);
    expect(operator.gauges).toHaveLength(1);
    expect(operator.histograms).toHaveLength(1);
    // Nothing further to assert: outside of `runWithContext` there's
    // no per-request bag to populate.
  });

  test("emissions inside a context land in both operator and per-request bag", async () => {
    const operator = new InMemoryMetricsRecorder();
    const tee = alsAwareRecorder(operator);
    const ctx = createObservabilityContext();

    await runWithContext(ctx, async () => {
      tee.counter("db.r2.put.412_total", 2, { collection: "tickets" });
      tee.gauge("db.manifest.lag_window_depth", 12);
      tee.histogram("db.write.class_a_ops_per_logical_write", 4);
    });

    // Operator saw everything.
    expect(operator.sumCounter("db.r2.put.412_total")).toBe(2);
    expect(operator.lastGauge("db.manifest.lag_window_depth")).toBe(12);
    expect(operator.histogramValues("db.write.class_a_ops_per_logical_write")).toEqual([4]);

    // Per-request bag captured the same emissions; summary reflects
    // suffixes (counter_total, histogram_p50/_p99/_count/_sum).
    const summary = ctx.recorder.summarize();
    expect(summary["db.r2.put.412_total"]).toBe(2);
    expect(summary["db.manifest.lag_window_depth"]).toBe(12);
    expect(summary["db.write.class_a_ops_per_logical_write_count"]).toBe(1);
    expect(summary["db.write.class_a_ops_per_logical_write_sum"]).toBe(4);
  });

  test("nested contexts: emissions land in the innermost ctx's recorder only", async () => {
    const operator = new InMemoryMetricsRecorder();
    const tee = alsAwareRecorder(operator);
    const outer = createObservabilityContext();
    const inner = createObservabilityContext();

    await runWithContext(outer, async () => {
      tee.counter("outer-before", 1);
      await runWithContext(inner, async () => {
        tee.counter("inner-only", 1);
      });
      tee.counter("outer-after", 1);
    });

    // Operator sees all three.
    expect(operator.sumCounter("outer-before")).toBe(1);
    expect(operator.sumCounter("inner-only")).toBe(1);
    expect(operator.sumCounter("outer-after")).toBe(1);

    // Outer bag captured the two outer emissions, not the inner one.
    const outerSummary = outer.recorder.summarize();
    expect(outerSummary["outer-before_total"]).toBe(1);
    expect(outerSummary["outer-after_total"]).toBe(1);
    expect(outerSummary["inner-only_total"]).toBeUndefined();

    // Inner bag captured only the inner emission.
    const innerSummary = inner.recorder.summarize();
    expect(innerSummary["inner-only_total"]).toBe(1);
    expect(innerSummary["outer-before_total"]).toBeUndefined();
    expect(innerSummary["outer-after_total"]).toBeUndefined();
  });

  test("operator emissions happen before the per-request bag", () => {
    const order: string[] = [];
    const operator = {
      counter: (name: string): void => {
        order.push(`op:${name}`);
      },
      gauge: (name: string): void => {
        order.push(`op:${name}`);
      },
      histogram: (name: string): void => {
        order.push(`op:${name}`);
      },
    };
    const ctx = createObservabilityContext();
    // Stamp a marker by intercepting the bag's counter call.
    const origCounter = ctx.recorder.counter.bind(ctx.recorder);
    ctx.recorder.counter = (name, value, labels): void => {
      order.push(`bag:${name}`);
      origCounter(name, value, labels);
    };

    const tee = alsAwareRecorder(operator);
    runWithContext(ctx, () => {
      tee.counter("x", 1);
    });
    expect(order).toEqual(["op:x", "bag:x"]);
  });
});

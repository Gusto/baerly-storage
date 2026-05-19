import { describe, expect, test } from "vitest";
import { InMemoryMetricsRecorder, noopMetricsRecorder, teeMetricsRecorders } from "./metrics.ts";

describe("MetricsRecorder", () => {
  test("noop swallows every emission", () => {
    // No throw, no observable side effect.
    noopMetricsRecorder.counter("a", 1);
    noopMetricsRecorder.gauge("b", 2);
    noopMetricsRecorder.histogram("c", 3);
    noopMetricsRecorder.counter("d", 4, { k: "v" });
    noopMetricsRecorder.gauge("e", 5, { k: "v" });
    noopMetricsRecorder.histogram("f", 6, { k: "v" });
  });

  test("in-memory recorder accumulates counters", () => {
    const r = new InMemoryMetricsRecorder();
    r.counter("foo", 1, { x: "1" });
    r.counter("foo", 2, { x: "1" });
    r.counter("bar", 5);
    expect(r.sumCounter("foo")).toBe(3);
    expect(r.sumCounter("bar")).toBe(5);
    expect(r.sumCounter("missing")).toBe(0);
  });

  test("in-memory recorder records last gauge", () => {
    const r = new InMemoryMetricsRecorder();
    r.gauge("x", 1);
    r.gauge("x", 2);
    r.gauge("x", 7);
    expect(r.lastGauge("x")).toBe(7);
    expect(r.lastGauge("nope")).toBeUndefined();
  });

  test("in-memory recorder preserves histogram order", () => {
    const r = new InMemoryMetricsRecorder();
    r.histogram("h", 1);
    r.histogram("h", 5);
    r.histogram("h", 2);
    expect(r.histogramValues("h")).toEqual([1, 5, 2]);
    expect(r.histogramValues("missing")).toEqual([]);
  });

  test("in-memory recorder defensively copies labels", () => {
    const r = new InMemoryMetricsRecorder();
    const labels: Record<string, string> = { k: "v" };
    r.counter("foo", 1, labels);
    labels["k"] = "mutated";
    expect(r.counters[0]?.labels).toEqual({ k: "v" });
  });
});

describe("teeMetricsRecorders", () => {
  test("fans counter() to both sinks with the same args", () => {
    const a = new InMemoryMetricsRecorder();
    const b = new InMemoryMetricsRecorder();
    const tee = teeMetricsRecorders(a, b);
    tee.counter("foo", 3, { k: "v" });
    expect(a.counters).toHaveLength(1);
    expect(b.counters).toHaveLength(1);
    expect(a.counters[0]).toMatchObject({ name: "foo", value: 3, labels: { k: "v" } });
    expect(b.counters[0]).toMatchObject({ name: "foo", value: 3, labels: { k: "v" } });
  });

  test("fans gauge() to both sinks with the same args", () => {
    const a = new InMemoryMetricsRecorder();
    const b = new InMemoryMetricsRecorder();
    const tee = teeMetricsRecorders(a, b);
    tee.gauge("g", 42, { tenant: "acme" });
    expect(a.lastGauge("g")).toBe(42);
    expect(b.lastGauge("g")).toBe(42);
    expect(a.gauges[0]?.labels).toEqual({ tenant: "acme" });
    expect(b.gauges[0]?.labels).toEqual({ tenant: "acme" });
  });

  test("fans histogram() to both sinks with the same args", () => {
    const a = new InMemoryMetricsRecorder();
    const b = new InMemoryMetricsRecorder();
    const tee = teeMetricsRecorders(a, b);
    tee.histogram("h", 1);
    tee.histogram("h", 5, { coll: "tickets" });
    expect(a.histogramValues("h")).toEqual([1, 5]);
    expect(b.histogramValues("h")).toEqual([1, 5]);
    expect(a.histograms[1]?.labels).toEqual({ coll: "tickets" });
    expect(b.histograms[1]?.labels).toEqual({ coll: "tickets" });
  });

  test("shares the labels object by reference (no defensive copy at the tee)", () => {
    // The tee MUST NOT defensively copy — InMemoryMetricsRecorder's
    // own copy (metrics.ts:95) is what isolates downstream sinks.
    // Sinks that don't copy will see mutation, by design.
    const sink = {
      counter: (_name: string, _value: number, labels?: Readonly<Record<string, string>>) => {
        captured = labels;
      },
      gauge: () => {},
      histogram: () => {},
    };
    let captured: Readonly<Record<string, string>> | undefined;
    const tee = teeMetricsRecorders(sink, sink);
    const labels = { k: "v" };
    tee.counter("foo", 1, labels);
    expect(captured).toBe(labels);
  });
});

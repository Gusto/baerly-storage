import { describe, expect, it } from "vitest";
import { InMemoryMetricsRecorder, noopMetricsRecorder } from "./metrics";

describe("MetricsRecorder", () => {
  it("noop swallows every emission", () => {
    // No throw, no observable side effect.
    noopMetricsRecorder.counter("a", 1);
    noopMetricsRecorder.gauge("b", 2);
    noopMetricsRecorder.histogram("c", 3);
    noopMetricsRecorder.counter("d", 4, { k: "v" });
    noopMetricsRecorder.gauge("e", 5, { k: "v" });
    noopMetricsRecorder.histogram("f", 6, { k: "v" });
  });

  it("in-memory recorder accumulates counters", () => {
    const r = new InMemoryMetricsRecorder();
    r.counter("foo", 1, { x: "1" });
    r.counter("foo", 2, { x: "1" });
    r.counter("bar", 5);
    expect(r.sumCounter("foo")).toBe(3);
    expect(r.sumCounter("bar")).toBe(5);
    expect(r.sumCounter("missing")).toBe(0);
  });

  it("in-memory recorder records last gauge", () => {
    const r = new InMemoryMetricsRecorder();
    r.gauge("x", 1);
    r.gauge("x", 2);
    r.gauge("x", 7);
    expect(r.lastGauge("x")).toBe(7);
    expect(r.lastGauge("nope")).toBeUndefined();
  });

  it("in-memory recorder preserves histogram order", () => {
    const r = new InMemoryMetricsRecorder();
    r.histogram("h", 1);
    r.histogram("h", 5);
    r.histogram("h", 2);
    expect(r.histogramValues("h")).toEqual([1, 5, 2]);
    expect(r.histogramValues("missing")).toEqual([]);
  });

  it("in-memory recorder defensively copies labels", () => {
    const r = new InMemoryMetricsRecorder();
    const labels: Record<string, string> = { k: "v" };
    r.counter("foo", 1, labels);
    labels.k = "mutated";
    expect(r.counters[0]?.labels).toEqual({ k: "v" });
  });
});

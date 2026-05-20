import { describe, expect, test } from "vitest";
import { InMemoryMetricsRecorder } from "./in-memory-metrics.ts";

describe("InMemoryMetricsRecorder", () => {
  test("accumulates counters", () => {
    const r = new InMemoryMetricsRecorder();
    r.counter("foo", 1, { x: "1" });
    r.counter("foo", 2, { x: "1" });
    r.counter("bar", 5);
    expect(r.sumCounter("foo")).toBe(3);
    expect(r.sumCounter("bar")).toBe(5);
    expect(r.sumCounter("missing")).toBe(0);
  });

  test("records last gauge", () => {
    const r = new InMemoryMetricsRecorder();
    r.gauge("x", 1);
    r.gauge("x", 2);
    r.gauge("x", 7);
    expect(r.lastGauge("x")).toBe(7);
    expect(r.lastGauge("nope")).toBeUndefined();
  });

  test("preserves histogram order", () => {
    const r = new InMemoryMetricsRecorder();
    r.histogram("h", 1);
    r.histogram("h", 5);
    r.histogram("h", 2);
    expect(r.histogramValues("h")).toEqual([1, 5, 2]);
    expect(r.histogramValues("missing")).toEqual([]);
  });

  test("defensively copies labels", () => {
    const r = new InMemoryMetricsRecorder();
    const labels: Record<string, string> = { k: "v" };
    r.counter("foo", 1, labels);
    labels["k"] = "mutated";
    expect(r.counters[0]?.labels).toEqual({ k: "v" });
  });
});

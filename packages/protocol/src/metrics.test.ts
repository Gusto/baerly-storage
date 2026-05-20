import { describe, expect, test } from "vitest";
import { type MetricsRecorder, noopMetricsRecorder, teeMetricsRecorders } from "./metrics.ts";

/**
 * A tiny in-test recorder. We deliberately do NOT import
 * `InMemoryMetricsRecorder` from `@baerly/server/_internal/testing` here —
 * the protocol package must not depend on server. Each test that
 * needs an inspectable sink rolls its own.
 */
const makeRecorder = (): {
  recorder: MetricsRecorder;
  counters: Array<{ name: string; value: number; labels?: Readonly<Record<string, string>> }>;
  gauges: Array<{ name: string; value: number; labels?: Readonly<Record<string, string>> }>;
  histograms: Array<{ name: string; value: number; labels?: Readonly<Record<string, string>> }>;
} => {
  const counters: Array<{
    name: string;
    value: number;
    labels?: Readonly<Record<string, string>>;
  }> = [];
  const gauges: Array<{ name: string; value: number; labels?: Readonly<Record<string, string>> }> =
    [];
  const histograms: Array<{
    name: string;
    value: number;
    labels?: Readonly<Record<string, string>>;
  }> = [];
  return {
    recorder: {
      counter: (name, value, labels) => counters.push({ name, value, labels }),
      gauge: (name, value, labels) => gauges.push({ name, value, labels }),
      histogram: (name, value, labels) => histograms.push({ name, value, labels }),
    },
    counters,
    gauges,
    histograms,
  };
};

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
});

describe("teeMetricsRecorders", () => {
  test("fans counter() to both sinks with the same args", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    const tee = teeMetricsRecorders(a.recorder, b.recorder);
    tee.counter("foo", 3, { k: "v" });
    expect(a.counters).toHaveLength(1);
    expect(b.counters).toHaveLength(1);
    expect(a.counters[0]).toMatchObject({ name: "foo", value: 3, labels: { k: "v" } });
    expect(b.counters[0]).toMatchObject({ name: "foo", value: 3, labels: { k: "v" } });
  });

  test("fans gauge() to both sinks with the same args", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    const tee = teeMetricsRecorders(a.recorder, b.recorder);
    tee.gauge("g", 42, { tenant: "acme" });
    expect(a.gauges[0]).toMatchObject({ name: "g", value: 42, labels: { tenant: "acme" } });
    expect(b.gauges[0]).toMatchObject({ name: "g", value: 42, labels: { tenant: "acme" } });
  });

  test("fans histogram() to both sinks with the same args", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    const tee = teeMetricsRecorders(a.recorder, b.recorder);
    tee.histogram("h", 1);
    tee.histogram("h", 5, { coll: "tickets" });
    expect(a.histograms).toHaveLength(2);
    expect(b.histograms).toHaveLength(2);
    expect(a.histograms[1]?.labels).toEqual({ coll: "tickets" });
    expect(b.histograms[1]?.labels).toEqual({ coll: "tickets" });
  });

  test("shares the labels object by reference (no defensive copy at the tee)", () => {
    // The tee MUST NOT defensively copy — recorders that need isolation
    // (e.g. InMemoryMetricsRecorder in @baerly/server/_internal/testing)
    // copy on their own. Sinks that don't copy will see mutation, by design.
    let captured: Readonly<Record<string, string>> | undefined;
    const sink: MetricsRecorder = {
      counter: (_name, _value, labels) => {
        captured = labels;
      },
      gauge: () => {},
      histogram: () => {},
    };
    const tee = teeMetricsRecorders(sink, sink);
    const labels = { k: "v" };
    tee.counter("foo", 1, labels);
    expect(captured).toBe(labels);
  });
});

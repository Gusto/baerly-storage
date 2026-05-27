import { describe, test } from "vitest";
import { noopMetricsRecorder } from "./metrics.ts";

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

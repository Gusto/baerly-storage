/**
 * Per-request `MetricsRecorder` whose primary product is the
 * canonical-line attribute set.
 *
 * `RequestScopedMetricsRecorder` is a deliberately tiny extension to
 * the {@link MetricsRecorder} interface that adds two readers
 * (`snapshot()` for tests / debug, `summarize()` for the canonical
 * log line). Every method just appends a row to a flat array — no
 * sorting, no JSON, no aggregation on the hot path. The work happens
 * once at end-of-request inside `summarize()`.
 *
 * The shape mirrors {@link InMemoryMetricsRecorder} from
 * `@baerly/protocol` but adds the per-request product. We do NOT
 * extend that class — composition over inheritance, and the
 * observability layer wants `summarize()` to be the only side-channel.
 */

import type { MetricsRecorder } from "@baerly/protocol";
import { getCurrentContext } from "./context.ts";

/** One observation row, kept in insertion order. */
export interface ObservationRow {
  readonly name: string;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
}

/** Result of {@link RequestScopedMetricsRecorder.snapshot}. */
export interface MetricsSnapshot {
  readonly counters: readonly ObservationRow[];
  readonly gauges: readonly ObservationRow[];
  readonly histograms: readonly ObservationRow[];
}

/** Flat per-metric aggregation as consumed by the canonical line. */
export type MetricsSummary = Record<string, number>;

/**
 * Implementation. Allocations:
 *
 * - Three arrays at construction time, grown on each emission.
 * - On `summarize()` we materialize one extra `Map` per metric-
 *   family (counter / gauge / histogram) plus a copy of each
 *   histogram's values for sorting.
 *
 * CPU-ms budget on Workers is tight; we deliberately defer all of
 * that to flush time.
 */
export class RequestScopedMetricsRecorder implements MetricsRecorder {
  readonly #counters: ObservationRow[] = [];
  readonly #gauges: ObservationRow[] = [];
  readonly #histograms: ObservationRow[] = [];

  counter(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.#counters.push({ name, value, labels });
  }
  gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.#gauges.push({ name, value, labels });
  }
  histogram(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.#histograms.push({ name, value, labels });
  }

  /**
   * Read-only view of every observation seen so far. Intended for
   * tests + structured debugging; the canonical-line flusher uses
   * {@link summarize} instead.
   *
   * @internal Not part of the published observability surface; tests
   * import via relative path. Production reads via {@link summarize}.
   */
  snapshot(): MetricsSnapshot {
    return {
      counters: this.#counters.slice(),
      gauges: this.#gauges.slice(),
      histograms: this.#histograms.slice(),
    };
  }

  /**
   * Flat aggregation, keyed by metric name with suffixes baked in:
   *
   * - Counter `db.foo.bar` → `db.foo.bar_total` (sum of all observations)
   * - Gauge   `db.foo.bar` → `db.foo.bar`       (last value seen)
   * - Histogram `db.foo.bar` → `db.foo.bar_p50`, `_p99`, `_count`, `_sum`
   *
   * Percentiles use a simple sort + index (nearest-rank, ceiling
   * convention). Bag size per request is tiny so the O(n log n)
   * sort is fine. Returns numbers only — labels are NOT collapsed
   * into keys; if a metric is emitted with different label sets,
   * its observations are aggregated together by `name` alone. The
   * canonical line is per-request anyway; per-label fan-out belongs
   * to the operator's long-term recorder.
   */
  summarize(): MetricsSummary {
    const out: MetricsSummary = {};

    // Counters: sum.
    for (const row of this.#counters) {
      // Counter convention: prefer the emitter's name verbatim. If the
      // emitter already namespaced its counter with `_total` (Prometheus
      // convention — see packages/server/src/observability/storage.ts),
      // do not double-append. Otherwise append for canonical-line
      // consumers that key off the `_total` suffix.
      const key = row.name.endsWith("_total") ? row.name : `${row.name}_total`;
      out[key] = (out[key] ?? 0) + row.value;
    }

    // Gauges: last write wins per name (observations are in
    // insertion order; iterate forward and overwrite).
    for (const row of this.#gauges) {
      out[row.name] = row.value;
    }

    // Histograms: bucket-by-name, then derive p50/p99/count/sum.
    const buckets = new Map<string, number[]>();
    for (const row of this.#histograms) {
      let arr = buckets.get(row.name);
      if (arr === undefined) {
        arr = [];
        buckets.set(row.name, arr);
      }
      arr.push(row.value);
    }
    for (const [name, values] of buckets) {
      values.sort((a, b) => a - b);
      out[`${name}_p50`] = percentile(values, 0.5);
      out[`${name}_p99`] = percentile(values, 0.99);
      out[`${name}_count`] = values.length;
      let sum = 0;
      for (const v of values) {
        sum += v;
      }
      out[`${name}_sum`] = sum;
    }

    return out;
  }
}

/**
 * Nearest-rank percentile. `values` MUST be pre-sorted ascending.
 * Empty input returns `0`. The percentile rank is computed as
 * `ceil(p * n) - 1`, clamped to `[0, n-1]`.
 */
const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1));
  // `!` is safe under noUncheckedIndexedAccess because `idx` is
  // clamped to `[0, length-1]` and `length >= 1` above.
  return values[idx]!;
};

/**
 * Build a {@link MetricsRecorder} that always emits to `operator`
 * AND, when called from inside a {@link runWithContext} scope, ALSO
 * emits to the current request's per-request bag
 * ({@link getCurrentContext}().recorder).
 *
 * Adapters construct this once per request (or once at module init —
 * the ALS lookup is per-call, so call site doesn't matter) and pass
 * the result as the `Db`'s `metrics` option. Net effect: every
 * kernel emission (ServerWriter's class-A-op histogram, the
 * compactor's `db.compact.entries_folded`, the GC's
 * `db.gc.swept_total`, the storage decorator's per-call counters,
 * etc.) lands in BOTH:
 *
 * 1. The operator's long-term {@link MetricsRecorder} (Workers
 *    Analytics Engine, OpenTelemetry, statsd) — verbatim, every
 *    emission, regardless of context.
 * 2. The per-request {@link RequestScopedMetricsRecorder} bag — only
 *    when the emission happens inside an `runWithContext` scope.
 *    The canonical-line flusher reads `summarize()` off this bag at
 *    end-of-request and spreads it onto the line.
 *
 * Calls outside any context (e.g. kernel emissions that escape ALS
 * propagation through a setTimeout that the runtime doesn't bridge)
 * still reach the operator's sink. The bag is best-effort, the
 * operator's sink is authoritative.
 *
 * Emission order: operator first, then the bag. This matches
 * {@link teeMetricsRecorders} from `@baerly/protocol` — operator
 * sinks may throw (operator bug); the bag never throws and is fine
 * to skip if the operator did.
 */
export const alsAwareRecorder = (operator: MetricsRecorder): MetricsRecorder => ({
  counter: (name, value, labels) => {
    operator.counter(name, value, labels);
    getCurrentContext()?.recorder.counter(name, value, labels);
  },
  gauge: (name, value, labels) => {
    operator.gauge(name, value, labels);
    getCurrentContext()?.recorder.gauge(name, value, labels);
  },
  histogram: (name, value, labels) => {
    operator.histogram(name, value, labels);
    getCurrentContext()?.recorder.histogram(name, value, labels);
  },
});

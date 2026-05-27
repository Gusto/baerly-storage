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
 * `../_internal/in-memory-metrics.ts` but adds the per-request product. We do
 * NOT extend that class — composition over inheritance, and the
 * observability layer wants `summarize()` to be the only side-channel.
 */

import type { MetricsRecorder } from "@baerly/protocol";

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
   * - Histogram `db.foo.bar` → `db.foo.bar_count` (number of observations)
   *                          + `db.foo.bar_sum` (sum of values)
   *
   * Histogram aggregation is a single pass in insertion order — no
   * sort. Returns numbers only — labels are NOT collapsed into keys;
   * if a metric is emitted with different label sets, its
   * observations are aggregated together by `name` alone. The
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

    // Histograms: bucket-by-name, then emit `_count` + `_sum`.
    const buckets = new Map<string, { count: number; sum: number }>();
    for (const row of this.#histograms) {
      let agg = buckets.get(row.name);
      if (agg === undefined) {
        agg = { count: 0, sum: 0 };
        buckets.set(row.name, agg);
      }
      agg.count += 1;
      agg.sum += row.value;
    }
    for (const [name, { count, sum }] of buckets) {
      out[`${name}_count`] = count;
      out[`${name}_sum`] = sum;
    }

    return out;
  }
}

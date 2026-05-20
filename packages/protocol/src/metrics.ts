/**
 * `MetricsRecorder` — pluggable sink for the six load-bearing
 * metrics. The kernel does not emit to any specific backend; the
 * operator wires their preferred sink (Workers Analytics Engine,
 * OpenTelemetry, statsd, in-process aggregation) by implementing this
 * interface and passing it to `ServerWriter`, `compact`, `runGc`, and
 * the scheduled handler.
 *
 * The default {@link noopMetricsRecorder} swallows everything — safe
 * to use when no operator is present (CI, tests that don't care about
 * metrics).
 *
 * **Naming convention** matches the load-bearing metrics:
 *   - `db.write.class_a_ops_per_logical_write` — histogram (p99 alert at 5).
 *     Includes one Class A op per index PUT + index DELETE emitted
 *     in the commit's fence. Idle-reader cost is unchanged.
 *   - `db.r2.put.412_total` — counter (CAS conflict / If-Match-or-None-Match loss)
 *   - `db.r2.put.429_total` — counter (R2 prefix-partition rate-limit)
 *   - `db.r2.preimage_get_total` — counter. One per U/D for
 *     an indexed collection — the writer back-walks the log to read the
 *     pre-image body so it can DELETE stale index keys. Per-collection
 *     label; ZERO when no indexes are declared.
 *   - `db.write.index_ops_per_logical_write` — histogram.
 *     `K (PUT) + L (DELETE)` per commit. Per-collection label.
 *   - `db.manifest.lag_window_depth` — gauge (alert at >100)
 *   - `db.gc.entries_swept_per_second` — gauge (livelock indicator when <writes/s)
 *   - `db.orphan.candidate_count` — gauge (`gc/pending.json` depth)
 *   - `db.compact.entries_folded` — histogram (entries folded per run)
 *   - `db.gc.swept_total` — counter (labelled by reason)
 *
 * Names follow `db.<subsystem>.<metric>`, dot-separated, all-lowercase
 * snake_case segments. Labels are flat
 * `Readonly<Record<string, string>>` — no numbers, no nested objects —
 * so any aggregation backend can consume them.
 *
 * Metric emissions never throw on the hot path; the default
 * `noopMetricsRecorder` cannot throw. Operator-supplied recorders that
 * throw are an operator bug.
 *
 * @example
 * ```ts
 * import type { MetricsRecorder } from "@baerly/protocol";
 *
 * const recorder: MetricsRecorder = {
 *   counter: (name, value, labels) => analytics.increment(name, value, labels),
 *   gauge:   (name, value, labels) => analytics.gauge(name, value, labels),
 *   histogram: (name, value, labels) => analytics.observe(name, value, labels),
 * };
 * ```
 */
export interface MetricsRecorder {
  /** Monotonically-incrementing event count. */
  counter(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  /** Point-in-time value. */
  gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  /** Distribution sample. */
  histogram(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * No-op recorder. Safe default when no operator sink is wired —
 * callers that thread `metrics?: MetricsRecorder` default to this so
 * non-instrumented code sees zero behavioural change.
 */
export const noopMetricsRecorder: MetricsRecorder = {
  counter: (): void => {},
  gauge: (): void => {},
  histogram: (): void => {},
};

/**
 * Fan every emission to both `a` and `b`, in that order. Lets the
 * observability layer tee a short-lived per-request recorder (e.g.
 * `InMemoryMetricsRecorder` from `@baerly/server/observability`, used
 * to derive canonical-log fields) into the operator's long-term
 * recorder without coupling the kernel to a specific aggregation
 * backend.
 *
 * **No error swallowing.** The kernel guarantees its own recorders
 * never throw (see the JSDoc on {@link MetricsRecorder}); if an
 * operator wires a throwing recorder, the throw propagates and `b`'s
 * call does not run. That is intentional — silently swallowing
 * operator bugs would let a metric sink fail half-open.
 *
 * **No defensive label copy at the tee.** The labels object is passed
 * to both sinks by reference; recorders that need isolation (such as
 * `InMemoryMetricsRecorder` from `@baerly/server/observability`)
 * defensively copy on their own. Callers passing a labels object
 * they intend to mutate after emission should freeze it or pass a
 * fresh literal.
 *
 * @example
 * ```ts
 * import { teeMetricsRecorders, type MetricsRecorder } from "@baerly/protocol";
 * import { InMemoryMetricsRecorder } from "@baerly/server/observability";
 *
 * // Long-term sink the operator wired (Workers Analytics Engine,
 * // OpenTelemetry, statsd, etc.).
 * const operator: MetricsRecorder = wireOperatorSink();
 * // Per-request scratch sink the request handler reads to derive
 * // its canonical log line.
 * const perRequest = new InMemoryMetricsRecorder();
 *
 * const metrics = teeMetricsRecorders(perRequest, operator);
 * await db.transaction("tickets", async (tx) => { ... });
 * // ... read perRequest.histogramValues(...) to populate the log line ...
 * ```
 */
export const teeMetricsRecorders = (a: MetricsRecorder, b: MetricsRecorder): MetricsRecorder => ({
  counter: (name, value, labels) => {
    a.counter(name, value, labels);
    b.counter(name, value, labels);
  },
  gauge: (name, value, labels) => {
    a.gauge(name, value, labels);
    b.gauge(name, value, labels);
  },
  histogram: (name, value, labels) => {
    a.histogram(name, value, labels);
    b.histogram(name, value, labels);
  },
});


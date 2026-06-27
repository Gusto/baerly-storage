/**
 * In-memory `MetricsRecorder` — test/dev observability harness.
 *
 * Stores every observation; useful for tests (e.g. the
 * synthetic-5000-entry durability gate in
 * `tests/integration/maintenance-e2e.test.ts`) and dev probes.
 * Memory grows unbounded — **not suitable for production**.
 *
 * Production emissions flow through the per-request
 * `RequestScopedMetricsRecorder` on the active
 * `ObservabilityContext`; operators read kernel metrics off the
 * canonical-line JSON the adapter prints to stdout.
 */

import type { MetricsRecorder } from "@baerly/protocol";

export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly counters: Array<{
    name: string;
    value: number;
    labels: Record<string, string>;
  }> = [];
  readonly gauges: Array<{
    name: string;
    value: number;
    labels: Record<string, string>;
  }> = [];
  readonly histograms: Array<{
    name: string;
    value: number;
    labels: Record<string, string>;
  }> = [];

  counter(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.counters.push({ name, value, labels: { ...labels } });
  }
  gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.gauges.push({ name, value, labels: { ...labels } });
  }
  histogram(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.histograms.push({ name, value, labels: { ...labels } });
  }

  /** Sum every counter observation with the given name. Returns 0 when none recorded. */
  sumCounter(name: string): number {
    let total = 0;
    for (const c of this.counters) {
      if (c.name === name) {
        total += c.value;
      }
    }
    return total;
  }

  /** Latest gauge observation with the given name, or `undefined`. */
  lastGauge(name: string): number | undefined {
    for (let i = this.gauges.length - 1; i >= 0; i--) {
      const g = this.gauges[i]!;
      if (g.name === name) {
        return g.value;
      }
    }
    return undefined;
  }

  /** Every histogram value with the given name, in observation order. */
  histogramValues(name: string): number[] {
    const out: number[] = [];
    for (const h of this.histograms) {
      if (h.name === name) {
        out.push(h.value);
      }
    }
    return out;
  }
}

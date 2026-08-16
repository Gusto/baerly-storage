/**
 * `MetricsRecorder` — internal emission contract for the twelve
 * load-bearing kernel metrics. Writer / compactor / GC emit through
 * an instance of this interface; in production the instance is the
 * per-request `RequestScopedMetricsRecorder` on the active
 * `ObservabilityContext`, and emissions flow onto the canonical line
 * via `summarize()`. Tests use a local `InMemoryMetricsRecorder` and
 * wrap their workload in `runWithContext` to attach it.
 *
 * Operators do not wire a custom sink against this interface — the
 * operator's view of kernel emissions is the canonical line on
 * stdout (one JSON object per HTTP request).
 *
 * **Naming convention** matches the load-bearing metrics:
 *   - `db.write.class_a_ops_per_logical_write` — histogram (recommend p99 alert ~5; not gated).
 *     Includes one Class A op per index PUT + index DELETE emitted
 *     in the commit's fence. Idle-reader cost is unchanged.
 *   - `db.r2.put.412_total` — counter (CAS conflict / If-Match-or-None-Match loss)
 *   - `db.r2.put.429_total` — counter (R2 prefix-partition rate-limit)
 *   - `db.write.index_ops_per_logical_write` — histogram.
 *     `K (PUT) + L (DELETE)` per commit. Per-collection label.
 *   - `db.write.ambiguous_commit_total` — counter, labelled by `collection`
 *     and `cleanup` (`deleted` / `failed`). A committing create won at a
 *     sequence already certified deleted, so the commit failed with
 *     `AmbiguousCommit` rather than acknowledging a mutation whose
 *     visibility cannot be determined.
 *     `cleanup` reports whether the phantom log object was reclaimed. Any
 *     sustained rate means writers are pausing across a fold plus a
 *     retirement pass; a `failed` rate leaves behind sub-floor objects that
 *     GC's `stale-log` arm still reclaims today, and that leak permanently
 *     only once PR 5 replaces that arm with computed-range retirement
 *   - `db.write.delete_floor_check_skipped_total` — counter, labelled by
 *     `collection`. The post-create re-read of `current.json` inside
 *     `Writer#assertCommitAboveDeleteFloor` failed with a non-abort error, so
 *     the delete-floor check was skipped for that commit rather than
 *     evaluated. A sustained rate means the check is not covering the writes
 *     it exists to protect, even though no individual commit is rejected.
 *   - `db.manifest.lag_window_depth` — gauge (alert at >100)
 *   - `db.gc.entries_swept_per_second` — gauge (livelock indicator when <writes/s)
 *   - `db.orphan.candidate_count` — gauge (`gc/pending.json` depth)
 *   - `db.compact.entries_folded` — histogram (entries folded per run)
 *   - `db.gc.swept_total` — counter (labelled by reason)
 *   - `db.gc.dropped_total` — counter (labelled by cause: `stale-generation`
 *     / `still-live`). Candidates resolved out of the ledger WITHOUT a
 *     DELETE because the sweep gate re-checked them and found them no
 *     longer eligible. A drop frees no bytes, so this is deliberately
 *     not folded into `db.gc.swept_total` — a pass that reclaimed
 *     nothing must not read as productive. One `stale-generation` spike
 *     per restore or upgrade is expected; a sustained `still-live` rate
 *     means the mark phase is misjudging liveness
 *
 * Names follow `db.<subsystem>.<metric>`, dot-separated, all-lowercase
 * snake_case segments. Labels are flat
 * `Readonly<Record<string, string>>` — no numbers, no nested objects.
 *
 * Metric emissions never throw on the hot path; the default
 * `noopMetricsRecorder` cannot throw.
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
 * emission sites that read `getCurrentContext()?.recorder` fall
 * back to this outside an active `runWithContext` scope.
 */
export const noopMetricsRecorder: MetricsRecorder = {
  counter: (): void => {},
  gauge: (): void => {},
  histogram: (): void => {},
};

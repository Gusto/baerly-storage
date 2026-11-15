/**
 * `MetricsRecorder` — internal emission contract for the load-bearing
 * kernel metrics. Writer / compactor / GC emit through
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
 *     The committing log create, 1 per commit. Idle-reader cost is unchanged.
 *   - `db.r2.put.412_total` — counter (CAS conflict / If-Match-or-None-Match loss)
 *   - `db.r2.put.429_total` — counter (R2 prefix-partition rate-limit)
 *   - `db.write.ambiguous_commit_total` — counter, labelled by `collection`
 *     and `cleanup` (`deleted` / `failed`). A committing create won at a
 *     sequence already certified deleted, so the commit failed with
 *     `AmbiguousCommit` rather than acknowledging a mutation whose
 *     visibility cannot be determined.
 *     `cleanup` reports whether the phantom log object was reclaimed. Any
 *     sustained rate means writers are pausing across a fold plus a
 *     retirement pass; a `failed` rate leaves behind sub-floor objects that
 *     leak permanently — they sit below `log_delete_floor`, where
 *     computed-range retirement starts, so nothing revisits them
 *   - `db.write.delete_floor_check_skipped_total` — counter, labelled by
 *     `collection`. The post-create re-read of `current.json` inside
 *     `Writer#assertCommitAboveDeleteFloor` failed with a non-abort error, so
 *     the delete-floor check was skipped for that commit rather than
 *     evaluated. A sustained rate means the check is not covering the writes
 *     it exists to protect, even though no individual commit is rejected.
 *   - `db.write.post_commit_refused_total` — counter, labelled by
 *     `collection` and `phase` (`delete-floor-check`, the only post-commit
 *     step). The request ledger refused a storage call of a step that runs
 *     after a known commit; the step was skipped and the commit stands. The
 *     floor check runs inside the commit's ledger hold, so a count means a call outside every hold, or a
 *     platform cap below the ledger's limit, cut into it.
 *   - `db.write.unresolved_create_total` — counter, labelled by
 *     `collection`. A rejected committing create could not be resolved by
 *     readback, so the commit failed with `AmbiguousCommit`.
 *   - `db.write.maintenance_dispatch_failed_total` — counter, labelled by
 *     `collection`. The maintenance dispatcher threw or rejected after a
 *     durable commit, so that write's maintenance tick did not run.
 *   - `db.write.insert_replayed_total` — counter, labelled by `collection`.
 *     An SDK-minted insert (`mintedId`) found its identical row already
 *     stored and returned it as the original success, committing nothing.
 *     A rate tracks clients retransmitting inserts after lost responses.
 *   - `db.read.decoded_entries_total` / `db.read.live_documents_total` /
 *     `db.read.returned_rows_total` — counters, labelled by `collection`,
 *     emitted together by every collection read (a read terminal, or a
 *     write verb's pre-commit read). Units:
 *     - decoded entries: snapshot rows plus log entries the fold decoded,
 *       before predicate and limit. Entries, not documents: an `_id`
 *       updated twice since the last fold counts three times, and a
 *       deleted row still counts its `I` and its `D`.
 *     - live documents: distinct documents live once the fold completes,
 *       before predicate, order and limit.
 *     - returned rows: rows left after predicate, order and limit — the
 *       rows a read returns, the rows `count()` counts, or the rows a write
 *       verb's read matched.
 *     A never-provisioned collection reports zeros. A point read still
 *     folds the whole collection, so a large decoded count beside one
 *     returned row is that read's actual work. No threshold or cap attaches.
 *   - `db.manifest.lag_window_depth` — gauge (alert at >100)
 *   - `db.gc.entries_swept_per_second` — gauge (livelock indicator when <writes/s)
 *   - `db.orphan.candidate_count` — gauge (`gc/pending.json` depth)
 *   - `db.compact.entries_folded` — histogram (entries folded per run)
 *   - `db.compaction.deferred_total` — counter, labelled by `collection`,
 *     `dimension` (`bytes` / `rows`) and `gate` (`pre-fold` / `rebuild`).
 *     The write-tick fold hit the snapshot ceiling (`C` / `E`) and did not
 *     run: `log_seq_start` and log retention are frozen until it folds again.
 *     Emitted once per deferral by the write-tick runner, never by compact().
 *   - `db.compaction.deferred_bytes_total` / `db.compaction.deferred_rows_total`
 *     — the same event under a per-dimension name, labelled by `collection`
 *     and `gate`, because the canonical line keys counters by name and drops
 *     labels
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

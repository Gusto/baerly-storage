/**
 * GC mark + sweep.
 *
 * `runGc` is a single-pass garbage collector that:
 *   1. Reads `current.json` (and bootstraps `gc/pending.json` on first
 *      run).
 *   2. Marks new orphan candidates by LISTing the snapshot prefix and
 *      classifying each key.
 *   3. Rescues candidates proven live, then sweeps due candidates that
 *      are safe to classify.
 *   4. CAS-writes the updated `gc/pending.json`.
 *
 * Two-phase by design: each mark sits in `gc/pending.json` for a grace
 * period (default 7 days, see {@link GC_GRACE_PERIOD_MILLIS}) before
 * sweep may delete it. The grace bounds the worst plausible writer-retry
 * window — a paused-process writer that resumes hours later still finds
 * its idempotency anchor on the bucket. Sweep can also resolve a
 * candidate OUT of the ledger without deleting it, when a generation or
 * liveness recheck fails.
 *
 * Stale log objects are reclaimed by a sequence window rather than a
 * timed mark-and-sweep. See `log-retention.ts` for the computed-range
 * deletion path.
 *
 * Unbounded by default — the run marks and sweeps the entire eligible
 * set in one pass. Callers on the Cloudflare 50-subrequest free-tier
 * budget opt INTO caps via the `CLOUDFLARE_FREE_TIER` profile's mark
 * and sweep knobs (`InternalRunGcOptions`, not on the public
 * `RunGcOptions`). One Free invocation processes only this GC phase
 * for one collection; alternate it with a direct bounded `compact()`
 * invocation instead of composing both phases.
 *
 * One category of orphan:
 *   - `orphan-snapshot`: a canonical
 *     `<collectionPrefix>/snapshot/L9/...` key not equal to
 *     `current.snapshot`. Each compactor run replaces the pointer; the
 *     prior file becomes unreferenced. Discovery is scoped to this
 *     binary's owned `snapshot/L9/` namespace. Within that scanned,
 *     protocol-written keyspace at most ONE key is permanently
 *     undeletable (the live `current.snapshot`), so for any `maxMarks
 *     >= 2` the window cannot be all-undeletable. Future L0-L8 layouts
 *     stay opaque to this binary and do not consume the bounded mark
 *     window. Opaque L9 keys are ignored during mark and evicted from
 *     legacy ledgers without a DELETE; no current writer emits one.
 *
 * **`content/` is deliberately NOT a category.** Legacy
 * `<collectionPrefix>/content/<sha>.json` side objects — written by
 * v0.6.0, and still written by a v0.6.0 node during a mixed rollout —
 * are inert: no current writer creates one, no reader opens one. GC
 * never LISTs, reads, or deletes under that prefix, so they cost storage
 * and nothing else, and an operator who wants the bytes back deletes the
 * prefix directly (`docs/guide/backups.md`). An `orphan-content` entry
 * found in a legacy ledger is EVICTED, not swept — see the sweep gate's
 * legacy arm.
 *
 * CAS-lost on `gc/pending.json` is non-fatal: the DELETEs already
 * issued are durable, so we return a successful result and the next
 * pass will pick up any work this pass lost.
 */

import {
  type GcCandidate,
  type GcPending,
  type MetricsRecorder,
  type Storage,
  GC_GRACE_PERIOD_MILLIS,
  GC_MAX_PENDING_CANDIDATES,
  GC_PENDING_SCHEMA_VERSION,
  NO_GENERATION,
  BaerlyError,
  casUpdateGcPending,
  createGcPending,
  gcPendingKey,
  logObjectKey,
  logSeqStartOf,
  mergeGcPending,
  noopMetricsRecorder,
  readCurrentJson,
  readGcPending,
} from "@baerly/protocol";
import { getCurrentContext } from "./observability/context.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Public tunables for {@link runGc}. All optional; the engine works
 * unbounded by default. Opt into per-run caps via the
 * `CLOUDFLARE_FREE_TIER` profile (from `./maintenance.ts`) or by
 * reaching for {@link InternalRunGcOptions} via the
 * `@baerly/server/_internal/testing` subpath.
 */
export interface RunGcOptions {
  readonly signal?: AbortSignal;
}

/**
 * Internal-only widening of {@link RunGcOptions}. Surfaced via the
 * `@baerly/server/_internal/testing` subpath (NOT in the published
 * `publishConfig.exports`); production callers should use
 * {@link RunGcOptions}.
 *
 * @internal
 */
export interface InternalRunGcOptions extends RunGcOptions {
  /**
   * @internal Override grace-period for tests. Defaults to
   * {@link GC_GRACE_PERIOD_MILLIS} (7 days). Tests use `0` to bypass
   * the grace and exercise the sweep path in one pass.
   */
  readonly graceMillis?: number;

  /**
   * @internal Budget cap on candidates marked per category per run.
   * `CLOUDFLARE_FREE_TIER` sets it; bounds LIST + classification
   * cost per pass. The default is effectively unbounded
   * (`Number.MAX_SAFE_INTEGER`).
   */
  readonly maxMarksPerRun?: number;

  /**
   * @internal Budget cap on keys deleted per run.
   * `CLOUDFLARE_FREE_TIER` sets it — CF free-tier safe as one isolated
   * GC phase for one collection, alternated with a separate direct
   * `compact()` invocation. The default is effectively unbounded
   * (`Number.MAX_SAFE_INTEGER`).
   */
  readonly maxSweepsPerRun?: number;

  /**
   * @internal Clock injection for tests. Defaults to
   * `() => new Date()`. The function is invoked at mark time (to
   * compute every candidate's `due_at`) and at sweep time (to
   * compare against candidate `due_at`).
   */
  readonly now?: () => Date;
}

/**
 * Return shape of {@link runGc}.
 */
export interface RunGcResult {
  /** Per-category counts of newly-marked candidates in this pass. */
  readonly marked: {
    readonly orphan_snapshot: number;
  };
  /** Number of keys deleted in this pass. */
  readonly swept: number;
  /**
   * Per-cause counts of candidates RESOLVED OUT of the ledger without
   * being deleted, because the sweep gate re-checked them and found
   * them no longer eligible: `stale_generation` when the manifest that
   * authorised the mark has been replaced, `still_live` when the key
   * reads live now.
   *
   * A drop frees no bytes, so it drives neither {@link swept} nor
   * `last_swept_at`. It is nonetheless the healthy outcome — dropping
   * is what keeps a permanently-live candidate from wedging the ledger
   * against `GC_MAX_PENDING_CANDIDATES`, which keeps the FIRST N
   * entries. Also emitted as `db.gc.dropped_total`, labelled by cause.
   */
  readonly dropped: {
    readonly stale_generation: number;
    readonly still_live: number;
  };
  /**
   * Depth of `gc/pending.json` after this pass. Drives the
   * `db.orphan.candidate_count` metric. Best-effort on `cas-lost` —
   * see module JSDoc.
   */
  readonly pendingDepth: number;
}

const DEFAULT_MAX_MARKS = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_SWEEPS = Number.MAX_SAFE_INTEGER;
const zeroGcResult = (): RunGcResult => ({
  marked: { orphan_snapshot: 0 },
  swept: 0,
  dropped: { stale_generation: 0, still_live: 0 },
  pendingDepth: 0,
});

/**
 * Single GC pass — mark new orphans, sweep due-elapsed candidates,
 * persist via CAS-update on `gc/pending.json`.
 *
 * Returns immediately if `current.json` is missing — there's nothing
 * to do until a writer has bootstrapped the collection.
 *
 * @example
 * ```ts
 * import { runGc } from "@gusto/baerly-storage";
 *
 * const r = await runGc({ storage, currentJsonKey });
 * console.log(`marked ${r.marked.orphan_snapshot} orphan snapshots, swept ${r.swept}`);
 * ```
 */
export const runGc = async (
  args: { storage: Storage; currentJsonKey: string },
  options: RunGcOptions = {},
): Promise<RunGcResult> => {
  const { storage, currentJsonKey } = args;
  // The internal seam fields (caps + clock + grace) ride on the same
  // runtime object even though the public `RunGcOptions` doesn't
  // surface them. Safe cast — the JS runtime carries every property.
  const internal = options as InternalRunGcOptions;
  const grace = internal.graceMillis ?? GC_GRACE_PERIOD_MILLIS;
  const maxMarks = internal.maxMarksPerRun ?? DEFAULT_MAX_MARKS;
  const maxSweeps = internal.maxSweepsPerRun ?? DEFAULT_MAX_SWEEPS;
  const now = internal.now ?? ((): Date => new Date());
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const collectionName = collectionPrefix.slice(collectionPrefix.lastIndexOf("/") + 1);
  const pendingKey = gcPendingKey(collectionPrefix);
  const signal = options.signal;
  const signalOpts = signal !== undefined ? { signal } : undefined;

  // ── Step 1. Read current.json (skip silently if absent). ────────
  const cur = await readCurrentJson(storage, currentJsonKey, signalOpts);
  if (cur === null) {
    return zeroGcResult();
  }
  const current = cur.json;

  // ── Step 2. Read or create gc/pending.json. ─────────────────────
  // Race-tolerant create: a concurrent pass may have bootstrapped
  // between our read and our create. Re-read on Conflict.
  let pending = await readGcPending(storage, pendingKey, signalOpts);
  if (pending === null) {
    const initial: GcPending = {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [],
      last_swept_at: "",
    };
    try {
      pending = await createGcPending(storage, pendingKey, initial, signalOpts);
    } catch (error) {
      if (error instanceof BaerlyError && error.code === "Conflict") {
        pending = await readGcPending(storage, pendingKey, signalOpts);
        if (pending === null) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  // Set of keys already pending — don't re-mark.
  const known = new Set(pending.json.candidates.map((c) => c.key));

  // Stamped onto every candidate this pass marks, so the sweep gate can
  // tell "still the collection I judged this against" from "a different
  // incarnation wearing the same key". Spread rather than assigned so a
  // manifest with no generation writes no field at all — absent is the
  // legacy-compatible spelling, and it decodes to `NO_GENERATION` on
  // both sides of the later comparison.
  const markGeneration: { generation?: string } =
    current.generation !== undefined ? { generation: current.generation } : {};

  // ── Step 3. Mark orphan snapshots. ──────────────────────────────
  const newCandidates: GcCandidate[] = [];
  let markedOrphanSnapshot = 0;
  // Uncursored on purpose — `listWindow` with no cursor, so the window
  // is always the lexicographic first `maxMarks`. See the module JSDoc
  // for why this phase is the one exemption.
  for await (const entry of storage.list(
    `${collectionPrefix}/snapshot/L9/`,
    listWindow(maxMarks, undefined, signal),
  )) {
    // Liveness starts with exact key equality with the active pointer,
    // never a parsed key range — a snapshot installed directly by
    // `admin restore` or by a replacement fold is live whatever its seq
    // fields say, and one whose name parses as "current-looking" is
    // still dead if `current.snapshot` does not name it.
    if (entry.key === current.snapshot) {
      continue;
    }
    // Only the exact key shape emitted by `snapshotKey` can ever carry
    // deletion authority. Leave opaque objects on the bucket without
    // spending bounded-ledger capacity on an entry that sweep cannot classify.
    if (parseMaxSeqFromCanonicalSnapshotKey(entry.key, collectionPrefix) === null) {
      continue;
    }
    if (known.has(entry.key)) {
      continue;
    }
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(now, grace),
      reason: "orphan-snapshot",
      ...markGeneration,
    });
    markedOrphanSnapshot++;
  }

  // ── Step 4. Rescue live candidates, then sweep due candidates. ──
  // Eligible set = previously-pending entries PLUS this pass's freshly
  // marked entries. Including the new marks lets `runGc({graceMillis:0})`
  // mark-and-sweep in a single pass — useful for tests and for
  // grace-bypassing maintenance jobs. Order: pre-existing first
  // (they've been waiting longer), then new marks.
  const nowMs = now().getTime();
  const sweepCandidates: GcCandidate[] = [...pending.json.candidates, ...newCandidates];
  // Snapshot classification used the initial manifest so stale work remains
  // monotone and deterministic. Re-read only when a due snapshot could be
  // deleted, as late as possible before DELETE. The fresh pointer rescues a
  // candidate it names; every other due snapshot still needs a strict
  // generation-floor proof below before it may enter `toSweep`.
  const hasDueSnapshot = sweepCandidates.some(
    (candidate) => candidate.reason === "orphan-snapshot" && Date.parse(candidate.due_at) <= nowMs,
  );
  const freshCurrent = hasDueSnapshot
    ? await readCurrentJson(storage, currentJsonKey, signalOpts)
    : undefined;
  // The freshest manifest this pass holds. `freshCurrent` exists only
  // when a due snapshot forced the re-read above; otherwise this is the
  // step-1 read. Either way it costs no additional op, and preferring
  // the fresher one narrows — never widens — the window between the
  // read a decision rests on and the DELETE it authorises.
  const fenceCurrent = freshCurrent?.json ?? current;
  const fenceGeneration = fenceCurrent.generation ?? NO_GENERATION;
  const fenceFloor = logSeqStartOf(fenceCurrent);
  const rescuedKeys = new Set<string>();
  const staleGenerationKeys = new Set<string>();
  const evictedKeys = new Set<string>();
  for (const candidate of sweepCandidates) {
    // Arm 0 — legacy eviction. A v0.6-era `orphan-content` candidate names a
    // `content/<sha>.json` side object this build cannot classify and never
    // deletes (module header). Resolve it OUT of the ledger, object untouched.
    //
    // Eviction is load-bearing, not a courtesy to old buckets:
    // `mergeGcPending` keeps the FIRST `GC_MAX_PENDING_CANDIDATES` entries,
    // so a ledger head full of content candidates would silently discard
    // every new `stale-log` and `orphan-snapshot` mark, forever.
    //
    // Ordered BEFORE the generation fence on purpose. Most legacy candidates
    // would fail that fence too, and counting them there fires an alertable
    // `db.gc.dropped_total{cause="stale-generation"}` spike on a legacy
    // bucket's first post-upgrade pass. Eviction frees no bytes and signals
    // nothing wrong, so it drives no counter at all.
    if (candidate.reason === "orphan-content") {
      evictedKeys.add(candidate.key);
      continue;
    }
    // Arm 1 — stale-log deletion authority. A persisted candidate authorizes
    // DELETE only when its key is the exact canonical `log/<seq>.json` for
    // THIS collection; the ledger decoder has no collection context, so
    // malformed, mislabeled, noncanonical, and cross-prefix keys reach here.
    // Resolve them without DELETE — waiting for `due_at` would let an invalid
    // entry wedge the bounded first-N ledger for no safety gain. Ordered
    // before the generation fence so invalid authority does not masquerade as
    // a stale-generation event.
    if (
      candidate.reason === "stale-log" &&
      parseSeqFromCanonicalLogKey(candidate.key, collectionPrefix) === null
    ) {
      evictedKeys.add(candidate.key);
      continue;
    }
    // Arm 2 — snapshot deletion authority. Unknown levels, malformed names,
    // inverted ranges, and cross-prefix keys provide no floor proof, so GC
    // never deletes the object they name. Resolve legacy ledger entries
    // immediately: retaining an opaque candidate would let a full first-N
    // ledger discard every later useful mark indefinitely.
    if (
      candidate.reason === "orphan-snapshot" &&
      parseMaxSeqFromCanonicalSnapshotKey(candidate.key, collectionPrefix) === null
    ) {
      evictedKeys.add(candidate.key);
      continue;
    }
    // Arm 3 — the generation fence, checked before liveness and for
    // every reason. A candidate marked under a manifest that has since
    // been replaced was judged against a keyspace that no longer
    // exists: `baerly admin restore --force` truncates the log, reseeds
    // `log_seq_start` from the surviving objects (which can move the
    // floor DOWN), and re-mints `generation`. A `log/K` that was
    // provably dead under the old floor can be a live entry of the new
    // incarnation, at the same key. Absent compares equal to absent, so
    // a bucket whose manifest never carried a generation is unaffected.
    if ((candidate.generation ?? NO_GENERATION) !== fenceGeneration) {
      staleGenerationKeys.add(candidate.key);
      continue;
    }
    if (candidate.reason === "orphan-snapshot" && candidate.key === freshCurrent?.json.snapshot) {
      rescuedKeys.add(candidate.key);
      continue;
    }
    // Arm 4 — a stale-log candidate that reads live again. Same
    // generation, so this is not a reseed; the floor can still have
    // been rewound by a `--force` that reused the nonce, and a mark
    // taken `GC_GRACE_PERIOD_MILLIS` ago is stale enough to be worth
    // re-deriving from the floor rather than trusted. Arm 1 has already
    // resolved every non-canonical key, so `null` here is unreachable.
    if (candidate.reason === "stale-log") {
      const seq = parseSeqFromCanonicalLogKey(candidate.key, collectionPrefix);
      if (seq !== null && seq >= fenceFloor) {
        rescuedKeys.add(candidate.key);
      }
      continue;
    }
  }
  // All five arms resolve a candidate OUT of the ledger without deleting
  // anything. That is what stops the ledger starving: `mergeGcPending`
  // keeps the FIRST `GC_MAX_PENDING_CANDIDATES` entries, so a
  // permanently-live candidate — or an unclassifiable legacy one — at the
  // head would otherwise wedge it forever and silently discard every later
  // mark.
  const droppedKeys = new Set([...staleGenerationKeys, ...rescuedKeys, ...evictedKeys]);
  const toSweep: GcCandidate[] = [];
  const remaining: GcCandidate[] = [];
  for (const cand of sweepCandidates) {
    if (droppedKeys.has(cand.key)) {
      continue;
    }
    if (toSweep.length < maxSweeps && Date.parse(cand.due_at) <= nowMs) {
      if (cand.reason === "orphan-snapshot") {
        const maxSeq = parseMaxSeqFromCanonicalSnapshotKey(cand.key, collectionPrefix);
        // A compactor may publish this candidate after the fresh manifest GET
        // but before DELETE. The manifest floor is monotone, so only a
        // canonical snapshot wholly below that observed floor is already
        // obsolete in every later generation. Equality stays pending: the
        // internal zero-entry fold seam may publish `[floor, floor)`.
        if (maxSeq === null || maxSeq >= (freshCurrent?.json.log_seq_start ?? 0)) {
          remaining.push(cand);
          continue;
        }
      }
      toSweep.push(cand);
    } else {
      remaining.push(cand);
    }
  }
  // Idempotent DELETE on every in-tree Storage impl — a 404 is a
  // no-op. Parallel via Promise.all; one failure aborts the rest,
  // but the per-key DELETEs that landed are durable.
  await Promise.all(toSweep.map((c) => storage.delete(c.key, signalOpts)));

  // ── Step 5. CAS-write pending.json. ─────────────────────────────
  // MERGE this pass's results INTO the latest stored value rather than
  // overwriting with a precomputed set: `casUpdateGcPending` re-reads
  // `latest` and hands it to `mergeGcPending`, so a concurrent pass's
  // candidates (marked between our read and our write) survive. Writing
  // a precomputed `merged` would silently overwrite them — the If-Match
  // would succeed (fresh etag), so NO conflict is raised and the marks
  // are lost. The mutator is pure + the DELETEs are idempotent + already
  // performed, so the helper safely retries the merge on conflict.
  // `mergeGcPending` drops terminal keys via its existing `sweptKeys`
  // merge input. Positively-live rescues are terminal ledger resolutions too,
  // but only `toSweep` drives DELETEs, result counts, timestamps, and metrics.
  const sweptKeys = new Set([...toSweep.map((candidate) => candidate.key), ...droppedKeys]);
  // `""` when this pass swept nothing — sourcing the no-sweep truth from
  // `latest` (via the merge's "take later" rule) rather than our stale
  // read. With no contention this is observably identical: `latest`
  // equals our read, so the later-of-the-two is the same value.
  const lastSweptAt = toSweep.length > 0 ? now().toISOString() : "";
  const markedSummary = {
    orphan_snapshot: markedOrphanSnapshot,
  };
  let pendingDepth: number;
  try {
    const updated = await casUpdateGcPending(
      storage,
      pendingKey,
      (latest) =>
        mergeGcPending(latest, {
          sweptKeys,
          newCandidates,
          lastSweptAt,
          maxCandidates: GC_MAX_PENDING_CANDIDATES,
        }),
      signalOpts,
    );
    pendingDepth = updated.json.candidates.length;
  } catch (error) {
    // `Conflict` covers two benign races, and the DELETEs we issued are
    // durable in both:
    //   - CAS-lost on pending.json after exhausting the bounded retry —
    //     another GC pass kept landing concurrently;
    //   - the ledger VANISHED between step 2 and here. `baerly admin
    //     restore` deletes `gc/pending.json` on both reseed branches, so
    //     this is routine rather than exceptional.
    //     `casUpdateGcPending` reports it as `Conflict` because it IS a
    //     CAS precondition failure — an `If-Match` PUT against the
    //     deleted key would have 412'd.
    // Either way the next pass re-marks whatever we couldn't persist,
    // bootstrapping a fresh ledger if there isn't one. Surface success —
    // re-throwing would mask the work we DID complete, and on the
    // `runScheduledMaintenance` path (documented "Errors propagate")
    // would surface a routine restore to an operator's cron.
    // `InvalidResponse` — a ledger body that is present but corrupt — is
    // deliberately NOT in this arm and still escapes.
    if (error instanceof BaerlyError && error.code === "Conflict") {
      // Best-effort: we know `remaining.length` is at least the
      // post-sweep depth; concurrent passes may have moved it.
      pendingDepth = remaining.length;
    } else {
      throw error;
    }
  }

  // ── Step 6. Emit metrics. ───────────────────────────────────────
  // In-memory only — zero storage ops. Emit regardless of CAS-lost
  // (the operator wants visibility into best-effort runs too).
  const labels = { collection: collectionName };
  const metrics = ctxMetrics();
  metrics.gauge("db.orphan.candidate_count", pendingDepth, labels);
  metrics.gauge("db.gc.entries_swept_per_second", toSweep.length, labels);
  if (toSweep.length > 0) {
    const byReason = new Map<GcCandidate["reason"], number>();
    for (const c of toSweep) {
      byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      metrics.counter("db.gc.swept_total", count, { collection: collectionName, reason });
    }
  }
  // Separate from `db.gc.swept_total` on purpose: a drop frees no bytes,
  // so folding the two would make a pass that reclaimed nothing look
  // productive. A `stale-generation` spike is expected exactly once
  // after a restore or an upgrade and is alertable if it persists; a
  // sustained `still-live` rate means the mark phase is misjudging
  // liveness, which is the failure this gate exists to contain.
  if (staleGenerationKeys.size > 0) {
    metrics.counter("db.gc.dropped_total", staleGenerationKeys.size, {
      collection: collectionName,
      cause: "stale-generation",
    });
  }
  if (rescuedKeys.size > 0) {
    metrics.counter("db.gc.dropped_total", rescuedKeys.size, {
      collection: collectionName,
      cause: "still-live",
    });
  }

  return {
    marked: markedSummary,
    swept: toSweep.length,
    dropped: {
      stale_generation: staleGenerationKeys.size,
      still_live: rescuedKeys.size,
    },
    pendingDepth,
  };
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `Storage.list` options for one bounded rotation window: at most
 * `maxKeys` keys, resuming strictly after `cursor` when the ledger
 * carries one. `maxKeys` is a hard cross-page total on every adapter
 * (`docs/spec/storage-compatibility.md`), which is what makes
 * "yielded fewer than we asked for ⇒ end of keyspace" a sound wrap
 * test. `startAfter` is strict-greater on the key VALUE, so a cursor
 * naming a key this pass already deleted still resumes correctly —
 * never probe whether it still exists.
 */
const listWindow = (
  maxKeys: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): { startAfter?: string; maxKeys: number; signal?: AbortSignal } => ({
  maxKeys,
  ...(cursor !== undefined && { startAfter: cursor }),
  ...(signal !== undefined && { signal }),
});

/**
 * Parse the exact canonical `log/<seq>.json` key for this collection.
 * Returns `null` for another prefix, malformed or noncanonical decimal,
 * or a sequence outside JavaScript's safe-integer range.
 */
const parseSeqFromCanonicalLogKey = (key: string, collectionPrefix: string): number | null => {
  const logPrefix = `${collectionPrefix}/log/`;
  if (!key.startsWith(logPrefix)) {
    return null;
  }
  const match = /^(\d+)\.json$/.exec(key.slice(logPrefix.length));
  if (match === null) {
    return null;
  }
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq >= 0 && logObjectKey(collectionPrefix, seq) === key
    ? seq
    : null;
};

/**
 * Parse the exclusive `max_seq` from the exact key shape emitted by
 * `snapshotKey`. Unknown levels/layouts and invalid ranges stay opaque: GC
 * never deletes the object and never retains its candidate in the bounded
 * ledger.
 */
const parseMaxSeqFromCanonicalSnapshotKey = (
  key: string,
  collectionPrefix: string,
): number | null => {
  const snapshotPrefix = `${collectionPrefix}/snapshot/L9/`;
  if (!key.startsWith(snapshotPrefix)) {
    return null;
  }
  const match = /^(\d{12})-(\d{12})-[0-9a-f]{64}\.json$/.exec(key.slice(snapshotPrefix.length));
  if (match === null) {
    return null;
  }
  const minSeq = Number(match[1]);
  const maxSeq = Number(match[2]);
  // Twelve decimal digits are always safely below MAX_SAFE_INTEGER.
  return minSeq <= maxSeq ? maxSeq : null;
};

/**
 * Anchor `due_at` on the MARK: `now() + graceMs`. Grace measures the
 * writer-retry window from when we judged a key dead, which is
 * unrelated to when the object was written.
 *
 * Never anchor on the object's own timestamp. Doing so made the
 * effective grace `max(0, graceMs − object age)` — zero past the
 * 7-day default, for exactly the old objects GC marks. It read a
 * `lastModified` that only the S3/GCS/R2 adapters populated, so the
 * suite's backends showed a full window and no test could see it.
 * `StorageListEntry` no longer carries a timestamp; `gc.test.ts`
 * still pins the behaviour against an entry that fakes one.
 *
 * Called per candidate, not hoisted per pass, so the local-clock
 * backends keep their exact previous horizon.
 */
const computeDueAt = (now: () => Date, graceMs: number): string =>
  new Date(now().getTime() + graceMs).toISOString();

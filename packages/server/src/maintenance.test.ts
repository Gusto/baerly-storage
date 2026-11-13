/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Maintenance — `runScheduledMaintenance()` composition of
 * `compact()` + `runGc()` under `MemoryStorage`, plus the write-tick
 * `runBoundedMaintenance()` runner and its pure gate helpers. The
 * adapter-side write-tick wiring (the per-request `MaintenanceDispatch`
 * the writer reads) is covered by the adapter packages' own tests.
 */

import {
  BaerlyError,
  CF_PAID_COMPACT_TAIL_PROBE_GETS,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  casUpdateCurrentJson,
  type CurrentJson,
  GC_STARVATION_GUARD,
  logDeleteFloorOf,
  logObjectKey,
  MAINTENANCE_COLD_START_ENTRY_BYTES,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MAINTENANCE_WARN_INTERVAL_WRITES,
  MAINTENANCE_PROFILE_CF_FREE,
  MemoryStorage,
  readCurrentJson,
  RequestLedger,
  type RequestPool,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
  SCHEDULED_MIN_ENTRIES_TO_COMPACT,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_INTERVAL,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { compact } from "./compactor.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  crossesGcBoundary,
  dispatchInlineAwaited,
  estimateTailBytes,
  parseMaintenanceEnv,
  runBoundedMaintenance,
  runScheduledMaintenance,
  shouldFireMaintenance,
} from "./maintenance.ts";
import type {
  InternalBoundedMaintenanceOptions,
  InternalMaintenanceOptions,
} from "./maintenance-options.ts";
import { probeTailFrom } from "./log-tail.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { RequestScopedMetricsRecorder } from "./observability/recorder.ts";
import { Writer } from "./writer.ts";
import { ledgeredStorage } from "../../../tests/fixtures/ledgered-storage.ts";
import { logStateCurrentJson, seedLogEntries } from "../../../tests/fixtures/log-state.ts";

const KEY = "app/t/tenant/x/manifests/c/current.json";
const COLL = "c";
const COLLECTION_PREFIX = "app/t/tenant/x/manifests/c";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maintenance-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

describe("runScheduledMaintenance", () => {
  test("runs both compact and gc by default", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 150; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await runScheduledMaintenance(
      { storage: s, currentJsonKey: KEY },
      // Bypass GC's 7-day grace so the sweep path actually runs in
      // one tick. Engine defaults are unbounded so a single pass folds
      // the entire live tail.
      { gc: { graceMillis: 0 } as InternalRunGcOptions },
    );
    expect(r.compact.written).toBe(true);
    expect(r.compact.entriesFolded).toBe(150);
    // After compact, [0, 150) are folded into the snapshot. GC runs
    // but has nothing to mark (no orphan snapshots). The stale log
    // entries will be deleted by retireLogRange on a future maintenance
    // pass.
  });

  test("runGc alone runs without compact", async () => {
    // Single-phase ticks (e.g. the CF free-tier even/odd-minute cron
    // pattern) invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).not.toBeNull();
  });

  test("compact alone runs without gc", async () => {
    // Single-phase ticks invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 150; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await compact({ storage: s, currentJsonKey: KEY });
    expect(r.written).toBe(true);
  });

  test("a low-write collection folds under the scheduled default (no options)", async () => {
    // The scheduled path owns its own floor (SCHEDULED_MIN_ENTRIES_TO_COMPACT,
    // 1): a scheduler that fires has already decided it is time to work, so
    // a tail of 3 entries must NOT sit in the dead zone below compact()'s
    // own default of 100 — the historical failure mode where a cron ticked
    // green for months while every read replayed the whole tail.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await runScheduledMaintenance({ storage: s, currentJsonKey: KEY });
    expect(r.compact.written).toBe(true);
    expect(r.compact.entriesFolded).toBe(3);
    await expect(readSeqStart(s, KEY)).resolves.toBe(3);
  });

  test("an explicit options.compact.minEntriesToCompact overrides the scheduled default", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 5; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await runScheduledMaintenance(
      { storage: s, currentJsonKey: KEY },
      { compact: { minEntriesToCompact: 10 } },
    );
    expect(r.compact.written).toBe(false);
    expect(r.compact.skippedReason).toBe("below-min-threshold");
    expect(r.compact.entriesFolded).toBe(0);
    await expect(readSeqStart(s, KEY)).resolves.toBe(0);
  });

  test("a below-min skip bumps db.compaction.below_min_total", async () => {
    // The skip must be observable through the metrics recorder, not just
    // the return value — a cron loop that discards results looked healthy
    // while folding nothing for months.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const recorder = await withRecorder(async () => {
      const r = await compact({ storage: s, currentJsonKey: KEY });
      expect(r.written).toBe(false);
      expect(r.skippedReason).toBe("below-min-threshold");
    });
    expect(counterTotal(recorder, "db.compaction.below_min_total")).toBe(1);
  });

  test("an idle below-min skip does not bump db.compaction.below_min_total", async () => {
    // available === 0 is not a dead zone: there is no live tail left
    // unfolded. After the scheduled floor of 1, the default scheduled
    // path only skips when idle; counting that would make the playbook
    // counter mean "the cron fired", not "a tail sat under the floor".
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const recorder = await withRecorder(async () => {
      const r = await compact({ storage: s, currentJsonKey: KEY });
      expect(r.written).toBe(false);
      expect(r.skippedReason).toBe("below-min-threshold");
    });
    expect(counterTotal(recorder, "db.compaction.below_min_total")).toBe(0);
  });

  test("the scheduled default does not leak into compact()'s own floor (in-band default stays 100)", async () => {
    // `compact()`'s DEFAULT_MIN_TO_COMPACT is the in-band write-tick shape:
    // folding on every write would thrash snapshot rewrites. The scheduled
    // fix must not move it.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await compact({ storage: s, currentJsonKey: KEY });
    expect(r.written).toBe(false);
    expect(r.skippedReason).toBe("below-min-threshold");
  });

  test("runScheduledMaintenance with CLOUDFLARE_PAID_TIER folds a sub-50 tail", async () => {
    // Paid scheduled profile exists for per-pass caps (maxEntriesPerRun: 200,
    // GC bounds), not an in-band count floor. The helper default is
    // SCHEDULED_MIN_ENTRIES_TO_COMPACT (1), so a 36-entry tail — the
    // measured incident — must fold rather than sit in the old 50-entry
    // write-tick dead zone.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    const n = 36;
    for (let i = 0; i < n; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await runScheduledMaintenance(
      { storage: s, currentJsonKey: KEY },
      CLOUDFLARE_PAID_TIER,
    );
    expect(r.compact.written).toBe(true);
    expect(r.compact.entriesFolded).toBe(n);
    await expect(readSeqStart(s, KEY)).resolves.toBe(n);
  });

  test("CLOUDFLARE_FREE_TIER carries the documented bounds", async () => {
    // A regression in these constants means the budget audits and
    // the per-tier docstring lie about the worst-case I/O profile.
    // The budget caps live on the InternalMaintenanceOptions surface
    // (they're not part of the public `MaintenanceOptions` shape).
    const cfFree = CLOUDFLARE_FREE_TIER as InternalMaintenanceOptions;

    expect(cfFree.compact?.maxEntriesPerRun).toBe(20);
    expect(cfFree.compact?.minEntriesToCompact).toBe(20);
    expect(cfFree.compact?.maxTailProbeGets).toBe(25);
    expect(cfFree.gc?.maxMarksPerRun).toBe(20);
    expect(cfFree.gc?.maxSweepsPerRun).toBe(10);
  });

  test("CLOUDFLARE_FREE_TIER keeps its fold threshold within one probe budget", () => {
    // Not a restatement of the constants above: this is the RELATION
    // between two of them. `compact()` derives `available` from a probe
    // that certifies at most `probeFloor + maxTailProbeGets`, so a
    // threshold above that budget cannot be met by a single pass — every
    // pass would return `probe-budget-checkpointed` and fold nothing until
    // enough passes had ratcheted `tail_hint` forward. Raising the
    // threshold or lowering the probe budget in isolation reintroduces
    // that stall, so bind them here.
    const cfFree = CLOUDFLARE_FREE_TIER as InternalMaintenanceOptions;
    const threshold = cfFree.compact?.minEntriesToCompact;
    const probeBudget = cfFree.compact?.maxTailProbeGets;

    expect(threshold).toBeDefined();
    expect(probeBudget).toBeDefined();
    expect(threshold as number).toBeLessThanOrEqual(probeBudget as number);
  });

  test("CLOUDFLARE_PAID_TIER carries the Node-derived per-pass bounds", () => {
    // CF-paid reuses NODE_MAINTENANCE_* per-pass caps: the paid 10,000-
    // subrequest budget is far above these bounds. Exact GC operation
    // accounting is owned by maintenance-budget.test.ts and the
    // CLOUDFLARE_FREE_TIER JSDoc. A regression here means the cron-path
    // recipe in worker.ts is lying about what callers can afford per tick.
    const cfPaid = CLOUDFLARE_PAID_TIER as InternalMaintenanceOptions;

    expect(cfPaid.compact?.maxEntriesPerRun).toBe(200);
    expect(cfPaid.compact?.minEntriesToCompact).toBe(SCHEDULED_MIN_ENTRIES_TO_COMPACT);
    expect(cfPaid.compact?.maxTailProbeGets).toBe(CF_PAID_COMPACT_TAIL_PROBE_GETS);
    expect(cfPaid.gc?.maxMarksPerRun).toBe(200);
    expect(cfPaid.gc?.maxSweepsPerRun).toBe(100);
  });
});

// ---------------------------------------------------------------------
// Pure gate helpers
// ---------------------------------------------------------------------

describe("crossesGcBoundary", () => {
  test("floor-based crossing is batch-safe (a jump over a boundary still trips)", () => {
    // A modulo test (`tail_hint % interval === 0`) would MISS this jump
    // from 3 to 9 with interval 4 — neither 3 nor 9 is a multiple of 4,
    // yet the [4,8] boundaries were crossed.
    expect(crossesGcBoundary(3, 9, 4)).toBe(true);
    // Same bucket: floor(5/4)===floor(6/4)===1, no crossing.
    expect(crossesGcBoundary(5, 6, 4)).toBe(false);
    // Exact boundary landing.
    expect(crossesGcBoundary(3, 4, 4)).toBe(true);
  });
});

describe("estimateTailBytes", () => {
  const base = (over: Partial<CurrentJson>): CurrentJson => ({
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "t", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
    ...over,
  });

  test("(observedTail − log_seq_start) × mean_entry_bytes once a mean is stamped", () => {
    const cur = base({ log_seq_start: 10, mean_entry_bytes: 1000 });
    // 40 live entries × 1000 bytes/entry.
    expect(estimateTailBytes(cur, 50)).toBe(40_000);
  });

  test("clamps a below-floor live count to 0 (observedTail < log_seq_start can't happen, but guard it)", () => {
    const cur = base({ log_seq_start: 50, mean_entry_bytes: 1000 });
    expect(estimateTailBytes(cur, 50)).toBe(0);
  });

  test("cold-start (no mean stamped) falls back to a conservative per-entry size, NOT zero", () => {
    // Pre-first-fold the estimate must still accrue with live-tail length so a
    // bare Db.create() bootstraps its first write-tick fold (the compactor
    // stamps the mean only once a fold runs). Zero here would make the ratio
    // dead pre-stamp and break that bootstrap promise.
    const cur = base({ log_seq_start: 0 });
    expect(estimateTailBytes(cur, 10)).toBe(10 * MAINTENANCE_COLD_START_ENTRY_BYTES);
    expect(estimateTailBytes(cur, 0)).toBe(0);
  });

  test("cold-start per-entry size is conservative (small) — does NOT over-fire for small entries", () => {
    // A too-large cold-start estimate (e.g. tying it to MIN_LIVE_BYTES / the
    // entry floor) would fire the first write-tick fold an order of magnitude
    // earlier than a precisely measured path for typical small entries.
    // Keeping it ≪ MIN_LIVE_BYTES / entry-floor preserves today's first-fold
    // timing: the ratio floor is crossed only after MANY more than the entry
    // floor's worth of small entries accrue.
    expect(MAINTENANCE_COLD_START_ENTRY_BYTES).toBeLessThan(
      MAINTENANCE_MIN_LIVE_BYTES / WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
    );
    // At the gate-1 entry floor the cold-start estimate is still well under the
    // ratio floor — so the entry floor, not a spurious ratio trip, gates here.
    const cur = base({ log_seq_start: 0 });
    expect(estimateTailBytes(cur, WRITE_TICK_MIN_ENTRIES_TO_COMPACT)).toBeLessThan(
      MAINTENANCE_MIN_LIVE_BYTES,
    );
  });
});

describe("shouldFireMaintenance", () => {
  const base = (over: Partial<CurrentJson>): CurrentJson => ({
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "t", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
    ...over,
  });

  test("fires on a crossed GC boundary even when ratio is cold", () => {
    // Drives PURELY off tail_hint / log_seq_start / mean_entry_bytes.
    // observedTail == tail_hint under the single-write commit.
    const cur = base({ tail_hint: WRITE_TICK_GC_INTERVAL });
    expect(shouldFireMaintenance(cur, 0, WRITE_TICK_GC_INTERVAL, cur.tail_hint)).toBe(true);
  });

  test("fires when the DERIVED tail/snapshot ratio meets the target", () => {
    // snapshot floored to MIN_LIVE_BYTES; estimate equal to it ⇒ ratio 1.0.
    // Estimate = (observedTail − log_seq_start) × mean_entry_bytes
    //          = (mean entries) × mean_entry_bytes.
    const mean = 1024;
    const liveEntries = MAINTENANCE_MIN_LIVE_BYTES / mean; // 64 entries ⇒ exactly the floor
    const cur = base({
      tail_hint: liveEntries,
      log_seq_start: 0,
      mean_entry_bytes: mean,
      snapshot_bytes: 0,
    });
    expect(shouldFireMaintenance(cur, liveEntries, 999, cur.tail_hint)).toBe(true);
    // One entry below the floor ⇒ no-fire (ratio < 1, no GC boundary).
    const below = base({
      tail_hint: liveEntries - 1,
      log_seq_start: 0,
      mean_entry_bytes: mean,
      snapshot_bytes: 0,
    });
    expect(shouldFireMaintenance(below, below.tail_hint, 999, below.tail_hint)).toBe(false);
  });

  test("does not fire when neither gate trips", () => {
    const cur = base({ tail_hint: 1, log_seq_start: 0, mean_entry_bytes: 0, snapshot_bytes: 0 });
    expect(shouldFireMaintenance(cur, 1, 999, cur.tail_hint)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// runBoundedMaintenance
// ---------------------------------------------------------------------

interface Counting {
  readonly storage: Storage;
  readonly total: () => number;
  readonly report: () => Record<string, number>;
  /** PUT keys in call order — the seam for asserting WRITE SHAPE, not just volume. */
  readonly putKeys: () => string[];
}

const countingStorage = (inner: Storage): Counting => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const putKeys: string[] = [];
  const wrapper: Storage = {
    async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
      counts.get += 1;
      return inner.get(key, opts);
    },
    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      counts.put += 1;
      putKeys.push(key);
      return inner.put(key, body, opts);
    },
    async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      counts.delete += 1;
      return inner.delete(key, opts);
    },
    list(
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> {
      counts.list += 1;
      return inner.list(prefix, opts);
    },
  };
  return {
    storage: wrapper,
    total: (): number => counts.get + counts.put + counts.delete + counts.list,
    report: (): Record<string, number> => ({ ...counts }),
    putKeys: (): string[] => [...putKeys],
  };
};

/** Seed `n` real log entries via the Writer (no snapshot yet). */
const seedLog = async (storage: Storage, key: string, coll: string, n: number): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "bounded-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const writer = new Writer({ storage, currentJsonKey: key });
  for (let i = 0; i < n; i++) {
    await writer.commit({
      op: "I",
      collection: coll,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i },
    });
  }
};

/** Patch the gate-driving fields on `current.json` in place. */
const patchCurrent = async (
  storage: Storage,
  key: string,
  patch: Partial<Pick<CurrentJson, "snapshot_bytes" | "snapshot_rows" | "mean_entry_bytes">>,
): Promise<void> => {
  await casUpdateCurrentJson(storage, key, (cur) => ({ ...cur, ...patch }));
};

/**
 * A `mean_entry_bytes` large enough that `estimateTailBytes` for any tail of
 * ≥1 live entry clears `MAINTENANCE_MIN_LIVE_BYTES` (so the derived ratio
 * trigger trips).
 */
const RATIO_TRIPPING_MEAN = MAINTENANCE_MIN_LIVE_BYTES;

const readSeqStart = async (storage: Storage, key: string): Promise<number> => {
  const r = await readCurrentJson(storage, key);
  if (r === null) {
    throw new Error("current.json missing");
  }
  return r.json.log_seq_start;
};

const readLastWarnedSeq = async (storage: Storage, key: string): Promise<number | undefined> => {
  const r = await readCurrentJson(storage, key);
  if (r === null) {
    throw new Error("current.json missing");
  }
  return r.json.last_warned_seq;
};

const readTailHint = async (storage: Storage, key: string): Promise<number> => {
  const r = await readCurrentJson(storage, key);
  if (r === null) {
    throw new Error("current.json missing");
  }
  return r.json.tail_hint;
};

/** Install a fresh spy recorder over `fn` and return what it observed. */
const withRecorder = async (fn: () => Promise<void>): Promise<RequestScopedMetricsRecorder> => {
  const recorder = new RequestScopedMetricsRecorder();
  const ctx = createObservabilityContext({ recorder });
  await runWithContext(ctx, fn);
  return recorder;
};

const counterTotal = (recorder: RequestScopedMetricsRecorder, name: string): number =>
  recorder
    .snapshot()
    .counters.filter((c) => c.name === name)
    .reduce((acc, c) => acc + c.value, 0);

describe("runBoundedMaintenance", () => {
  test("disabled: true skips fold/GC and does not refresh tail_hint below the guard interval", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    await seedLogEntries(inner, COLLECTION_PREFIX, 0, 60);
    const c = countingStorage(inner);
    await runBoundedMaintenance({
      storage: c.storage,
      currentJsonKey: KEY,
      prevSeq: 0,
      observedTail: 60,
      disabled: true,
    });
    expect(c.report()).toEqual({ get: 1, put: 0, delete: 0, list: 0 });
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);
    await expect(readTailHint(inner, KEY)).resolves.toBe(0);
  });

  test("disabled: true still refreshes tail_hint at the guard interval", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    await seedLogEntries(inner, COLLECTION_PREFIX, 0, MAINTENANCE_TAIL_HINT_REFRESH_WRITES);
    const c = countingStorage(inner);
    await runBoundedMaintenance({
      storage: c.storage,
      currentJsonKey: KEY,
      prevSeq: 0,
      observedTail: MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
      disabled: true,
    });

    expect(c.report()).toEqual({ get: 2, put: 1, delete: 0, list: 0 });
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);
    await expect(readTailHint(inner, KEY)).resolves.toBe(MAINTENANCE_TAIL_HINT_REFRESH_WRITES);
  });

  test("single-phase: a fold-viable, gate1-tripping tick folds and does NOT also GC", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // Ratio >= 1 and >= minEntriesToCompact (60 >= 50). Snapshot tiny ⇒ fold-viable.
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    // Choose prevSeq == the TRUE tail so NO gc boundary is crossed. Under
    // single-write commit the runner re-probes the tail (60 entries =
    // tail 60); the stored tail_hint stays 0, so we pass 60 explicitly.
    const c = countingStorage(inner);
    await runBoundedMaintenance({
      storage: c.storage,
      currentJsonKey: KEY,
      prevSeq: 60, // == probed tail ⇒ no GC boundary
    });
    const after = await readSeqStart(inner, KEY);
    // Folded a slice.
    expect(after).toBeGreaterThan(before);
    // No GC ran ⇒ no DELETEs and no gc/pending.json was touched.
    expect(c.report()["delete"]).toBe(0);
  });

  test("foldAtTailEntries folds a tail that long with the ratio cold, and no shorter one", async () => {
    // A small tail on a large snapshot: ratio far below 1, and the tail
    // under WRITE_TICK_MIN_ENTRIES_TO_COMPACT, so only foldAtTailEntries
    // can trip Gate 1.
    for (const [tail, folds] of [
      [8, false],
      [9, true],
    ] as const) {
      const inner = new MemoryStorage();
      await seedLog(inner, KEY, COLL, tail);
      await patchCurrent(inner, KEY, { mean_entry_bytes: 64, snapshot_bytes: 256 * 1024 });
      await runBoundedMaintenance(
        { storage: inner, currentJsonKey: KEY, prevSeq: tail, observedTail: tail },
        { foldAtTailEntries: 9 } as InternalBoundedMaintenanceOptions,
      );
      await expect(readSeqStart(inner, KEY)).resolves.toBe(folds ? tail : 0);
    }
  });

  test("the write-tick floor stays WRITE_TICK_MIN_ENTRIES_TO_COMPACT — a 40-entry gate1-tripping tail does NOT fold", async () => {
    // The two maintenance triggers have opposite cost profiles: the
    // scheduled path drains whatever tail exists (floor 1), the in-band
    // write tick keeps its 50-entry floor so a write never thrashes
    // snapshot rewrites. 40 entries trip neither 50 nor 100 — under the
    // OLD shared shape this was exactly the measured dead zone (a 36-entry
    // tail costing 36 S3 GETs per read); it must stay unfolded on the tick
    // path.
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 40);
    // Ratio >= 1 so ONLY the entry floor gates gate1 (40 < 50).
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    await runBoundedMaintenance({
      storage: inner,
      currentJsonKey: KEY,
      prevSeq: 40, // == probed tail ⇒ no GC boundary either
    });
    await expect(readSeqStart(inner, KEY)).resolves.toBe(before); // 0 — nothing folded
    // Contrast: the same store under the scheduled path folds it all.
    const r = await runScheduledMaintenance({ storage: inner, currentJsonKey: KEY });
    expect(r.compact.written).toBe(true);
    expect(r.compact.entriesFolded).toBe(40);
  });

  test("non-fold tick that crosses the GC boundary runs runGc", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // Pre-compact so there are stale-log candidates to mark, then make
    // the tail too small to trip gate1 (ratio < 1).
    await compact({ storage: inner, currentJsonKey: KEY });
    await patchCurrent(inner, KEY, { snapshot_bytes: 10_000_000 });
    // gate1 false (ratio≈0). prevSeq=57→nextSeq=60 crosses a SOFT gc
    // boundary (floor 14→15) but NOT the hard boundary, so we exercise
    // the gate1-false → soft-cadence GC branch (not the starvation guard).
    const recorder = await withRecorder(async () => {
      await runBoundedMaintenance(
        {
          storage: inner,
          currentJsonKey: KEY,
          prevSeq: 57,
        },
        { profile: MAINTENANCE_PROFILE_CF_FREE },
      );
    });
    // GC marked the stale-log candidates left by the pre-compact.
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
    const pending = await inner.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
  });

  test("a deferring bucket (snapshot over E rows) does NOT fold but DOES GC + bumps deferred_total", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60); // log_seq_start=0, tail=60 >= min 50 ⇒ gate1 trips
    // gate1 trips (ratio>=1, tail entries >= min) but snapshot_rows over E.
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // > MAINTENANCE_MAX_FOLD_ROWS
    });
    const before = await readSeqStart(inner, KEY);
    // prevSeq=57 → nextSeq=60 crosses a SOFT gc boundary (floor 14→15)
    // but NOT the hard boundary (floor(57/16)===floor(60/16)===3), so
    // the defer path runs and falls through to a soft-cadence GC.
    const recorder = await withRecorder(async () => {
      await runBoundedMaintenance(
        {
          storage: inner,
          currentJsonKey: KEY,
          prevSeq: 57,
        },
        { profile: MAINTENANCE_PROFILE_CF_FREE },
      );
    });
    const after = await readSeqStart(inner, KEY);
    // Deferred ⇒ no fold ⇒ log_seq_start unchanged.
    expect(after).toBe(before);
    expect(counterTotal(recorder, "db.compaction.deferred_total")).toBeGreaterThan(0);
    // Fell through to GC: pending.json exists.
    const pending = await inner.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
  });

  test("HR-2: a deferring collection advances tail_hint toward the observed tail so reads stay bounded and complete", async () => {
    // A collection whose snapshot exceeds the fold ceiling DEFERS folding
    // forever, so the compactor never stamps tail_hint via its Step-7 fold
    // CAS. Without HR-2 the gap (true_tail − tail_hint) grows without bound
    // and every read re-walks the whole live tail; combined with B3 it would
    // eventually THROW at the cap. HR-2: the maintenance tick advances
    // tail_hint toward the observed tail on the defer path (rate-limited,
    // write-tick only), bounding the read-walk to ≤ REFRESH_INTERVAL.
    const inner = new MemoryStorage();
    // True tail well past tail_hint=0 and past REFRESH_INTERVAL.
    const trueTail = MAINTENANCE_TAIL_HINT_REFRESH_WRITES * 3; // 384 entries
    await seedLog(inner, KEY, COLL, trueTail); // log_seq_start=0, tail_hint=0
    // Force the defer: snapshot over E rows, ratio-tripping mean.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      tail_hint: 0,
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // > MAINTENANCE_MAX_FOLD_ROWS ⇒ defer
    }));

    // tail_hint starts far behind the true tail.
    await expect(readTailHint(inner, KEY)).resolves.toBe(0);

    // Run a write-tick maintenance pass with the writer's observed tail.
    await runBoundedMaintenance(
      {
        storage: inner,
        currentJsonKey: KEY,
        prevSeq: trueTail,
        observedTail: trueTail,
      },
      { profile: MAINTENANCE_PROFILE_CF_FREE },
    );

    // (a) tail_hint was advanced to within REFRESH_INTERVAL of the true
    //     tail, bounding any subsequent read-walk.
    const hint = await readTailHint(inner, KEY);
    expect(trueTail - hint).toBeLessThanOrEqual(MAINTENANCE_TAIL_HINT_REFRESH_WRITES);

    // (b) a reader probing from the (now-fresh) hint still discovers the
    //     COMPLETE true tail — the advance never overshoots the real tail.
    const { tail } = await probeTailFrom(inner, COLLECTION_PREFIX, hint);
    expect(tail).toBe(trueTail);
  });

  test("a defer pass past the warn interval warns once AND stamps last_warned_seq", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60); // tail_hint = 60 (>= WARN_INTERVAL would be false…)
    // …so force tail_hint well past the interval boundary by stamping a
    // current.json whose tail_hint is large but last_warned_seq is absent.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // > MAINTENANCE_MAX_FOLD_ROWS ⇒ defer
      tail_hint: MAINTENANCE_WARN_INTERVAL_WRITES + 5,
      log_seq_start: 0,
    }));
    const expectedNextSeq = MAINTENANCE_WARN_INTERVAL_WRITES + 5;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorder = await withRecorder(async () => {
        await runBoundedMaintenance(
          {
            storage: inner,
            currentJsonKey: KEY,
            prevSeq: expectedNextSeq, // no GC boundary; isolate the defer
          },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        );
      });
      // Deferred ⇒ metric bumped (existing behaviour).
      expect(counterTotal(recorder, "db.compaction.deferred_total")).toBeGreaterThan(0);
      // Warn fired exactly once, and named the actionable signals.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("BAERLY_MAINTENANCE_MAX_FOLD_BYTES");
      expect(msg).toContain("docs/about/graduation.md");
    } finally {
      warnSpy.mockRestore();
    }
    // The warn stamped last_warned_seq = tail_hint via a separate CAS.
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBe(expectedNextSeq);
  });

  test("a defer pass WITHIN the warn interval does NOT warn — across FRESH runner calls", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // last_warned_seq sits just below tail_hint ⇒ inside the interval.
    const nextSeq = MAINTENANCE_WARN_INTERVAL_WRITES + 5;
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // defer
      tail_hint: nextSeq,
      log_seq_start: 0,
      last_warned_seq: nextSeq - 1, // 1 < MAINTENANCE_WARN_INTERVAL_WRITES
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Two SEPARATE runner invocations — no per-isolate Set could span
      // these; the only rate-limit state lives in current.json.
      const recorder = await withRecorder(async () => {
        await runBoundedMaintenance(
          { storage: inner, currentJsonKey: KEY, prevSeq: nextSeq },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        );
        await runBoundedMaintenance(
          { storage: inner, currentJsonKey: KEY, prevSeq: nextSeq },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        );
      });
      // Still deferred both times…
      expect(counterTotal(recorder, "db.compaction.deferred_total")).toBeGreaterThan(0);
      // …but no warn, because tail_hint - last_warned_seq < interval.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
    // last_warned_seq untouched by a within-interval defer.
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBe(nextSeq - 1);
  });

  test("a folding (non-deferring) pass NEVER warns", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // gate1 trips and snapshot is tiny ⇒ fold-viable. Push tail_hint well
    // past the warn interval so a stray warn would be visible.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
      tail_hint: MAINTENANCE_WARN_INTERVAL_WRITES + 5,
    }));
    const cur = await readCurrentJson(inner, KEY);
    const nextSeq = cur!.json.tail_hint;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runBoundedMaintenance({
        storage: inner,
        currentJsonKey: KEY,
        prevSeq: nextSeq, // no GC boundary; just fold
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
    // No stamp on a folding pass.
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBeUndefined();
  });

  test("fold advances by only a bounded slice, not the whole tail", async () => {
    const inner = new MemoryStorage();
    const tail = WRITE_TICK_FOLD_ENTRIES_PER_PASS * 5; // 100, far > one slice
    await seedLog(inner, KEY, COLL, tail);
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    await runBoundedMaintenance({
      storage: inner,
      currentJsonKey: KEY,
      prevSeq: tail, // == probed tail ⇒ no GC boundary; just fold
    });
    const after = await readSeqStart(inner, KEY);
    expect(after - before).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(after).toBeLessThan(tail);
  });

  test("cas-lost fold bumps db.compaction.cas_lost_total", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // Storage that fails the current.json CAS PUT exactly once (the
    // compactor's step-7 advance), forcing skippedReason: "cas-lost".
    let failedOnce = false;
    const failingPut: Storage = {
      get: inner.get.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!failedOnce && key === KEY && opts?.ifMatch !== undefined) {
          failedOnce = true;
          throw new BaerlyError("WriteConflict", "simulated CAS loss");
        }
        return inner.put(key, body, opts);
      },
    };
    const recorder = await withRecorder(async () => {
      await runBoundedMaintenance({
        storage: failingPut,
        currentJsonKey: KEY,
        prevSeq: 60, // == probed tail ⇒ no GC boundary; isolate the fold
      });
    });
    expect(counterTotal(recorder, "db.compaction.cas_lost_total")).toBeGreaterThan(0);
    // cas-lost is EXPECTED — no unexpected-error bump, runner resolved.
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
  });

  // Every tick that is due must refresh `tail_hint`, whichever way it exits:
  // the writer's `findLogTail` gallops from the stored hint, so each skipped
  // refresh leaves the next commit paying `2 * ceil(log2(lag + 1))` GETs.
  // The tail is one GC interval past the refresh interval, so the tick is
  // due for a refresh, and `prevSeq = tail - 1` crosses the soft GC boundary
  // but not the hard one.
  describe("refreshes tail_hint on every exit, so the next commit's tail search is one GET", () => {
    const tail = MAINTENANCE_TAIL_HINT_REFRESH_WRITES + WRITE_TICK_GC_INTERVAL;
    const prevSeq = tail - 1;

    /** Storage that fails one op, chosen per case, and records current.json PUTs. */
    const faulty = (
      inner: Storage,
      fault: (op: "get" | "put", key: string, opts?: StoragePutOptions) => BaerlyError | null,
    ): { storage: Storage; headPuts: () => number; faulted: () => boolean } => {
      let headPuts = 0;
      let faulted = false;
      const maybeFault = (op: "get" | "put", key: string, opts?: StoragePutOptions): void => {
        if (faulted) {
          return;
        }
        const error = fault(op, key, opts);
        if (error !== null) {
          faulted = true;
          throw error;
        }
      };
      return {
        storage: {
          async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
            maybeFault("get", key);
            return inner.get(key, opts);
          },
          async put(
            key: string,
            body: Uint8Array,
            opts?: StoragePutOptions,
          ): Promise<StoragePutResult> {
            if (key === KEY) {
              headPuts += 1;
            }
            maybeFault("put", key, opts);
            return inner.put(key, body, opts);
          },
          delete: inner.delete.bind(inner),
          list: inner.list.bind(inner),
        },
        headPuts: (): number => headPuts,
        faulted: (): boolean => faulted,
      };
    };

    const cases: ReadonlyArray<{
      name: string;
      /** Gate 1 trips (fold attempted) when true; otherwise the tick GCs. */
      fold: boolean;
      fault: (op: "get" | "put", key: string, opts?: StoragePutOptions) => BaerlyError | null;
      /** current.json PUTs the tick issues: a lost fold CAS, then the refresh. */
      headPuts: number;
    }> = [
      {
        name: "a single-phase fold whose CAS is lost",
        fold: true,
        fault: (op, key, opts) =>
          op === "put" && key === KEY && opts?.ifMatch !== undefined
            ? new BaerlyError("WriteConflict", "simulated fold CAS loss")
            : null,
        headPuts: 2,
      },
      {
        name: "a fold that throws on the snapshot PUT",
        fold: true,
        fault: (op, key) =>
          op === "put" && key !== KEY && !key.includes("/log/")
            ? new BaerlyError("NetworkError", "simulated 503 on the snapshot PUT")
            : null,
        headPuts: 1,
      },
      {
        name: "a GC slice that throws reading gc/pending.json",
        fold: false,
        fault: (op, key) =>
          op === "get" && key.includes("/gc/")
            ? new BaerlyError("NetworkError", "simulated 503 on gc/pending.json")
            : null,
        headPuts: 1,
      },
    ];

    test.each(cases)("$name", async ({ fold, fault, headPuts }) => {
      // The fixture relies on these: a soft GC tick that the fold may
      // preempt, not a hard-GC tick that skips the fold.
      const { gcInterval } = MAINTENANCE_PROFILE_CF_FREE;
      expect(crossesGcBoundary(prevSeq, tail, gcInterval)).toBe(true);
      expect(crossesGcBoundary(prevSeq, tail, gcInterval * GC_STARVATION_GUARD)).toBe(false);
      const inner = new MemoryStorage();
      await bootstrap(inner, KEY); // tail_hint = 0 ⇒ the lag is the whole tail
      await seedLogEntries(inner, COLLECTION_PREFIX, 0, tail);
      await patchCurrent(inner, KEY, {
        mean_entry_bytes: RATIO_TRIPPING_MEAN,
        snapshot_bytes: fold ? 0 : 10_000_000, // ratio >= 1 only on the fold cases
        snapshot_rows: 0,
      });
      const f = faulty(inner, fault);
      // The throwing cases are unexpected errors, which the runner logs.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runBoundedMaintenance(
          { storage: f.storage, currentJsonKey: KEY, prevSeq, observedTail: tail },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        );
      } finally {
        errorSpy.mockRestore();
      }
      expect(f.faulted()).toBe(true);
      await expect(readSeqStart(inner, KEY)).resolves.toBe(0); // nothing folded
      // One publication per tick: the refresh is the tick's only landed PUT.
      expect(f.headPuts()).toBe(headPuts);
      await expect(readTailHint(inner, KEY)).resolves.toBe(tail);

      // The next commit's tail search starts at the refreshed hint: one
      // log GET (a 404 at `tail`), not a gallop over the whole lag.
      const logGets: string[] = [];
      const counting: Storage = {
        async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
          if (key.includes("/log/")) {
            logGets.push(key);
          }
          return inner.get(key, opts);
        },
        put: inner.put.bind(inner),
        delete: inner.delete.bind(inner),
        list: inner.list.bind(inner),
      };
      const noTick = createObservabilityContext({ maintenance: { dispatch: () => {} } });
      const writer = new Writer({ storage: counting, currentJsonKey: KEY });
      await runWithContext(noTick, () =>
        writer.commit({ op: "I", collection: COLL, docId: "next", body: { _id: "next" } }),
      );
      expect(logGets).toHaveLength(1);
    });
  });

  test('phasesPerTick "both" runs a fold AND a gc in one call', async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    await runBoundedMaintenance(
      {
        storage: inner,
        currentJsonKey: KEY,
        prevSeq: 0, // crosses gc boundary AND gate1 trips
      },
      { phasesPerTick: "both", profile: MAINTENANCE_PROFILE_CF_FREE },
    );
    const after = await readSeqStart(inner, KEY);
    // Folded.
    expect(after).toBeGreaterThan(before);
    // GC also ran ⇒ pending.json exists.
    const pending = await inner.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
  });

  test('phasesPerTick "both": a successful fold publishes the hint, so GC does NOT re-CAS it', async () => {
    // The compactor's Step-7 fold CAS stamps `tail_hint = max(stored,
    // discoveredTail)` and `discoveredTail >= knownTail === the runner's
    // nextSeq`, so the hint is already published when GC returns. The outer
    // refresh evaluates its rate limit against the STALE pre-fold manifest,
    // which on a >= REFRESH_INTERVAL gap still reads as "due" — and would
    // spend a second GET+PUT writing back byte-identical bytes.
    const inner = new MemoryStorage();
    const observedTail = MAINTENANCE_TAIL_HINT_REFRESH_WRITES + 2;
    await bootstrap(inner, KEY); // tail_hint = 0 ⇒ the gap is `observedTail`
    await seedLogEntries(inner, COLLECTION_PREFIX, 0, observedTail);
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN, // ratio >= 1 ⇒ gate1 trips
      snapshot_bytes: 0,
      snapshot_rows: 0, // under C and E ⇒ fold-viable
    });
    const c = countingStorage(inner);

    await runBoundedMaintenance(
      {
        storage: c.storage,
        currentJsonKey: KEY,
        prevSeq: 0, // crosses the GC cadence boundary
        observedTail,
      },
      { phasesPerTick: "both", profile: MAINTENANCE_PROFILE_CF_FREE },
    );

    // Exactly one current.json write this tick: the fold's publication.
    expect(c.putKeys().filter((key) => key === KEY)).toEqual([KEY]);
    // The fold both advanced the floor and published the discovered hint.
    await expect(readSeqStart(inner, KEY)).resolves.toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    await expect(readTailHint(inner, KEY)).resolves.toBe(observedTail);
  });

  test("hard-GC starvation guard fires on single: runs GC, skips fold on the hard boundary", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await compact({ storage: inner, currentJsonKey: KEY }); // leave stale-log candidates
    // Keep gate1 tripping every tick (tail huge).
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    // prevSeq=0 → nextSeq crosses the HARD boundary (interval * GUARD).
    // Pick a nextSeq that crosses the hard boundary: any nextSeq >=
    // interval*GUARD with prevSeq 0 does. The seeded tail_hint is 60,
    // and interval*GUARD = 16, so prevSeq 0 → 60 crosses it.
    await runBoundedMaintenance(
      {
        storage: inner,
        currentJsonKey: KEY,
        prevSeq: 0,
      },
      { profile: MAINTENANCE_PROFILE_CF_FREE },
    );
    const after = await readSeqStart(inner, KEY);
    // Hard-GC guard fired: fold was SKIPPED this tick (no advance) ...
    expect(after).toBe(before);
    // ... and GC ran (pending.json exists).
    const pending = await inner.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
    // sanity: GC_STARVATION_GUARD is the multiplier we relied on.
    expect(GC_STARVATION_GUARD).toBeGreaterThan(1);
  });

  test("an unexpected throw bumps unexpected_error_total and is swallowed", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, {
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // Storage whose first GET (readCurrentJson inside the runner) throws
    // a non-WriteConflict error.
    const boom: Storage = {
      get(): Promise<StorageGetResult | null> {
        return Promise.reject(new Error("disk on fire"));
      },
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    };
    let rejected = false;
    // The runner surfaces an unexpected error's stack via `console.error`
    // (maintenance.ts — the one intentional operator sink) since the
    // caller swallows the throw. This test injects that error on purpose,
    // so capture the dump instead of letting ~6 lines of expected-error
    // noise print, and assert it fired — turning the noise into a signal.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const recorder = await withRecorder(async () => {
        await runBoundedMaintenance({
          storage: boom,
          currentJsonKey: KEY,
          prevSeq: 0,
        }).catch(() => {
          rejected = true;
        });
      });
      expect(rejected).toBe(false); // swallowed, did NOT reject
      expect(errorSpy).toHaveBeenCalled(); // operator-facing stack was surfaced
      expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("retireLogs error policy (via the runners)", () => {
  /**
   * A fully-folded idle collection: `log_seq_start` at the tail (50), no
   * snapshot, and log objects [0, 50) seeded directly (not via Writer).
   * `compact()` finds `available = 0` (no fold, so no current.json CAS)
   * and `runGc()` has no orphan snapshots or candidates, so with
   * `{ logRetention: { window: 5 } }` the retirement gate is `{0, 20}` and
   * retirement's floor CAS is the ONLY conditional current.json PUT the
   * runners issue in this state. That lets the wrappers below target
   * `retireLogs`'s two catch arms by key + precondition instead of by
   * op counting.
   */
  const seedIdleFolded = async (storage: Storage): Promise<void> => {
    await createCurrentJson(
      storage,
      KEY,
      logStateCurrentJson({ log_seq_start: 50, tail_hint: 50 }),
    );
    await seedLogEntries(storage, COLLECTION_PREFIX, 0, 50);
  };

  /**
   * Throws `WriteConflict` on any conditional (`ifMatch`) current.json PUT —
   * retirement's floor CAS in this state. GC's `gc/pending.json`
   * bootstrap PUTs with `ifNoneMatch` and passes through untouched.
   */
  const conflictOnCurrentJsonCas = (inner: Storage): Storage => ({
    get: inner.get.bind(inner),
    delete: inner.delete.bind(inner),
    list: inner.list.bind(inner),
    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      if (key === KEY && opts?.ifMatch !== undefined) {
        throw new BaerlyError("WriteConflict", "simulated retirement floor CAS loss");
      }
      return inner.put(key, body, opts);
    },
  });

  /**
   * Throws `NetworkError` on every DELETE of a log object
   * (`…/log/<seq>.json`) — the retirement DELETE loop. Gated on the log
   * prefix so a future GC delete can never misfire into this injection.
   */
  const networkErrorOnLogDelete = (inner: Storage): Storage => ({
    get: inner.get.bind(inner),
    put: inner.put.bind(inner),
    list: inner.list.bind(inner),
    async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      if (key.startsWith(`${COLLECTION_PREFIX}/log/`)) {
        throw new BaerlyError("NetworkError", "simulated log DELETE failure");
      }
      return inner.delete(key, opts);
    },
  });

  test("WriteConflict from the floor CAS is swallowed — runScheduledMaintenance resolves, floor unpublished", async () => {
    const inner = new MemoryStorage();
    await seedIdleFolded(inner);
    // `WriteConflict` is routine CAS contention (the next pass retries), per
    // the helper's documented error policy — must NOT reject.
    await runScheduledMaintenance(
      { storage: conflictOnCurrentJsonCas(inner), currentJsonKey: KEY },
      { logRetention: { window: 5 } } as InternalMaintenanceOptions,
    );
    // Non-vacuity: the swallowed WriteConflict came from retirement's own
    // floor CAS, so the floor was never published. (A wrapper hit on an
    // earlier compact/GC current.json CAS would have REJECTED the call —
    // runScheduledMaintenance propagates those — so resolving here plus
    // floor === 0 pins that retirement, and only retirement, ran.)
    const after = await readCurrentJson(inner, KEY);
    expect(logDeleteFloorOf(after!.json)).toBe(0);
  });

  test("a non-WriteConflict DELETE failure re-throws out of runScheduledMaintenance — after the floor CAS landed", async () => {
    const inner = new MemoryStorage();
    await seedIdleFolded(inner);
    await expect(
      runScheduledMaintenance({ storage: networkErrorOnLogDelete(inner), currentJsonKey: KEY }, {
        logRetention: { window: 5 },
      } as InternalMaintenanceOptions),
    ).rejects.toMatchObject({ code: "NetworkError" });
    // CAS-before-delete ordering: the floor was published (= 20, the
    // `{0, 20}` gate end) before the DELETE loop rejected. The slice
    // below it stays leaked on disk — leak, never corruption.
    const after = await readCurrentJson(inner, KEY);
    expect(logDeleteFloorOf(after!.json)).toBe(20);
  });

  test("the same failure through runBoundedMaintenance never rejects — unexpected_error_total + stack log", async () => {
    const inner = new MemoryStorage();
    await seedIdleFolded(inner);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const recorder = await withRecorder(async () => {
        // prevSeq == tail ⇒ no GC cadence boundary, and the empty live
        // tail keeps gate1 cold, so retirement is the only phase with
        // work this tick.
        await runBoundedMaintenance(
          { storage: networkErrorOnLogDelete(inner), currentJsonKey: KEY, prevSeq: 50 },
          { logRetention: { window: 5 } },
        );
      });
      // Runner contract: never throws on the write-tick path — the
      // outer catch counts it, logs the stack, and swallows.
      expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBeGreaterThan(0);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("WriteConflict through runBoundedMaintenance stays expected — no unexpected_error_total bump", async () => {
    const inner = new MemoryStorage();
    await seedIdleFolded(inner);
    const recorder = await withRecorder(async () => {
      await runBoundedMaintenance(
        { storage: conflictOnCurrentJsonCas(inner), currentJsonKey: KEY, prevSeq: 50 },
        { logRetention: { window: 5 } },
      );
    });
    // The helper swallows WriteConflict itself — it must never reach the
    // outer catch, which is reserved for unexpected errors.
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
  });
});

describe("parseMaintenanceEnv", () => {
  // Build a reader over a fixed map so a key that's absent returns undefined.
  const reader =
    (env: Record<string, string>) =>
    (k: string): string | undefined =>
      env[k];

  test("unset env yields no maxFoldBytes and disabled=false", () => {
    expect(parseMaintenanceEnv(reader({}))).toEqual({ disabled: false });
  });

  test("empty-string BAERLY_MAINTENANCE_MAX_FOLD_BYTES is ignored (no maxFoldBytes)", () => {
    expect(parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_MAX_FOLD_BYTES: "" }))).toEqual({
      disabled: false,
    });
  });

  test("MAX_SAFE_INTEGER is the largest accepted BAERLY_MAINTENANCE_MAX_FOLD_BYTES", () => {
    expect(
      parseMaintenanceEnv(
        reader({ BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(Number.MAX_SAFE_INTEGER) }),
      ).maxFoldBytes,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("valid numeric BAERLY_MAINTENANCE_MAX_FOLD_BYTES parses to maxFoldBytes", () => {
    expect(parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_MAX_FOLD_BYTES: "1048576" }))).toEqual({
      maxFoldBytes: 1_048_576,
      disabled: false,
    });
  });

  test("non-numeric BAERLY_MAINTENANCE_MAX_FOLD_BYTES throws InvalidConfig naming the variable and value", () => {
    for (const v of [
      "8mb",
      "1O24",
      "lots",
      "Infinity",
      "1e400",
      // Strict: a plain positive decimal integer only, no trimming.
      " 1024 ",
      "1024\n",
      "0x400",
      "1e6",
      "1.5",
      "1e300",
      "+1024",
      "01024",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      let caughtError: unknown;
      try {
        parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_MAX_FOLD_BYTES: v }));
      } catch (error) {
        caughtError = error;
      }
      expect((caughtError as BaerlyError).code).toBe("InvalidConfig");
      expect((caughtError as BaerlyError).message).toContain("BAERLY_MAINTENANCE_MAX_FOLD_BYTES");
      expect((caughtError as BaerlyError).message).toContain(JSON.stringify(v));
    }
  });

  test("non-positive BAERLY_MAINTENANCE_MAX_FOLD_BYTES throws InvalidConfig", () => {
    for (const v of ["0", "-1", "-1048576"]) {
      let caughtError: unknown;
      try {
        parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_MAX_FOLD_BYTES: v }));
      } catch (error) {
        caughtError = error;
      }
      expect((caughtError as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("BAERLY_MAINTENANCE_DISABLE closed vocabulary matches the documented rules", () => {
    // Falsy: unset / "" / "0" / "false" / "FALSE" (case-insensitive).
    expect(parseMaintenanceEnv(reader({})).disabled).toBe(false);
    for (const v of ["", "0", "false", "FALSE"]) {
      expect(parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_DISABLE: v })).disabled).toBe(false);
    }
    // Truthy: "1" / "true" / "TRUE" (case-insensitive) — and ONLY these.
    for (const v of ["1", "true", "TRUE"]) {
      expect(parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_DISABLE: v })).disabled).toBe(true);
    }
  });

  test("BAERLY_MAINTENANCE_DISABLE outside the closed vocabulary throws InvalidConfig", () => {
    // "yes"/"on" used to be silently truthy; "no"/"off" used to be silently
    // truthy too (the original bug this vocabulary closes). All now throw.
    for (const v of ["yes", "on", "no", "off", "2", "disable", " true", "1 "]) {
      let caughtError: unknown;
      try {
        parseMaintenanceEnv(reader({ BAERLY_MAINTENANCE_DISABLE: v }));
      } catch (error) {
        caughtError = error;
      }
      expect((caughtError as BaerlyError).code).toBe("InvalidConfig");
    }
  });
});

describe("dispatchInlineAwaited", () => {
  test("runs the task and returns its promise so the caller can await", async () => {
    let ran = false;
    const out = dispatchInlineAwaited(async () => {
      ran = true;
    });
    await out;
    expect(ran).toBe(true);
  });
});

/**
 * The fold wall: once `snapshot_bytes > C` or stored `snapshot_rows > E`,
 * `compact()` never lands again, so
 * `log_seq_start` freezes and log retention (which only deletes below
 * `log_seq_start - window`) freezes with it. Writes keep succeeding, so the
 * stall must be LOUD: one structured record through the adapter's
 * `MaintenanceDispatch.warn` sink (the only signal that reaches a Cloudflare
 * `waitUntil` tick), dimension-named counters (the canonical line flattens
 * labels), and the same path at both gates.
 */
describe("runBoundedMaintenance — fold-wall deferral signal", () => {
  interface WarnRecord {
    readonly event: string;
    readonly properties: Readonly<Record<string, unknown>>;
  }
  let records: WarnRecord[] = [];
  const deferRecords = (): WarnRecord[] => records.filter((r) => r.event === "fold_deferred");

  /** Run `fn` under a context carrying a spy recorder and a `warn` sink, as an adapter would. */
  const withSignalSinks = async (
    fn: () => Promise<void>,
  ): Promise<RequestScopedMetricsRecorder> => {
    records = [];
    const recorder = new RequestScopedMetricsRecorder();
    const ctx = createObservabilityContext({
      recorder,
      maintenance: { warn: (event, properties) => records.push({ event, properties }) },
    });
    await runWithContext(ctx, fn);
    return recorder;
  };

  /** Labels of every `db.compaction.deferred_total` observation, in order. */
  const deferredCounterLabels = (
    recorder: RequestScopedMetricsRecorder,
  ): Readonly<Record<string, string>>[] =>
    recorder
      .snapshot()
      .counters.filter((row) => row.name === "db.compaction.deferred_total")
      .map((row) => row.labels);

  const C_FREE = MAINTENANCE_PROFILE_CF_FREE.maxFoldBytes;
  const E_FREE = MAINTENANCE_PROFILE_CF_FREE.maxFoldRows;
  const WARN_SEQ = MAINTENANCE_WARN_INTERVAL_WRITES + 5;

  /** Pre-fold fixture: stored snapshot already past the wall on one arm. */
  const seedPreFoldWall = async (
    inner: MemoryStorage,
    over: Pick<CurrentJson, "snapshot_bytes" | "snapshot_rows">,
  ): Promise<void> => {
    await seedLog(inner, KEY, COLL, 60);
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      ...over,
      mean_entry_bytes: RATIO_TRIPPING_MEAN,
      tail_hint: WARN_SEQ,
      log_seq_start: 0,
    }));
  };

  test("a rows-arm pre-fold defer emits the structured record, names C and E, and does not recommend the bytes override", async () => {
    const inner = new MemoryStorage();
    await seedPreFoldWall(inner, { snapshot_bytes: 0, snapshot_rows: 1_000_000 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withSignalSinks(() =>
        runBoundedMaintenance(
          { storage: inner, currentJsonKey: KEY, prevSeq: WARN_SEQ },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        ),
      );
      const recs = deferRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]!.properties).toMatchObject({
        collection: COLL,
        dimension: "rows",
        gate: "pre-fold",
        snapshot_bytes: 0,
        snapshot_rows: 1_000_000,
        ceiling_bytes: C_FREE,
        ceiling_rows: E_FREE,
        live_log_tail: WARN_SEQ,
        log_seq_start: 0,
      });
      // With a sink, the human text rides the record and console.warn stays
      // silent — one line per deferral, not two.
      expect(warnSpy).not.toHaveBeenCalled();
      const msg = String(recs[0]!.properties["detail"] ?? "");
      expect(msg).toContain(String(C_FREE));
      expect(msg).toContain(String(E_FREE));
      expect(msg).toMatch(/log retention/i);
      expect(msg).not.toMatch(/raise `?BAERLY_MAINTENANCE_MAX_FOLD_BYTES/i);
      expect(msg).toContain("BAERLY_MAINTENANCE_PROFILE=cf-paid");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a bytes-arm pre-fold defer emits the structured record and a dimension-named counter the canonical line keeps", async () => {
    const inner = new MemoryStorage();
    await seedPreFoldWall(inner, { snapshot_bytes: C_FREE + 1, snapshot_rows: 0 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorder = await withSignalSinks(async () => {
        await runBoundedMaintenance(
          { storage: inner, currentJsonKey: KEY, prevSeq: WARN_SEQ },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        );
      });
      const recs = deferRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]!.properties).toMatchObject({
        dimension: "bytes",
        gate: "pre-fold",
        snapshot_bytes: C_FREE + 1,
      });
      expect(warnSpy).not.toHaveBeenCalled();
      const msg = String(recs[0]!.properties["detail"] ?? "");
      expect(msg).toMatch(/raise `?BAERLY_MAINTENANCE_MAX_FOLD_BYTES/i);
      const summary = recorder.summarize();
      expect(summary["db.compaction.deferred_total"]).toBe(1);
      expect(summary["db.compaction.deferred_bytes_total"]).toBe(1);
      expect(summary["db.compaction.deferred_rows_total"]).toBeUndefined();
      // The canonical line drops labels; the long-term recorder keys on them.
      expect(deferredCounterLabels(recorder)).toEqual([
        { collection: COLL, dimension: "bytes", gate: "pre-fold" },
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * Rebuild-gate fixture: the stored `snapshot_bytes` (0) is under `C`, so
   * the pre-fold gate is OPEN and compact() runs; the rebuilt 20-doc
   * snapshot is over the tiny `C`, so compact()'s own ceiling check
   * defers. This is how bytes first cross `C` in practice — the stored
   * figure never catches up, so the pre-fold gate never closes.
   */
  const TINY_C = 50;
  const seedRebuildWall = async (inner: MemoryStorage): Promise<void> => {
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({ mean_entry_bytes: RATIO_TRIPPING_MEAN }),
    );
    await seedLogEntries(inner, COLLECTION_PREFIX, 0, WARN_SEQ, (seq) => ({
      after: { _id: `d${seq}`, n: seq },
    }));
  };
  // 1003 → 1005 crosses a soft GC boundary (interval 4) but not the hard
  // one (16), so the tick reaches the fold rather than the starvation guard.
  const rebuildArgs = (storage: Storage) => ({
    storage,
    currentJsonKey: KEY,
    prevSeq: WARN_SEQ - 2,
    observedTail: WARN_SEQ,
    maxFoldBytes: TINY_C,
  });

  test("a rebuild-gate defer signals once, stamps the warn and tail_hint in one CAS, and ends a single-phase tick", async () => {
    const inner = new MemoryStorage();
    await seedRebuildWall(inner);
    const counted = countingStorage(inner);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let recorder: RequestScopedMetricsRecorder;
    try {
      recorder = await withSignalSinks(async () => {
        await runBoundedMaintenance(rebuildArgs(counted.storage), {
          profile: MAINTENANCE_PROFILE_CF_FREE,
        });
      });
      const recs = deferRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]!.properties).toMatchObject({
        collection: COLL,
        dimension: "bytes",
        gate: "rebuild",
        ceiling_bytes: TINY_C,
        ceiling_rows: E_FREE,
        snapshot_rows: WRITE_TICK_FOLD_ENTRIES_PER_PASS,
        live_log_tail: WARN_SEQ,
        log_seq_start: 0,
      });
      expect(recs[0]!.properties["snapshot_bytes"]).toBeGreaterThan(TINY_C);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
    // One deferral counts once, not once per gate layer.
    const summary = recorder.summarize();
    expect(summary["db.compaction.deferred_total"]).toBe(1);
    expect(summary["db.compaction.deferred_bytes_total"]).toBe(1);
    expect(deferredCounterLabels(recorder)).toEqual([
      { collection: COLL, dimension: "bytes", gate: "rebuild" },
    ]);
    // Nothing folded; one PUT published both the warn stamp and the hint.
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBe(WARN_SEQ);
    await expect(readTailHint(inner, KEY)).resolves.toBe(WARN_SEQ);
    expect(counted.report()["put"]).toBe(1);
    // The compact() walk was this tick's one phase: no GC on "single".
    await expect(inner.get(`${COLLECTION_PREFIX}/gc/pending.json`)).resolves.toBeNull();
  });

  test("a rebuild-gate defer on a two-phase tick falls through to GC", async () => {
    const inner = new MemoryStorage();
    await seedRebuildWall(inner);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withSignalSinks(() =>
        runBoundedMaintenance(rebuildArgs(inner), {
          profile: MAINTENANCE_PROFILE_CF_FREE,
          phasesPerTick: "both",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(deferRecords()).toHaveLength(1);
    await expect(readTailHint(inner, KEY)).resolves.toBe(WARN_SEQ);
    await expect(inner.get(`${COLLECTION_PREFIX}/gc/pending.json`)).resolves.not.toBeNull();
  });

  test("a throwing warn sink still stamps the warn and tail_hint, and falls back to console.warn", async () => {
    const inner = new MemoryStorage();
    await seedPreFoldWall(inner, { snapshot_bytes: C_FREE + 1, snapshot_rows: 0 });
    // Leave the stored hint behind the tick's tail, so the refresh must write.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({ ...cur, tail_hint: 0 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recorder = new RequestScopedMetricsRecorder();
    try {
      const ctx = createObservabilityContext({
        recorder,
        maintenance: {
          warn: () => {
            throw new Error("sink exploded");
          },
        },
      });
      await runWithContext(ctx, () =>
        runBoundedMaintenance(
          { storage: inner, currentJsonKey: KEY, prevSeq: WARN_SEQ - 1, observedTail: WARN_SEQ },
          { profile: MAINTENANCE_PROFILE_CF_FREE },
        ),
      );
      // The deferral is still visible to a human.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain("has stopped compacting");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
    // The sink's throw did not escape into the runner's unexpected-error path.
    expect(recorder.summarize()["db.maintenance.unexpected_error_total"]).toBeUndefined();
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBe(WARN_SEQ);
    await expect(readTailHint(inner, KEY)).resolves.toBe(WARN_SEQ);
  });

  test("a fold that lands emits no deferral record", async () => {
    const inner = new MemoryStorage();
    await seedPreFoldWall(inner, { snapshot_bytes: 0, snapshot_rows: 0 });
    await withSignalSinks(() =>
      runBoundedMaintenance(
        { storage: inner, currentJsonKey: KEY, prevSeq: WARN_SEQ },
        { profile: MAINTENANCE_PROFILE_CF_FREE },
      ),
    );
    expect(deferRecords()).toHaveLength(0);
  });
});

describe("runBoundedMaintenance — sized from the request ledger's remainder", () => {
  const SNAPSHOT_PREFIX = `${COLLECTION_PREFIX}/snapshot/`;

  /**
   * Run one tick inside a context whose ledger has exactly `left` requests
   * left on `ledgerPool` (the other pool stays roomy), over `inner` behind
   * a ledger-charging adapter on `storagePool`.
   */
  const tickWithBudget = async (
    inner: Storage,
    left: number,
    args: Omit<Parameters<typeof runBoundedMaintenance>[0], "storage" | "currentJsonKey">,
    options?: InternalBoundedMaintenanceOptions,
    pools: { ledgerPool: RequestPool; storagePool: RequestPool } = {
      ledgerPool: "external",
      storagePool: "external",
    },
  ): Promise<{ recorder: RequestScopedMetricsRecorder; charged: number }> => {
    const limit = 1000;
    const ledger = new RequestLedger({ internal: limit, external: limit });
    for (let i = 0; i < limit - left; i++) {
      ledger.acquire(pools.ledgerPool);
    }
    const before = ledger.charged.internal;
    const recorder = new RequestScopedMetricsRecorder();
    await runWithContext(createObservabilityContext({ recorder, ledger }), () =>
      runBoundedMaintenance(
        { storage: ledgeredStorage(inner, pools.storagePool), currentJsonKey: KEY, ...args },
        options,
      ),
    );
    return { recorder, charged: ledger.charged.internal - before };
  };

  const skipped = (recorder: RequestScopedMetricsRecorder, phase: string): number =>
    recorder
      .snapshot()
      .counters.filter(
        (c) =>
          c.name === "db.maintenance.request_budget_skipped_total" && c.labels?.["phase"] === phase,
      )
      .reduce((acc, c) => acc + c.value, 0);

  const expectNoErrors = (recorder: RequestScopedMetricsRecorder): void => {
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
    expect(counterTotal(recorder, "db.maintenance.request_budget_refused_total")).toBe(0);
  };

  const snapshotCount = async (storage: Storage): Promise<number> => {
    let n = 0;
    for await (const _ of storage.list(SNAPSHOT_PREFIX)) {
      n += 1;
    }
    return n;
  };

  /** `rounds` × (3 inserts, then a fold): `rounds - 1` replaced snapshots, tail fully folded. */
  const seedFoldedRounds = async (storage: Storage, rounds: number): Promise<number> => {
    await bootstrap(storage as MemoryStorage, KEY);
    const writer = new Writer({ storage, currentJsonKey: KEY });
    let seq = 0;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < 3; i++, seq++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `d${seq}`,
          body: { _id: `d${seq}`, n: seq },
        });
      }
      await compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
    }
    return seq;
  };

  // A 20-entry tail that `foldAtTailEntries` folds with the ratio cold. The
  // tick's runner GET plus the fold (5 + 20) needs 26; prevSeq ==
  // observedTail crosses no GC boundary.
  const FOLD_TAIL = 20;
  const foldTick = { prevSeq: FOLD_TAIL, observedTail: FOLD_TAIL };
  const foldOptions = { foldAtTailEntries: FOLD_TAIL } as InternalBoundedMaintenanceOptions;

  test("a fold that does not fit what is left is skipped, never started", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const { recorder } = await tickWithBudget(inner, 25, foldTick, foldOptions);
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);
    expect(skipped(recorder, "fold")).toBe(1);
    expectNoErrors(recorder);
    // Nothing half-written: no snapshot PUT was issued.
    await expect(snapshotCount(inner)).resolves.toBe(0);
  });

  test("a fold that exactly fits what is left lands", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const { recorder, charged } = await tickWithBudget(inner, 26, foldTick, foldOptions);
    await expect(readSeqStart(inner, KEY)).resolves.toBe(FOLD_TAIL);
    // 25: a first fold has no prior snapshot to GET.
    expect(charged).toBe(25);
    expect(skipped(recorder, "fold")).toBe(0);
    expectNoErrors(recorder);
  });

  test("the fold is sized from the pool the storage charges", async () => {
    // External down to 5 by Cache API calls (4 after the tick's manifest
    // read, short of the fold's 25); internal roomy.
    const foldOn = async (
      storagePool: RequestPool,
    ): Promise<{ seqStart: number; recorder: RequestScopedMetricsRecorder }> => {
      const inner = new MemoryStorage();
      await seedLog(inner, KEY, COLL, FOLD_TAIL);
      const ledger = new RequestLedger({ internal: 1000, external: 10 });
      for (let i = 0; i < 5; i++) {
        ledger.chargeCacheCall(true);
      }
      const recorder = new RequestScopedMetricsRecorder();
      await runWithContext(createObservabilityContext({ recorder, ledger }), () =>
        runBoundedMaintenance(
          { storage: ledgeredStorage(inner, storagePool), currentJsonKey: KEY, ...foldTick },
          foldOptions,
        ),
      );
      return { seqStart: await readSeqStart(inner, KEY), recorder };
    };
    // The R2 binding charges only `internal`, which has room.
    const binding = await foldOn("internal");
    expect(binding.seqStart).toBe(FOLD_TAIL);
    expect(skipped(binding.recorder, "fold")).toBe(0);
    expectNoErrors(binding.recorder);
    // Storage through `fetch` charges `external` as well, which is short.
    const viaFetch = await foldOn("external");
    expect(viaFetch.seqStart).toBe(0);
    expect(skipped(viaFetch.recorder, "fold")).toBe(1);
    expectNoErrors(viaFetch.recorder);
  });

  test("a fold is sized net of a later row's commit hold, never into it", async () => {
    // The tick needs 26 (its manifest read, then the fold). 45 is left in
    // all, but only 25 net of the 20 held.
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const ledger = new RequestLedger({ internal: 1000, external: 1000 });
    const held = 20;
    while (ledger.remaining("external") > 25 + held) {
      ledger.acquire("external");
    }
    const hold = ledger.hold(held);
    const recorder = new RequestScopedMetricsRecorder();
    await runWithContext(createObservabilityContext({ recorder, ledger }), () =>
      runBoundedMaintenance(
        { storage: ledgeredStorage(inner, "external"), currentJsonKey: KEY, ...foldTick },
        foldOptions,
      ),
    );
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);
    expect(skipped(recorder, "fold")).toBe(1);
    expectNoErrors(recorder);
    // The holder can still spend every held request.
    expect(ledger.held).toBe(held);
    for (let i = 0; i < held; i++) {
      ledger.acquire("external", hold);
    }
    hold.release();
  });

  test("a GC slice that fits only in part sweeps fewer snapshots", async () => {
    const inner = new MemoryStorage();
    const tail = await seedFoldedRounds(inner, 4);
    await expect(snapshotCount(inner)).resolves.toBe(4);
    // Mark the 3 replaced snapshots now; they come due after the grace.
    await runGc({ storage: inner, currentJsonKey: KEY });
    const later = (): Date => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    // prevSeq tail-1 → tail crosses a soft GC boundary (12 % 4 === 0), not
    // the hard one; the tail is folded, so Gate 1 stays shut.
    expect(tail % WRITE_TICK_GC_INTERVAL).toBe(0);
    // Runner GET 1 + GC base 6 + 1 sweep.
    const { recorder } = await tickWithBudget(
      inner,
      8,
      { prevSeq: tail - 1, observedTail: tail },
      { profile: MAINTENANCE_PROFILE_CF_FREE, now: later },
    );
    await expect(snapshotCount(inner)).resolves.toBe(3);
    expectNoErrors(recorder);
    // Nothing was left for retirement.
    expect(skipped(recorder, "retire")).toBe(1);
  });

  test("a GC slice with less than its base cost left is skipped", async () => {
    const inner = new MemoryStorage();
    const tail = await seedFoldedRounds(inner, 4);
    const pendingKey = `${COLLECTION_PREFIX}/gc/pending.json`;
    const pendingEtag = async (): Promise<string | undefined> => {
      const got = await inner.get(pendingKey);
      return got?.etag;
    };
    const pendingBefore = await pendingEtag();
    const { recorder, charged } = await tickWithBudget(
      inner,
      6,
      { prevSeq: tail - 1, observedTail: tail },
      { profile: MAINTENANCE_PROFILE_CF_FREE },
    );
    expect(skipped(recorder, "gc")).toBe(1);
    // The runner GET only: retirement, sized for every attempt, is skipped too.
    expect(charged).toBe(1);
    expect(skipped(recorder, "retire")).toBe(1);
    await expect(pendingEtag()).resolves.toBe(pendingBefore);
    await expect(snapshotCount(inner)).resolves.toBe(4);
    expectNoErrors(recorder);
  });

  test("a retirement pass that fits only in part retires a shorter range", async () => {
    const inner = new MemoryStorage();
    const tail = await seedFoldedRounds(inner, 4);
    // Runner GET 1 + retirement's pre-floor worst case 7 + 2 DELETEs at 3
    // attempts each; no fold, no GC due.
    const { recorder } = await tickWithBudget(
      inner,
      14,
      { prevSeq: tail, observedTail: tail },
      { logRetention: { window: 0 } },
    );
    const read = await readCurrentJson(inner, KEY);
    expect(read === null ? -1 : logDeleteFloorOf(read.json)).toBe(2);
    expectNoErrors(recorder);
  });

  /** `inner`, except the first `times` `op` calls whose key matches each fail once with a retriable 503. */
  const failOnce = (
    inner: Storage,
    op: "get" | "delete",
    match: (key: string) => boolean,
    times = 1,
  ): Storage => {
    let failures = 0;
    const trip = (key: string): void => {
      if (failures < times && match(key)) {
        failures += 1;
        throw new BaerlyError("NetworkError", `injected 503 on ${op} ${key}`, {
          cause: { status: 503 },
        });
      }
    };
    return {
      get: async (key, opts) => {
        if (op === "get") {
          trip(key);
        }
        return inner.get(key, opts);
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: async (key, opts) => {
        if (op === "delete") {
          trip(key);
        }
        return inner.delete(key, opts);
      },
      list: (prefix, opts) => inner.list(prefix, opts),
    };
  };

  const LOG_PREFIX = `${COLLECTION_PREFIX}/log/`;

  test("a retried DELETE under a tight ledger leaks no log object below the floor", async () => {
    const inner = new MemoryStorage();
    const tail = await seedFoldedRounds(inner, 4);
    // 10 left after the runner GET. Sized as remainder - 3, the pass would
    // move the floor to 7 and then lose its last DELETE to the retry.
    const { recorder } = await tickWithBudget(
      failOnce(inner, "delete", (key) => key.startsWith(LOG_PREFIX)),
      11,
      { prevSeq: tail, observedTail: tail },
      { logRetention: { window: 0 } },
    );
    const read = await readCurrentJson(inner, KEY);
    const floor = read === null ? -1 : logDeleteFloorOf(read.json);
    expect(floor).toBe(1);
    for (let seq = 0; seq < floor; seq++) {
      await expect(inner.get(logObjectKey(COLLECTION_PREFIX, seq))).resolves.toBeNull();
    }
    expectNoErrors(recorder);
  });

  test("a fold refused part-way publishes nothing, and the next tick folds", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    // The fold fits its estimate (26) and issues 25 (no prior snapshot);
    // two retried log GETs push its closing CAS past the ledger, which
    // refuses it before it is sent.
    const first = await tickWithBudget(
      failOnce(inner, "get", (key) => key.startsWith(LOG_PREFIX), 2),
      26,
      foldTick,
      foldOptions,
    );
    expect(counterTotal(first.recorder, "db.maintenance.request_budget_refused_total")).toBe(1);
    expect(counterTotal(first.recorder, "db.maintenance.unexpected_error_total")).toBe(0);
    await expect(readSeqStart(inner, KEY)).resolves.toBe(0);

    const next = await tickWithBudget(inner, 26, foldTick, foldOptions);
    await expect(readSeqStart(inner, KEY)).resolves.toBe(FOLD_TAIL);
    expectNoErrors(next.recorder);
  });

  test("a forced fold that does not fit is skipped like any other fold", async () => {
    // forceFold bypasses Gate 1's ratio and floor, not the request budget:
    // runner GET 1 + fold 5 + 5 entries = 11.
    for (const [left, folded] of [
      [10, 0],
      [11, 5],
    ] as const) {
      const inner = new MemoryStorage();
      await seedLog(inner, KEY, COLL, 5);
      // Ratio cold, snapshot within C: only forceFold trips Gate 1.
      await patchCurrent(inner, KEY, { mean_entry_bytes: 64, snapshot_bytes: 256 * 1024 });
      const { recorder } = await tickWithBudget(inner, left, {
        prevSeq: 5,
        observedTail: 5,
        forceFold: true,
      });
      await expect(readSeqStart(inner, KEY)).resolves.toBe(folded);
      expect(skipped(recorder, "fold")).toBe(folded === 0 ? 1 : 0);
      expectNoErrors(recorder);
    }
  });

  test("a CapacityExceeded the ledger did not raise stays an unexpected error", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const failing: Storage = {
      ...inner,
      get: async () => {
        throw new BaerlyError("CapacityExceeded", "not a ledger refusal");
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const recorder = await withRecorder(() =>
        runBoundedMaintenance({ storage: failing, currentJsonKey: KEY, ...foldTick }, foldOptions),
      );
      expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(1);
      expect(counterTotal(recorder, "db.maintenance.request_budget_refused_total")).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("a call the ledger refuses ends the tick quietly, not as an unexpected error", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { recorder, charged } = await tickWithBudget(inner, 0, foldTick, foldOptions);
      expect(charged).toBe(0);
      expect(counterTotal(recorder, "db.maintenance.request_budget_refused_total")).toBe(1);
      expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test("with no ledger, or one that never refuses, every phase runs at the profile's caps", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, FOLD_TAIL);
    const recorder = new RequestScopedMetricsRecorder();
    await runWithContext(
      createObservabilityContext({ recorder, ledger: new RequestLedger() }),
      () =>
        runBoundedMaintenance(
          { storage: ledgeredStorage(inner, "external"), currentJsonKey: KEY, ...foldTick },
          foldOptions,
        ),
    );
    await expect(readSeqStart(inner, KEY)).resolves.toBe(FOLD_TAIL);
    expect(counterTotal(recorder, "db.maintenance.request_budget_skipped_total")).toBe(0);
  });
});

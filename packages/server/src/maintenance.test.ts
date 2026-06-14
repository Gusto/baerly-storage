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
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  casUpdateCurrentJson,
  type CurrentJson,
  GC_STARVATION_GUARD,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_WARN_INTERVAL_WRITES,
  MAINTENANCE_PROFILE_CF_FREE,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_INTERVAL,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { compact } from "./compactor.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import {
  CLOUDFLARE_FREE_TIER,
  crossesGcBoundary,
  dispatchInlineAwaited,
  type InternalMaintenanceOptions,
  runBoundedMaintenance,
  runScheduledMaintenance,
  shouldFireMaintenance,
} from "./maintenance.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { RequestScopedMetricsRecorder } from "./observability/recorder.ts";
import { Writer } from "./writer.ts";

const KEY = "app/t/tenant/x/manifests/c/current.json";
const COLL = "c";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maintenance-test", claimed_at: "" },
    tail_bytes: 0,
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
    // After compact, [0, 150) become stale-log; GC marks them and the
    // zero-grace lets the same pass sweep them.
    expect(r.gc.marked.stale_log).toBeGreaterThan(0);
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

  test("CLOUDFLARE_FREE_TIER carries the documented bounds", async () => {
    // A regression in these constants means the budget audits and
    // the per-tier docstring lie about the worst-case I/O profile.
    // The budget caps live on the InternalMaintenanceOptions surface
    // (they're not part of the public `MaintenanceOptions` shape).
    const cfFree = CLOUDFLARE_FREE_TIER as InternalMaintenanceOptions;

    expect(cfFree.compact?.maxEntriesPerRun).toBe(20);
    expect(cfFree.compact?.minEntriesToCompact).toBe(50);
    expect(cfFree.gc?.maxMarksPerRun).toBe(20);
    expect(cfFree.gc?.maxSweepsPerRun).toBe(10);
  });
});

// ---------------------------------------------------------------------
// Pure gate helpers
// ---------------------------------------------------------------------

describe("crossesGcBoundary", () => {
  test("floor-based crossing is batch-safe (a jump over a boundary still trips)", () => {
    // A modulo test (`next_seq % interval === 0`) would MISS this jump
    // from 3 to 9 with interval 4 — neither 3 nor 9 is a multiple of 4,
    // yet the [4,8] boundaries were crossed.
    expect(crossesGcBoundary(3, 9, 4)).toBe(true);
    // Same bucket: floor(5/4)===floor(6/4)===1, no crossing.
    expect(crossesGcBoundary(5, 6, 4)).toBe(false);
    // Exact boundary landing.
    expect(crossesGcBoundary(3, 4, 4)).toBe(true);
  });
});

describe("shouldFireMaintenance", () => {
  const base = (over: Partial<CurrentJson>): CurrentJson => ({
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "t", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
    ...over,
  });

  test("fires on a crossed GC boundary even when ratio is cold", () => {
    const cur = base({ next_seq: WRITE_TICK_GC_INTERVAL, tail_bytes: 0 });
    expect(shouldFireMaintenance(cur, 0, WRITE_TICK_GC_INTERVAL)).toBe(true);
  });

  test("fires when tail/snapshot ratio meets the target", () => {
    // snapshot floored to MIN_LIVE_BYTES; tail equal to it ⇒ ratio 1.0.
    const cur = base({ next_seq: 1, tail_bytes: MAINTENANCE_MIN_LIVE_BYTES, snapshot_bytes: 0 });
    expect(shouldFireMaintenance(cur, 1, 999)).toBe(true);
  });

  test("does not fire when neither gate trips", () => {
    const cur = base({ next_seq: 1, tail_bytes: 0, snapshot_bytes: 0 });
    expect(shouldFireMaintenance(cur, 1, 999)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// runBoundedMaintenance
// ---------------------------------------------------------------------

interface Counting {
  readonly storage: Storage;
  readonly total: () => number;
  readonly report: () => Record<string, number>;
}

const countingStorage = (inner: Storage): Counting => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const wrapper: Storage = {
    async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
      counts.get += 1;
      return inner.get(key, opts);
    },
    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      counts.put += 1;
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
  };
};

/** Seed `n` real log entries via the Writer (no snapshot yet). */
const seedLog = async (storage: Storage, key: string, coll: string, n: number): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "bounded-test", claimed_at: "" },
    tail_bytes: 0,
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
  patch: Partial<Pick<CurrentJson, "tail_bytes" | "snapshot_bytes" | "snapshot_rows">>,
): Promise<void> => {
  await casUpdateCurrentJson(storage, key, (cur) => ({ ...cur, ...patch }));
};

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
  test("disabled: true performs ZERO storage ops", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, { tail_bytes: 1_000_000, snapshot_bytes: 0, snapshot_rows: 0 });
    const c = countingStorage(inner);
    await runBoundedMaintenance({
      storage: c.storage,
      currentJsonKey: KEY,
      prevSeq: 0,
      disabled: true,
    });
    expect(c.total()).toBe(0);
  });

  test("single-phase: a fold-viable, gate1-tripping tick folds and does NOT also GC", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // Ratio >= 1 and >= minEntriesToCompact (60 >= 50). Snapshot tiny ⇒ fold-viable.
    await patchCurrent(inner, KEY, {
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    // Choose prevSeq/nextSeq so NO gc boundary is crossed (prevSeq===nextSeq).
    const cur = await readCurrentJson(inner, KEY);
    const nextSeq = cur!.json.next_seq;
    const c = countingStorage(inner);
    await runBoundedMaintenance({
      storage: c.storage,
      currentJsonKey: KEY,
      prevSeq: nextSeq, // same bucket ⇒ no GC boundary
    });
    const after = await readSeqStart(inner, KEY);
    // Folded a slice.
    expect(after).toBeGreaterThan(before);
    // No GC ran ⇒ no DELETEs and no gc/pending.json was touched.
    expect(c.report()["delete"]).toBe(0);
  });

  test("non-fold tick that crosses the GC boundary runs runGc", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // Pre-compact so there are stale-log candidates to mark, then make
    // the tail too small to trip gate1 (ratio < 1).
    await compact({ storage: inner, currentJsonKey: KEY });
    await patchCurrent(inner, KEY, { tail_bytes: 0, snapshot_bytes: 10_000_000 });
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
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
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

  test("a defer pass past the warn interval warns once AND stamps last_warned_seq", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60); // next_seq = 60 (>= WARN_INTERVAL would be false…)
    // …so force next_seq well past the interval boundary by stamping a
    // current.json whose next_seq is large but last_warned_seq is absent.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // > MAINTENANCE_MAX_FOLD_ROWS ⇒ defer
      next_seq: MAINTENANCE_WARN_INTERVAL_WRITES + 5,
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
    // The warn stamped last_warned_seq = next_seq via a separate CAS.
    await expect(readLastWarnedSeq(inner, KEY)).resolves.toBe(expectedNextSeq);
  });

  test("a defer pass WITHIN the warn interval does NOT warn — across FRESH runner calls", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    // last_warned_seq sits just below next_seq ⇒ inside the interval.
    const nextSeq = MAINTENANCE_WARN_INTERVAL_WRITES + 5;
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 1_000_000, // defer
      next_seq: nextSeq,
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
      // …but no warn, because next_seq - last_warned_seq < interval.
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
    // gate1 trips and snapshot is tiny ⇒ fold-viable. Push next_seq well
    // past the warn interval so a stray warn would be visible.
    await casUpdateCurrentJson(inner, KEY, (cur) => ({
      ...cur,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
      next_seq: MAINTENANCE_WARN_INTERVAL_WRITES + 5,
    }));
    const cur = await readCurrentJson(inner, KEY);
    const nextSeq = cur!.json.next_seq;

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
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    const cur = await readCurrentJson(inner, KEY);
    const nextSeq = cur!.json.next_seq;
    await runBoundedMaintenance({
      storage: inner,
      currentJsonKey: KEY,
      prevSeq: nextSeq, // no GC boundary; just fold
    });
    const after = await readSeqStart(inner, KEY);
    expect(after - before).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(after).toBeLessThan(tail);
  });

  test("cas-lost fold bumps db.compaction.cas_lost_total", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, {
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const cur = await readCurrentJson(inner, KEY);
    const nextSeq = cur!.json.next_seq;
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
          const { BaerlyError } = await import("@baerly/protocol");
          throw new BaerlyError("Conflict", "simulated CAS loss");
        }
        return inner.put(key, body, opts);
      },
    };
    const recorder = await withRecorder(async () => {
      await runBoundedMaintenance({
        storage: failingPut,
        currentJsonKey: KEY,
        prevSeq: nextSeq, // no GC boundary; isolate the fold
      });
    });
    expect(counterTotal(recorder, "db.compaction.cas_lost_total")).toBeGreaterThan(0);
    // cas-lost is EXPECTED — no unexpected-error bump, runner resolved.
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBe(0);
  });

  test('phasesPerTick "both" runs a fold AND a gc in one call', async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await patchCurrent(inner, KEY, {
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
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

  test("hard-GC starvation guard fires on single: runs GC, skips fold on the hard boundary", async () => {
    const inner = new MemoryStorage();
    await seedLog(inner, KEY, COLL, 60);
    await compact({ storage: inner, currentJsonKey: KEY }); // leave stale-log candidates
    // Keep gate1 tripping every tick (tail huge).
    await patchCurrent(inner, KEY, {
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const before = await readSeqStart(inner, KEY);
    // prevSeq=0 → nextSeq crosses the HARD boundary (interval * GUARD).
    // Pick a nextSeq that crosses the hard boundary: any nextSeq >=
    // interval*GUARD with prevSeq 0 does. The seeded next_seq is 60,
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
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // Storage whose first GET (readCurrentJson inside the runner) throws
    // a non-Conflict error.
    const boom: Storage = {
      get(): Promise<StorageGetResult | null> {
        return Promise.reject(new Error("disk on fire"));
      },
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    };
    let rejected = false;
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
    expect(counterTotal(recorder, "db.maintenance.unexpected_error_total")).toBeGreaterThan(0);
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

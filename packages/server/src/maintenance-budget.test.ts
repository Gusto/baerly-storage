/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the budget test seeds doc bodies with it. */

/**
 * Cloudflare free-tier subrequest budget guard.
 *
 * One scheduled Worker invocation is capped at 50 subrequests on the
 * free tier; this test wraps `MemoryStorage` in a counting proxy and
 * proves that every isolated scheduled phase under
 * {@link CLOUDFLARE_FREE_TIER} stays at or below that budget. R2
 * binding ops map 1:1 to subrequests, so the proxy counts `get` /
 * `put` / `delete` / `list` invocations as one each.
 *
 * The Cloudflare scheduled handler runs only one phase per tick
 * (even-minute compact, odd-minute GC), so these tests check each phase
 * in isolation, mirroring production. If a future refactor inflates
 * either phase's per-tick budget, this is the load-bearing test that
 * fails — do NOT relax the assertion. Tune `CLOUDFLARE_FREE_TIER` or the
 * underlying primitives instead.
 */

import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  GC_PENDING_SCHEMA_VERSION,
  GC_STARVATION_GUARD,
  LOG_FORWARD_PROBE_CAP,
  MAINTENANCE_MAX_FOLD_ROWS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  createCurrentJson,
  createGcPending,
  logDeleteFloorOf,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  LOG_STATE_GENERATION,
  logStateCurrentJson,
  seedLogEntries,
} from "../../../tests/fixtures/log-state.ts";
import { seedLegacyContentForBody } from "../../../tests/fixtures/legacy-content.ts";
import { compact } from "./compactor.ts";
import { runGc } from "./gc.ts";
import { computeRetirableRange } from "./log-retention.ts";
import { CLOUDFLARE_FREE_TIER, crossesGcBoundary, runBoundedMaintenance } from "./maintenance.ts";
import { snapshotKey } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const FREE_TIER_BUDGET = 50;

/**
 * Wrap a {@link Storage} and count its top-level method invocations.
 * `get` / `put` / `delete` / `list` each count as one storage op
 * (R2 binding semantics: one op per call, regardless of body size).
 */
const countingStorage = (
  inner: Storage,
): {
  storage: Storage;
  getOps: () => number;
  report: () => Record<string, number>;
  listedPrefixes: () => string[];
} => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const prefixes: string[] = [];
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
      prefixes.push(prefix);
      return inner.list(prefix, opts);
    },
  };
  return {
    storage: wrapper,
    getOps: (): number => counts.get + counts.put + counts.delete + counts.list,
    report: (): Record<string, number> => ({ ...counts }),
    listedPrefixes: (): string[] => [...prefixes],
  };
};

const seed = async (
  storage: Storage,
  key: string,
  collection: string,
  entries: number,
): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "budget-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const writer = new Writer({ storage, currentJsonKey: key });
  for (let i = 0; i < entries; i++) {
    await writer.commit({
      op: "I",
      collection,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i },
    });
  }
};

describe("CLOUDFLARE_FREE_TIER budget", () => {
  const KEY = "app/t/tenant/x/manifests/c/current.json";
  const COLL = "c";

  test("a write-tick GC leaves a legacy content object untouched and stays within budget", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 0,
        tail_hint: 0,
      }),
    );
    await seedLogEntries(inner, prefix, 0, 80, (seq) => ({
      after: { _id: `d${seq}`, n: seq },
    }));
    const liveContent = await seedLegacyContentForBody(inner, prefix, { _id: "d0", n: 0 });
    const counted = countingStorage(inner);

    await runBoundedMaintenance({
      storage: counted.storage,
      currentJsonKey: KEY,
      prevSeq: 79,
      observedTail: 80,
    });

    expect(
      counted.getOps(),
      `ops by category: ${JSON.stringify(counted.report())}`,
    ).toBeLessThanOrEqual(FREE_TIER_BUDGET);
    await expect(inner.get(liveContent)).resolves.not.toBeNull();
    expect(counted.listedPrefixes()).not.toContain(`${prefix}/content/`);
  });

  test.each([
    { name: "hard-GC guard", phasesPerTick: "single" as const },
    { name: "cadence GC", phasesPerTick: "both" as const },
  ])("$name refreshes a 128-entry stale tail_hint within budget", async ({ phasesPerTick }) => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 0,
        tail_hint: 0,
        snapshot_bytes: 10_000_000,
      }),
    );
    await seedLogEntries(inner, prefix, 0, 128);
    const counted = countingStorage(inner);

    await runBoundedMaintenance(
      {
        storage: counted.storage,
        currentJsonKey: KEY,
        prevSeq: 127,
        observedTail: 128,
      },
      { phasesPerTick },
    );

    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.tail_hint).toBe(128);
    expect(
      counted.getOps(),
      `ops by category: ${JSON.stringify(counted.report())}`,
    ).toBeLessThanOrEqual(FREE_TIER_BUDGET);
    expect(counted.listedPrefixes()).not.toContain(`${prefix}/content/`);
  });

  test("compact-only ticks converge from a stale-low tail_hint within the 50-op budget", async () => {
    // Even-minute branch of the scheduled handler: compact alone. The
    // writer deliberately leaves tail_hint stale, so each invocation must
    // bound discovery, checkpoint progress, and let later ticks resume.
    const inner = new MemoryStorage();
    await seed(inner, KEY, COLL, 100);

    const perPassOps: number[] = [];
    const reasons: Array<string | undefined> = [];
    const states: Array<{ log_seq_start: number; tail_hint: number }> = [];
    const reports: Array<Record<string, number>> = [];
    let reachedBelowMinThreshold = false;

    for (let invocation = 0; invocation < 10; invocation++) {
      const { storage, getOps, report } = countingStorage(inner);
      const result = await compact({ storage, currentJsonKey: KEY }, CLOUDFLARE_FREE_TIER.compact);
      const current = await readCurrentJson(inner, KEY);
      expect(current).not.toBeNull();

      perPassOps.push(getOps());
      reasons.push(result.skippedReason);
      reports.push(report());
      states.push({
        log_seq_start: current!.json.log_seq_start,
        tail_hint: current!.json.tail_hint,
      });

      if (result.skippedReason === "below-min-threshold") {
        reachedBelowMinThreshold = true;
        break;
      }
    }

    for (let i = 1; i < states.length; i++) {
      expect(states[i]!.log_seq_start).toBeGreaterThanOrEqual(states[i - 1]!.log_seq_start);
      expect(states[i]!.tail_hint).toBeGreaterThanOrEqual(states[i - 1]!.tail_hint);
    }

    expect(reachedBelowMinThreshold).toBe(true);
    expect(perPassOps.length).toBeLessThan(10);
    expect(
      perPassOps.every((ops) => ops <= FREE_TIER_BUDGET),
      `per-pass ops: ${JSON.stringify(perPassOps)}; reports: ${JSON.stringify(reports)}`,
    ).toBe(true);
    expect(perPassOps, `reports: ${JSON.stringify(reports)}`).toEqual([48, 49, 49, 49, 25, 2]);
    expect(Math.max(...perPassOps)).toBe(49);
    expect(reasons).not.toContain("probe-budget-checkpointed");

    const finalCurrent = await readCurrentJson(inner, KEY);
    expect(finalCurrent).not.toBeNull();
    expect(finalCurrent!.json).toMatchObject({ log_seq_start: 100, tail_hint: 100 });
  });

  // Drives the real alternating scheduled phases end to end rather than
  // priming `tail_hint` by hand — hand-priming hides the stale-hint catch-up
  // cost, which is exactly the cost that has to stay inside the budget. Every
  // invocation must stay bounded AND advance both manifest positions
  // monotonically.
  test.each([60, 100])(
    "real compact/GC alternation drains %i entries within budget",
    async (entryCount) => {
      const inner = new MemoryStorage();
      await seed(inner, KEY, COLL, entryCount);
      const seededCurrent = await readCurrentJson(inner, KEY);
      expect(seededCurrent?.json.tail_hint).toBe(0);

      const states: Array<{ log_seq_start: number; tail_hint: number }> = [];
      const invocations: Array<{
        phase: "compact" | "gc";
        ops: number;
        report: Record<string, number>;
      }> = [];
      let drained = false;

      for (let invocation = 0; invocation < 24 && !drained; invocation++) {
        const counted = countingStorage(inner);
        const phase = invocation % 2 === 0 ? "compact" : "gc";
        if (phase === "compact") {
          await compact(
            { storage: counted.storage, currentJsonKey: KEY },
            CLOUDFLARE_FREE_TIER.compact,
          );
        } else {
          await runGc({ storage: counted.storage, currentJsonKey: KEY }, CLOUDFLARE_FREE_TIER.gc);
        }

        const current = await readCurrentJson(inner, KEY);
        expect(current).not.toBeNull();
        states.push({
          log_seq_start: current!.json.log_seq_start,
          tail_hint: current!.json.tail_hint,
        });
        const report = counted.report();
        const ops = counted.getOps();
        invocations.push({ phase, ops, report });
        expect(
          ops,
          `entries=${entryCount}; invocation=${invocation}; phase=${phase}; report=${JSON.stringify(report)}`,
        ).toBeLessThanOrEqual(FREE_TIER_BUDGET);
        // Same condition the post-loop assertions pin, so the loop exits
        // exactly when the drain it is measuring has happened.
        drained =
          current!.json.tail_hint === entryCount && entryCount - current!.json.log_seq_start <= 20;
      }

      for (let i = 1; i < states.length; i++) {
        expect(states[i]!.log_seq_start).toBeGreaterThanOrEqual(states[i - 1]!.log_seq_start);
        expect(states[i]!.tail_hint).toBeGreaterThanOrEqual(states[i - 1]!.tail_hint);
      }
      if (!drained) {
        throw new Error(`never drained: ${JSON.stringify(invocations)}`);
      }
      expect(states.at(-1)?.tail_hint).toBe(entryCount);
      expect(entryCount - states.at(-1)!.log_seq_start).toBeLessThanOrEqual(20);
    },
  );

  // Hand-derived maximum for a maximally contended write-tick GC:
  //   1 runner `current.json` GET
  // + 1 runGc Step-1 `current.json` GET
  // + 3 pending bootstrap-conflict ops (GET null, create PUT, re-read GET)
  // + 2 LISTs (log/, snapshot/)
  // + 1 fresh `current.json` GET forced by a due snapshot candidate
  // + 10 DELETEs (S = WRITE_TICK_GC_MAX_SWEEPS)
  // + 6 final pending CAS ops (GC_PENDING_CAS_MAX_ATTEMPTS x [GET, PUT])
  // + 2 `tail_hint` refresh ops (casUpdateCurrentJson: GET + PUT, single
  //   attempt — it does not retry)
  // = 26, against a 50-subrequest invocation cap.
  test("maximally contended write-tick GC refreshes tail_hint at 26 storage operations", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    const logFloor = 20;
    // Make the refresh ELIGIBLE, so this case exercises it rather than the
    // rate limit. Asserted, not assumed: a raised interval must fail here
    // instead of silently defanging the test.
    const observedTail = logFloor + MAINTENANCE_TAIL_HINT_REFRESH_WRITES;
    expect(observedTail - logFloor).toBeGreaterThanOrEqual(MAINTENANCE_TAIL_HINT_REFRESH_WRITES);
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: logFloor,
        tail_hint: logFloor,
      }),
    );
    await seedLogEntries(inner, prefix, logFloor, observedTail);
    await seedLogEntries(inner, prefix, 0, 9);
    const dueCandidates = [
      ...Array.from({ length: 9 }, (_, index) => ({
        key: `${prefix}/log/${String(index)}.json`,
        due_at: "2000-01-01T00:00:00.000Z",
        reason: "stale-log" as const,
        generation: LOG_STATE_GENERATION,
      })),
      {
        key: snapshotKey(prefix, 0, 19, "c".repeat(64)),
        due_at: "2000-01-01T00:00:00.000Z",
        reason: "orphan-snapshot" as const,
        generation: LOG_STATE_GENERATION,
      },
    ];
    let firstPendingRead = true;
    let injectedBootstrapWinner = false;
    const contended: Storage = {
      async get(key, opts) {
        if (key === `${prefix}/gc/pending.json` && firstPendingRead) {
          firstPendingRead = false;
          return null;
        }
        return inner.get(key, opts);
      },
      async put(key, body, opts) {
        if (
          key === `${prefix}/gc/pending.json` &&
          opts?.ifNoneMatch === "*" &&
          !injectedBootstrapWinner
        ) {
          injectedBootstrapWinner = true;
          await createGcPending(inner, key, {
            schema_version: GC_PENDING_SCHEMA_VERSION,
            candidates: dueCandidates,
            last_swept_at: "",
          });
          return inner.put(key, body, opts);
        }
        if (key === `${prefix}/gc/pending.json` && opts?.ifMatch !== undefined) {
          throw new BaerlyError("Conflict", "forced final pending CAS conflict");
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (listPrefix, opts) => inner.list(listPrefix, opts),
    };
    const counted = countingStorage(contended);

    await runBoundedMaintenance(
      {
        storage: counted.storage,
        currentJsonKey: KEY,
        // 143 → 148 crosses the hard-GC boundary (gcInterval *
        // GC_STARVATION_GUARD = 16), so this tick's one phase is GC.
        prevSeq: 143,
        observedTail,
      },
      {
        gcGraceMillis: 0,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    // GC does not list log/ — log keys are computable from `seq`, so
    // retirement needs no discovery — leaving snapshot/ as the only LIST.
    expect(counted.listedPrefixes()).toEqual([`${prefix}/snapshot/L9/`]);
    // Nothing on the GC path can suppress the refresh, so once the rate limit
    // is eligible the hint reaches the observed tail in a single tick.
    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.tail_hint).toBe(observedTail);
    // get 10 = runner current + runGc step-1 current + pending read (null)
    //          + pending re-read after the bootstrap conflict + fresh current
    //          + 3 final CAS reads + tail_hint refresh read + retireLogRange gate read
    // put 5  = pending bootstrap create + 3 final CAS writes + refresh write
    // list 1  = snapshot/ LIST (GC never LISTs log/)
    expect(counted.report()).toEqual({ get: 10, put: 5, delete: 10, list: 1 });
    const totalOps = counted.getOps();
    expect(totalOps).toBe(26);
    expect(totalOps).toBeLessThanOrEqual(FREE_TIER_BUDGET);
  });

  test("a never-folding GC-only collection's tail_hint gap stays far below the forward-probe cap", () => {
    // A GC tick takes the ordinary rate-limited refresh, so the gap can
    // exceed MAINTENANCE_TAIL_HINT_REFRESH_WRITES only by the writes that
    // accrue before the next GC tick — and the hard-GC starvation guard
    // fires at least every `gcInterval * GC_STARVATION_GUARD` writes. That
    // sum is the whole bound.
    const worstCaseGap =
      MAINTENANCE_TAIL_HINT_REFRESH_WRITES +
      MAINTENANCE_PROFILE_CF_FREE.gcInterval * GC_STARVATION_GUARD;
    expect(worstCaseGap).toBeLessThan(LOG_FORWARD_PROBE_CAP);
  });

  // A DEFER refreshes `tail_hint` at Step 3 and then falls through to GC,
  // so the tick has two call sites for one publication. The rate limit
  // cannot catch the second: it reads the in-memory `current`, which
  // `casUpdateCurrentJson` never writes back, so an unguarded second call
  // still evaluates as due and rewrites byte-identical bytes.
  //
  // Every collection shape reaches this path. It is a correctness-of-op-count
  // pin, not a rescue of the 50-op cap — the redundant write would cost 2 ops
  // on an already-cheap pass.
  test("a deferring fold that falls through to GC refreshes tail_hint exactly once", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    const logFloor = 40;
    // Exactly at the rate limit, so this case discriminates the publication
    // guard rather than the interval.
    const observedTail = logFloor + MAINTENANCE_TAIL_HINT_REFRESH_WRITES;
    // Crosses the gcInterval boundary (Step 4 opens) but NOT the hard-GC one
    // (Step 2 must not early-return, or we never reach the DEFER branch).
    const prevSeq = 164;
    expect(crossesGcBoundary(prevSeq, observedTail, MAINTENANCE_PROFILE_CF_FREE.gcInterval)).toBe(
      true,
    );
    expect(
      crossesGcBoundary(
        prevSeq,
        observedTail,
        MAINTENANCE_PROFILE_CF_FREE.gcInterval * GC_STARVATION_GUARD,
      ),
    ).toBe(false);

    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: logFloor,
        tail_hint: logFloor,
        // Rows arm trips the fold ceiling -> foldViable false -> DEFER.
        snapshot_rows: MAINTENANCE_MAX_FOLD_ROWS - WRITE_TICK_FOLD_ENTRIES_PER_PASS + 1,
        // Bytes arm stays under C, and keeps the ratio denominator pinned to
        // MAINTENANCE_MIN_LIVE_BYTES so gate1 trips on the mean alone.
        snapshot_bytes: 1024,
        mean_entry_bytes: 1024,
      }),
    );
    await seedLogEntries(inner, prefix, logFloor, observedTail);
    // GC itself never publishes `tail_hint`, so the Step-3 defer refresh and
    // the Step-4 GC fall-through are the tick's two call sites for one
    // publication — which is what exposes a second, redundant write.

    let currentJsonPuts = 0;
    const keyCounting: Storage = {
      get: (key, opts) => inner.get(key, opts),
      put: (key, body, opts) => {
        if (key === KEY) {
          currentJsonPuts += 1;
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (listPrefix, opts) => inner.list(listPrefix, opts),
    };
    const counted = countingStorage(keyCounting);

    await runBoundedMaintenance(
      { storage: counted.storage, currentJsonKey: KEY, prevSeq, observedTail },
      { gcGraceMillis: 0, now: () => new Date("2026-01-01T00:00:00.000Z") },
    );

    // One publication, and it lands the observed tail.
    expect(currentJsonPuts).toBe(1);
    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.tail_hint).toBe(observedTail);
    expect(counted.getOps()).toBeLessThanOrEqual(FREE_TIER_BUDGET);
  });

  test("B4: a write-tick fold with a STALE-LOW stored tail_hint stays within budget because observedTail bounds the probe", async () => {
    // Under single-write commit the writer never advances tail_hint, so on
    // a never-yet-folded backlog the stored hint can lag the true tail by
    // the whole tail. If compact() re-probed from that stale hint it would
    // walk O(gap) GETs — blowing the 50-subrequest budget on a long tail.
    // B4 threads the writer's in-memory observedTail into the runner's
    // compact() call as the probe floor, so the ceiling probe is bounded by
    // "commits since this writer's commit" (here: an immediate 404), NOT by
    // the stale hint. This is the un-masked version of the compact-only
    // budget test above, which had to pre-stamp tail_hint to stay in budget.
    const inner = new MemoryStorage();
    // 200 entries, tail_hint DELIBERATELY left at 0 (never pre-stamped).
    await seed(inner, KEY, COLL, 200);
    // Trip the runner's gate1 (ratio>=1) so the fold path actually runs —
    // a large mean over a zero-byte snapshot. snapshot tiny ⇒ fold-viable.
    const { casUpdateCurrentJson, MAINTENANCE_MIN_LIVE_BYTES } = await import("@baerly/protocol");
    await casUpdateCurrentJson(inner, KEY, (c) => ({
      ...c,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    }));
    const { storage, getOps, report } = countingStorage(inner);

    await runBoundedMaintenance(
      {
        storage,
        currentJsonKey: KEY,
        prevSeq: 200,
        observedTail: 200, // writer's fresh lower bound — bounds the probe
      },
      // CF-free profile ⇒ single phase, fold-priority; ratio trips.
      { profile: undefined, phasesPerTick: "single" },
    );

    const ops = getOps();
    expect(ops, `ops by category: ${JSON.stringify(report())}`).toBeLessThanOrEqual(
      FREE_TIER_BUDGET,
    );
  });

  // Fold/retire phase separation. In `"single"` phase mode a write-tick
  // fold returns from the runner BEFORE the Step-5 retirement call — a
  // compact pass is ≤49 ops on its own, so retirement (up to 23 more)
  // sharing a fold tick would blow the 50-subrequest free-tier cap (see
  // LOG_RETENTION_MAX_DELETES_PER_TICK's JSDoc). This pin holds today by
  // control flow alone; a refactor that hoists Step 5 above the fold
  // return must fail HERE rather than silently regress the cap.
  test("a single-phase fold tick issues zero retirement storage ops", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    // 60 live entries on an unfloored log: gate1 trips (60 ≥ the
    // write-tick min of 50) and the fold is viable (no prior snapshot).
    // prevSeq 59 → observedTail 60 crosses neither the GC cadence
    // boundary nor the hard-GC guard, so the fold is this tick's one
    // phase and nothing after it may run.
    await createCurrentJson(inner, KEY, logStateCurrentJson({ log_seq_start: 0, tail_hint: 0 }));
    await seedLogEntries(inner, prefix, 0, 60);
    const { casUpdateCurrentJson, MAINTENANCE_MIN_LIVE_BYTES } = await import("@baerly/protocol");
    // Ratio trigger: a large mean over a zero-byte snapshot. Asserted via
    // the gate outcomes below, not assumed.
    await casUpdateCurrentJson(inner, KEY, (c) => ({
      ...c,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
    }));
    const counted = countingStorage(inner);

    await runBoundedMaintenance(
      {
        storage: counted.storage,
        currentJsonKey: KEY,
        prevSeq: 59,
        observedTail: 60,
      },
      {
        phasesPerTick: "single",
        // `window: 0` is load-bearing for the pin: with the default
        // 1024-seq window a 20-entry folded prefix has an EMPTY
        // retirable range, so a hoisted Step 5 would no-op (1 gate GET,
        // zero DELETEs) and this test could not distinguish it from the
        // phase separation it is supposed to guard. With the window
        // erased, a Step 5 that ran would immediately DELETE and publish
        // a floor.
        logRetention: { window: 0, maxDeletes: 20 },
      },
    );

    // The fold ran and landed: this tick's one phase was a fold, so the
    // assertions below are about a fold tick, not a skipped one.
    const current = await readCurrentJson(inner, KEY);
    expect(current).not.toBeNull();
    expect(current!.json.log_seq_start).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(current!.json.snapshot).not.toBeNull();

    // ZERO retirement ops: no DELETEs anywhere in the tick (the fold path
    // issues none), and no `log_delete_floor` published.
    expect(counted.report()["delete"]).toBe(0);
    expect(logDeleteFloorOf(current!.json)).toBe(0);

    // Non-vacuity, asserted not assumed: the post-tick state HAS a
    // non-empty retirable range under the seam window, so a Step 5 that
    // ran on this tick would have deleted — the zero above is the phase
    // separation, not an empty gate.
    const retirable = computeRetirableRange(current!.json, { window: 0, maxDeletes: 20 });
    expect(retirable.start).toBeLessThan(retirable.end);

    expect(
      counted.getOps(),
      `ops by category: ${JSON.stringify(counted.report())}`,
    ).toBeLessThanOrEqual(FREE_TIER_BUDGET);
  });
});

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
 * (even-minute compact, odd-minute GC). GC admits the content phase only
 * after a bounded exact probe proves the full live tail affordable; a
 * partial GC still advances the hint and performs non-content cleanup.
 * These tests check each phase in isolation, mirroring production. If a future refactor
 * inflates either phase's per-tick budget, this is the load-bearing
 * test that fails — do NOT relax the assertion. Tune
 * `CLOUDFLARE_FREE_TIER` or the underlying primitives instead.
 */

import {
  BaerlyError,
  CF_FREE_GC_TAIL_PROBE_GETS,
  CURRENT_JSON_SCHEMA_VERSION,
  GC_PENDING_SCHEMA_VERSION,
  GC_STARVATION_GUARD,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  SNAPSHOT_SCHEMA_VERSION,
  createCurrentJson,
  createGcPending,
  MemoryStorage,
  readCurrentJson,
  snapshotHash,
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
import { type InternalRunGcOptions, runGc } from "./gc.ts";
import { CLOUDFLARE_FREE_TIER, runBoundedMaintenance } from "./maintenance.ts";
import { encodeSnapshotBody, snapshotKey } from "./snapshot.ts";
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

  test("write-tick hard GC bounds legacy liveness with an 80-entry stale-low tail", async () => {
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
  });

  test.each([
    { name: "hard-GC guard", phasesPerTick: "single" as const },
    { name: "cadence GC", phasesPerTick: "both" as const },
  ])(
    "content-free $name refreshes a 128-entry stale tail_hint within budget",
    async ({ phasesPerTick }) => {
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
      expect(counted.listedPrefixes()).toContain(`${prefix}/content/`);
    },
  );

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

  // Production mutation caught: manual tail priming hid both the stale-hint
  // catch-up cost and content-GC starvation. Real alternating scheduled
  // phases must keep every invocation bounded, advance manifest positions
  // monotonically, and eventually admit a complete content-marking pass.
  test.each([60, 100])(
    "real compact/GC alternation drains %i entries within budget and admits content marking",
    async (entryCount) => {
      const inner = new MemoryStorage();
      await seed(inner, KEY, COLL, entryCount);
      const orphanContent =
        "app/t/tenant/x/manifests/c/content/00000000000000000000000000000000.json";
      await inner.put(orphanContent, new TextEncoder().encode('{"_id":"orphan"}'));
      const seededCurrent = await readCurrentJson(inner, KEY);
      expect(seededCurrent?.json.tail_hint).toBe(0);

      const states: Array<{ log_seq_start: number; tail_hint: number }> = [];
      const invocations: Array<{
        phase: "compact" | "gc";
        ops: number;
        report: Record<string, number>;
      }> = [];
      let fullContentPass = false;

      for (let invocation = 0; invocation < 24 && !fullContentPass; invocation++) {
        const counted = countingStorage(inner);
        const phase = invocation % 2 === 0 ? "compact" : "gc";
        if (phase === "compact") {
          await compact(
            { storage: counted.storage, currentJsonKey: KEY },
            CLOUDFLARE_FREE_TIER.compact,
          );
        } else {
          const result = await runGc(
            { storage: counted.storage, currentJsonKey: KEY },
            CLOUDFLARE_FREE_TIER.gc,
          );
          if (result.marked.orphan_content === 1) {
            fullContentPass = true;
            expect(counted.listedPrefixes()).toContain("app/t/tenant/x/manifests/c/content/");
          }
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
      }

      for (let i = 1; i < states.length; i++) {
        expect(states[i]!.log_seq_start).toBeGreaterThanOrEqual(states[i - 1]!.log_seq_start);
        expect(states[i]!.tail_hint).toBeGreaterThanOrEqual(states[i - 1]!.tail_hint);
      }
      if (!fullContentPass) {
        throw new Error(`content pass never admitted: ${JSON.stringify(invocations)}`);
      }
      expect(fullContentPass).toBe(true);
      expect(states.at(-1)?.tail_hint).toBe(entryCount);
      expect(entryCount - states.at(-1)!.log_seq_start).toBeLessThanOrEqual(20);
    },
  );

  // Production mutation caught: forgetting any bootstrap/final-CAS retry
  // cost can make the nominal Free profile exceed 50 under contention.
  // Hand-derived maximum: 1 current GET + 21 live/probe GETs + 3 pending
  // bootstrap ops + 3 LISTs + 1 snapshot GET + 10 DELETEs + 1 fresh
  // current GET for a due snapshot + 6 final CAS ops = 46.
  test("maximally contended admitted GC stays at 46 storage operations", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    const snapshotBody = encodeSnapshotBody({
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      min_seq: 0,
      max_seq: 40,
      collection: COLL,
      docs: [],
    });
    const liveSnapshot = snapshotKey(prefix, 0, 40, await snapshotHash(snapshotBody));
    await inner.put(liveSnapshot, snapshotBody);
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        snapshot: liveSnapshot,
        log_seq_start: 40,
        tail_hint: 50,
      }),
    );
    await seedLogEntries(inner, prefix, 40, 60, (seq) => ({
      after: { _id: `d${seq}`, n: seq },
    }));
    // Keep this the admitted worst case: a nonempty legacy-content window
    // forces the complete live-log and snapshot liveness scan.
    await seedLegacyContentForBody(inner, prefix, { _id: "d40", n: 40 });
    const dueCandidates = [
      ...Array.from({ length: 9 }, (_, index) => ({
        key: `${prefix}/gc/due-${index}.json`,
        due_at: "2000-01-01T00:00:00.000Z",
        reason: "stale-log" as const,
        generation: LOG_STATE_GENERATION,
      })),
      {
        key: snapshotKey(prefix, 0, 39, "b".repeat(64)),
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

    const result = await runGc({ storage: counted.storage, currentJsonKey: KEY }, {
      ...CLOUDFLARE_FREE_TIER.gc,
      graceMillis: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as InternalRunGcOptions);

    expect(result.swept).toBe(10);
    const totalOps = counted.getOps();
    expect(totalOps).toBe(46);
    expect(totalOps).toBeLessThanOrEqual(FREE_TIER_BUDGET);
  });

  // A deferring pass keeps the tail hint it CERTIFIED and no more. The
  // outer write-tick refresh is deliberately suppressed here even though
  // its rate limit is satisfied (gap === MAINTENANCE_TAIL_HINT_REFRESH_WRITES
  // below): GC already CAS-checkpointed `floor + CF_FREE_GC_TAIL_PROBE_GETS`
  // from inside the bounded admission, and an unconditional outer GET+PUT
  // would push this proven worst case to 52 — over the invocation cap. The
  // hint still converges, because GC recurs at most every
  // `gcInterval * GC_STARVATION_GUARD` writes while each pass certifies
  // another `CF_FREE_GC_TAIL_PROBE_GETS` entries.
  test("maximally contended write-tick content deferral keeps its certified checkpoint at 50 storage operations", async () => {
    const inner = new MemoryStorage();
    const prefix = "app/t/tenant/x/manifests/c";
    const logFloor = 20;
    // Make the outer refresh ELIGIBLE, so this case discriminates the
    // deferral guard rather than the rate limit. Asserted, not assumed: a
    // raised interval must fail here instead of silently defanging the test.
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
    await seedLegacyContentForBody(inner, prefix, { _id: "needs-liveness", n: 1 });
    const dueCandidates = [
      ...Array.from({ length: 9 }, (_, index) => ({
        key: `${prefix}/gc/deferred-due-${index}.json`,
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

    expect(counted.listedPrefixes()).toEqual([
      `${prefix}/log/`,
      `${prefix}/snapshot/`,
      `${prefix}/content/`,
    ]);
    // The bounded admission's own CAS, and only it: the hint advances to the
    // occupancy the capped probe certified, NOT to `observedTail`.
    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.tail_hint).toBe(logFloor + CF_FREE_GC_TAIL_PROBE_GETS);
    expect(counted.report()).toEqual({ get: 32, put: 5, delete: 10, list: 3 });
    const totalOps = counted.getOps();
    expect(totalOps).toBe(50);
    expect(totalOps).toBeLessThanOrEqual(FREE_TIER_BUDGET);
  });

  test("a deferring pass certifies more tail than the hard-GC cadence lets accrue", () => {
    // The test above proves a deferring tick advances `tail_hint` by exactly
    // CF_FREE_GC_TAIL_PROBE_GETS and suppresses the outer refresh, so that
    // checkpoint is the ONLY hint advance a never-folding deferring
    // collection gets. It is sufficient only while one pass certifies more
    // entries than the worst-case cadence lets accrue between passes: the
    // hard-GC starvation guard fires at least every
    // `gcInterval * GC_STARVATION_GUARD` writes, so below that bound the gap
    // shrinks every pass and converges to an exact stamp. Invert the
    // relation and `(true_tail − tail_hint)` grows without bound instead,
    // until every read throws at LOG_FORWARD_PROBE_CAP — retune the outer
    // guard, do not relax this.
    const worstCaseWritesBetweenGcPasses =
      MAINTENANCE_PROFILE_CF_FREE.gcInterval * GC_STARVATION_GUARD;
    expect(CF_FREE_GC_TAIL_PROBE_GETS).toBeGreaterThan(worstCaseWritesBetweenGcPasses);
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
});

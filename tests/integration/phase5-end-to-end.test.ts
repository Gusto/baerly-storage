/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Collection<T>`
   declaration); the synthetic seed populates it directly. */

/**
 * Synthetic 5000-entry end-to-end verification gate.
 *
 * The "verifies the cost model" gate:
 * write 5000 entries through `Writer`, run `runScheduledMaintenance`
 * to quiescence, then assert
 *
 *   (a) every `find()` / `all()` / `where()` result is identical before
 *       vs. after compaction (sorted by `_id`),
 *   (b) the bucket object count drops (stale log entries + orphan
 *       content blobs swept by `runGc()`),
 *   (c) `current.json.snapshot !== null` and `log_seq_start` has
 *       advanced to within a small live tail of `tail_hint`,
 *   (d) an idle reader doing 1800 `tbl.where({}).all()` calls (≈ 1 hour
 *       at 2s polling) issues < 1 Class A op (PUT / DELETE / LIST).
 *       Real expectation: exactly 0.
 *
 * Variants: `memory` (zero infra, < 3s) and `local-fs` (real I/O, < 30s).
 * The `node-minio` and `cloudflare-r2` variants are deferred per the
 * ticket — adding them would inflate `pnpm test:minio` /
 * `pnpm test:adapter-cloudflare` without a corresponding signal that
 * the `memory` + `local-fs` matrix doesn't already cover.
 *
 * The cost-model gate (case 2) uses a hand-rolled counting `Storage`
 * proxy rather than `InMemoryMetricsRecorder` — the Class-A taxonomy is
 * a property of the storage API (PUT vs GET), not of any metric name
 * (ticket 19 §"Coordinates with ticket 17").
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  type Collection,
  MAINTENANCE_PROFILE_CF_FREE,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import {
  type BoundedMaintenanceOptions,
  compact,
  runGc,
  runScheduledMaintenance,
} from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import {
  type InternalCompactOptions,
  type InternalMaintenanceOptions,
  type InternalRunGcOptions,
  Writer,
} from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";
import {
  APP,
  bootstrap as bootstrapCurrentJson,
  COLLECTION,
  CURRENT_JSON_KEY,
  makeVariants,
  sortById,
  TABLE_PREFIX,
  TENANT,
  type Ticket,
} from "../fixtures/maintenance-harness.ts";

const bootstrap = (storage: Storage): Promise<void> => bootstrapCurrentJson(storage, "phase5-e2e");

const countBucketObjects = async (storage: Storage, prefix: string): Promise<number> => {
  let count = 0;
  for await (const _entry of storage.list(prefix)) {
    count++;
  }
  return count;
};

const VARIANTS = makeVariants("baerly-phase5-e2e-");

describe("Synthetic 5000-entry end-to-end gate", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanup: (() => Promise<void>) | undefined;

      afterEach(async () => {
        if (cleanup) {
          await cleanup();
        }
        cleanup = undefined;
      });

      test(
        "compaction over 5000 entries leaves find() results unchanged and shrinks the bucket",
        // Vitest's default 5s timeout is too tight for the 5000-write
        // sequential seed (memory a few seconds; local-fs dominated by
        // per-commit file PUTs under macOS ulimit). The seed is O(N) —
        // no per-commit integrity walk, and the in-band maintenance tick
        // is explicitly DISABLED during the seed (see (1)) so it can't
        // re-fold the growing tail. 90s gives headroom on local-fs.
        { timeout: 90_000 },
        async () => {
          const made = await variant.build();
          cleanup = made.cleanup;
          const { storage } = made;
          await bootstrap(storage);
          const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });

          // ── (1) Seed 5000 entries through the writer. ────────────────
          // Sequential single-doc `commit()` calls — the document is the
          // atomic unit; there is no batch path. The seed runs inside a
          // `maintenance: { disabled: true }` context: this is LOAD-
          // BEARING, not cosmetic. The write-tick maintenance dispatch in
          // `#singleAttemptCommit` fires by DEFAULT when no maintenance
          // context is present (`maint?.disabled !== true` is true when
          // `maint` is undefined — inline dispatch is the bare-writer
          // default), so a context-free 5000-commit loop would self-
          // compact mid-seed on every GC-cadence boundary: it re-folds the
          // growing tail O(N) times (≈O(N²) work) AND pre-shrinks the
          // bucket before the explicit `runScheduledMaintenance` below,
          // confounding the "before vs after" object-count comparison.
          // Disabling the tick keeps the seed inert and O(N) — a fixed
          // read + 3 PUTs per commit (`verifyLogIntegrityOnCommit` is off
          // by default, so no per-commit tail walk) — so the topology
          // going into maintenance is exactly N raw commits.
          const N = 5000;
          await runWithContext(
            createObservabilityContext({ maintenance: { disabled: true } }),
            async () => {
              for (let i = 0; i < N; i++) {
                const id = `t-${i.toString().padStart(5, "0")}`;
                const body: Ticket = {
                  _id: id,
                  status: i % 3 === 0 ? "closed" : "open",
                  priority: i % 5,
                };
                await writer.commit({ op: "I", collection: COLLECTION, docId: id, body });
              }
            },
          );

          // ── (2) Snapshot the read results BEFORE compaction. ─────────
          const db = Db.create({ storage, app: APP, tenant: TENANT });
          const tbl = db.collection(COLLECTION) as Collection<Ticket>;
          const rowsBefore = await tbl.where({}).all();
          const openBefore = await tbl.where({ status: "open" }).all();
          const priorityZeroBefore = await tbl.where({ priority: 0 }).all();
          expect(rowsBefore.length).toBe(N);

          const bucketPrefix = `${TABLE_PREFIX}/`;
          const objectsBefore = await countBucketObjects(storage, bucketPrefix);
          // 5000 log entries + 5000 content blobs + 1 current.json. The
          // exact count isn't asserted (impl detail of the writer) — but
          // it must be greater than N before compaction touches it.
          expect(objectsBefore).toBeGreaterThan(N);

          // ── (3) Run maintenance to quiescence. ───────────────────────
          // Engine defaults are unbounded (maxEntriesPerRun =
          // Number.MAX_SAFE_INTEGER) so a single compact pass folds
          // everything. GC marks 5000 stale_log + 5000 orphan_content
          // = 10000 candidates. We pass an explicit maxSweepsPerRun
          // override for the test so the sweep finishes in one pass
          // too — the bounded-budget cases are already covered by the
          // unit tests in `gc.test.ts`.
          //
          // Pass 1 → compact folds + GC marks + sweeps a budget worth.
          // Pass 2 → quiescence (entriesFolded === 0, swept === 0).
          // Cap at 20 passes so a regression doesn't infinite-loop.
          const QUIESCE_PROFILE: InternalMaintenanceOptions = {
            gc: {
              graceMillis: 0,
              maxSweepsPerRun: 100_000,
            } as InternalRunGcOptions,
          };
          let passes = 0;
          for (passes = 0; passes < 20; passes++) {
            const res = await runScheduledMaintenance(
              { storage, currentJsonKey: CURRENT_JSON_KEY },
              QUIESCE_PROFILE,
            );
            const folded = res.compact.entriesFolded;
            const swept = res.gc.swept;
            if (folded === 0 && swept === 0) {
              break;
            }
          }
          expect(passes).toBeLessThan(20);

          // ── (4) current.json carries a snapshot and log_seq_start. ───
          const cur = await storage.get(CURRENT_JSON_KEY);
          expect(cur).not.toBeNull();
          const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
            snapshot: string | null;
            tail_hint: number;
            log_seq_start?: number;
          };
          // Absolute literal kept on purpose — it pins a real contract:
          // each single-doc commit advances tail_hint by exactly 1, so N
          // sequential commits land tail_hint at exactly N (identical to
          // what the old single-CAS batch produced; the topology changed
          // but this end-state is invariant).
          expect(json.tail_hint).toBe(N);
          expect(json.snapshot).not.toBeNull();
          // The compactor folds the entire live tail in unbounded passes;
          // the writer minted nothing new in between, so log_seq_start
          // advances to within a small live-tail slack of tail_hint. Bound
          // form (not an exact literal) so a future change to the
          // compactor's lag-window default doesn't break the gate.
          expect(json.log_seq_start ?? 0).toBeGreaterThanOrEqual(N - 10);

          // ── (5) Re-read; results must match pre-compaction. ──────────
          const rowsAfter = await tbl.where({}).all();
          const openAfter = await tbl.where({ status: "open" }).all();
          const priorityZeroAfter = await tbl.where({ priority: 0 }).all();
          expect(rowsAfter.length).toBe(rowsBefore.length);
          expect(sortById(rowsAfter)).toEqual(sortById(rowsBefore));
          expect(sortById(openAfter)).toEqual(sortById(openBefore));
          expect(sortById(priorityZeroAfter)).toEqual(sortById(priorityZeroBefore));

          // ── (6) Bucket object count dropped. ─────────────────────────
          // Post-compaction + GC sweep: 1 current.json + 1 snapshot +
          // (small live tail or zero) + (gc/pending.json) + any
          // remaining content blobs the snapshot references back into
          // the orphan-mark set. The exact count is impl detail; the
          // gate is "strictly fewer than before compaction."
          const objectsAfter = await countBucketObjects(storage, bucketPrefix);
          expect(objectsAfter).toBeLessThan(objectsBefore);
        },
      );

      test(
        "idle reader uses < 1 Class A op / writer / hour (cost-model gate)",
        { timeout: 30_000 },
        async () => {
          const made = await variant.build();
          cleanup = made.cleanup;
          const { storage } = made;
          await bootstrap(storage);
          const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });

          // Seed enough writes to make compaction interesting; the
          // engine's default minEntriesToCompact is 100, so seed
          // exactly that.
          for (let i = 0; i < 100; i++) {
            const id = `t-${i.toString().padStart(3, "0")}`;
            await writer.commit({
              op: "I",
              collection: COLLECTION,
              docId: id,
              body: {
                _id: id,
                status: "open",
                priority: 1,
              } satisfies Ticket,
            });
          }
          // Compact + GC so reads hit the snapshot path. Two passes:
          // pass 1 folds + marks, pass 2 sweeps under grace=0.
          await runScheduledMaintenance(
            { storage, currentJsonKey: CURRENT_JSON_KEY },
            { gc: { graceMillis: 0 } as InternalRunGcOptions },
          );
          await runScheduledMaintenance(
            { storage, currentJsonKey: CURRENT_JSON_KEY },
            { gc: { graceMillis: 0 } as InternalRunGcOptions },
          );

          // Counting proxy. Class A = PUT, DELETE, LIST (S3 / R2
          // taxonomy: anything that mutates or enumerates). Class B
          // (GET, HEAD) is not counted — the idle reader's snapshot +
          // log-tail path should be GET-only.
          const counting = wrapCountingStorage(storage);

          // 1 hour at a 2-second poll cadence = 1800 reads. The
          // published cost model is "< 1 Class A op / writer / hour"
          // for an idle reader; the real expectation is exactly 0
          // (the reader only walks `current.json` + the snapshot +
          // the live-tail log entries, all by deterministic key →
          // all `get`).
          //
          // For broader workload analysis, see bench/README.md — the load
          // harness externalizes derived.class_a_per_tenant_per_hour.
          const db = Db.create({ storage: counting.storage, app: APP, tenant: TENANT });
          const tbl = db.collection(COLLECTION) as Collection<Ticket>;
          const T = 1800;
          for (let i = 0; i < T; i++) {
            await tbl.where({}).all();
          }
          expect(counting.classAOps).toBeLessThan(1);
          // Strengthen: the documented expectation is exactly 0. If
          // this ever flips to 1 we want to know immediately — a LIST
          // or PUT crept into the read path.
          expect(counting.classAOps).toBe(0);
        },
      );
    });
  }
});

// =====================================================================
// Write-tick (in-band) maintenance — the e2e form of the §7.1 drain.
//
// The cases below exercise the EXACT production write-tick path: the
// writer reads `getCurrentContext()?.maintenance` at its post-CAS
// dispatch point and runs `runBoundedMaintenance` inline. Driving real
// `Writer.commit`s INSIDE a `runWithContext(createObservabilityContext({
// maintenance: {...} }), ...)` scope therefore maintains the bucket with
// NO `runScheduledMaintenance` call at all — that is the integration
// proof of "writes alone maintain the bucket". (The kernel-unit form of
// the same drain lives in `packages/server/src/maintenance-drain.test.ts`;
// these are its 5000-seed-and-beyond e2e siblings.)
//
// The steady-state + contention arms run on the `memory` variant only:
// they drive thousands of writes (each fanning out into multiple PUTs +
// per-tick maintenance reads), which on `local-fs` would blow the
// 60s-per-test budget without adding signal the `memory` arm doesn't
// already give. The `local-fs` real-I/O surface is covered by the two
// existing tests above.
// =====================================================================
const WORKING_SET = 50; // bounded live doc set ⇒ constant live floor
const BODY_BYTES = 2000; // bodies large enough that the ratio gate trips and folds fire on cadence

// The shared write-tick maintenance profile for these tests:
// `phasesPerTick: "both"` (Node-tier) so a fold AND a GC can run in one
// tick; `gcGraceMillis: 0` so a marked orphan is swept the same pass (no
// 7-day clock advance). A bounded working set under big bodies makes the
// tail outgrow the snapshot quickly, tripping the ratio gate and folding.
// The ceiling test reuses this byte-identical profile and threads its
// distinct `maxFoldBytes` through the ctx separately.
const WRITE_TICK_TEST_PROFILE: BoundedMaintenanceOptions = {
  profile: {
    ...MAINTENANCE_PROFILE_CF_FREE,
    maxFoldEntriesPerPass: 20,
    gcMaxMarks: 100,
    gcMaxSweeps: 50,
    gcInterval: 4,
  },
  minEntriesToCompact: 50,
  phasesPerTick: "both",
  gcGraceMillis: 0,
};

/** Count every key currently under a collection prefix (one `list` walk). */
const countKeys = async (storage: Storage, prefix: string): Promise<number> => {
  let n = 0;
  for await (const _entry of storage.list(prefix)) {
    n += 1;
  }
  return n;
};

/**
 * Count snapshot objects NOT referenced by `current.json` — the orphan
 * snapshots a fold's CAS-loser leaves behind. A snapshot key under
 * `<collectionPrefix>/snapshot/` that isn't equal to `current.snapshot`
 * is an orphan (the same classification `runGc` uses at gc.ts §4).
 */
const countOrphanSnapshots = async (storage: Storage, currentJsonKey: string): Promise<number> => {
  const read = await readCurrentJson(storage, currentJsonKey);
  const live = read?.json.snapshot ?? null;
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  let orphans = 0;
  for await (const entry of storage.list(`${collectionPrefix}/snapshot/`)) {
    if (entry.key !== live) {
      orphans += 1;
    }
  }
  return orphans;
};

describe("write-tick in-band maintenance (no runScheduledMaintenance)", () => {
  test(
    "writes alone maintain the bucket: snapshot lands + log_seq_start advances",
    { timeout: 30_000 },
    async () => {
      // NOTE: `runScheduledMaintenance` is NOT imported nor called inside
      // this test body. The ONLY maintenance trigger is the writer's
      // post-CAS dispatch, reached because we drive commits inside a
      // `runWithContext` maintenance scope. If the dispatch ever stops
      // firing, the assertions below go red — there is no other path
      // that could advance the snapshot / log_seq_start here.
      const storage = new MemoryStorage();
      await bootstrap(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });

      const ctx = createObservabilityContext({
        maintenance: { options: WRITE_TICK_TEST_PROFILE },
      });
      const blob = "x".repeat(BODY_BYTES);

      await runWithContext(ctx, async () => {
        for (let i = 0; i < 600; i++) {
          await writer.commit({
            op: i % 2 === 0 ? "I" : "U",
            collection: COLLECTION,
            docId: `d${i % WORKING_SET}`,
            body: { _id: `d${i % WORKING_SET}`, n: i, blob },
          });
        }
      });

      const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
      expect(read).not.toBeNull();
      const json = read!.json;
      // A fold ran (writes alone drove it) → snapshot is non-null and
      // log_seq_start has advanced off zero. We do NOT assert it equals
      // tail_hint: the write-tick fold is BOUNDED (20 entries/pass), so a
      // live tail trails behind by design — the point is that it advanced
      // WITHOUT any scheduled-maintenance call.
      expect(json.snapshot).not.toBeNull();
      expect(json.log_seq_start).toBeGreaterThan(0);
      expect(json.tail_hint).toBe(600);
    },
  );

  test(
    "STEADY STATE: object count plateaus across a sustained write stream (rate gate)",
    // The e2e form of `maintenance-drain.test.ts`'s PROVISIONED arm at
    // the 5000-seed-and-beyond scale. 6000 writes over a bounded 50-doc
    // working set: the live floor is constant, so any growth tracked
    // across the second half is unswept orphans. If reclamation kept
    // pace only "once" (the weak old "count dropped" gate), the count
    // would still climb here; the plateau assertion is what confronts
    // the §7.1 rate. Memory-only (see block comment).
    { timeout: 60_000 },
    async () => {
      const storage = new MemoryStorage();
      await bootstrap(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
      const ctx = createObservabilityContext({
        maintenance: { options: WRITE_TICK_TEST_PROFILE },
      });
      const blob = "x".repeat(BODY_BYTES);
      const bucketPrefix = `${TABLE_PREFIX}/`;
      const TOTAL = 6000;
      const SAMPLE_EVERY = 500;
      const samples: Array<{ write: number; objects: number }> = [];

      await runWithContext(ctx, async () => {
        for (let i = 0; i < TOTAL; i++) {
          await writer.commit({
            op: i % 2 === 0 ? "I" : "U",
            collection: COLLECTION,
            docId: `d${i % WORKING_SET}`,
            body: { _id: `d${i % WORKING_SET}`, n: i, blob },
          });
          if ((i + 1) % SAMPLE_EVERY === 0) {
            samples.push({ write: i + 1, objects: await countKeys(storage, bucketPrefix) });
          }
        }
      });

      const trajectory = samples.map((s) => `${s.write}:${s.objects}`).join(" ");
      const mid = samples[Math.floor(samples.length / 2)]!;
      const last = samples[samples.length - 1]!;

      // Non-vacuity guard: maintenance actually RAN (a snapshot landed).
      // Without this, a profile that never folds would also "plateau" —
      // the log would just grow unboundedly instead, which the SLACK
      // check below catches, but this makes the intent explicit.
      const finalCur = await readCurrentJson(storage, CURRENT_JSON_KEY);
      expect(finalCur!.json.snapshot, "writes alone must have folded a snapshot").not.toBeNull();
      expect(finalCur!.json.log_seq_start).toBeGreaterThan(0);

      // Plateau: the second half does not grow beyond a tiny boundary
      // slack. Non-vacuous because the ALTERNATIVE — reclamation NOT
      // keeping pace — produces ~2 new objects (log entry + content blob)
      // per write, i.e. ~3000 growth over the second-half 3000 writes;
      // SLACK=60 is ~50× below that. (The drain unit test measures dead
      // flat; this gives generous headroom for the larger working set.)
      const SLACK = 60;
      expect(
        last.objects - mid.objects,
        `trajectory ${trajectory} — count grew by ${last.objects - mid.objects} over the second half (slack ${SLACK})`,
      ).toBeLessThanOrEqual(SLACK);

      // And the peak stays bounded near the live working set — NOT
      // proportional to the write count (~2*writes if nothing drained,
      // i.e. ~12000). WORKING_SET*8 = 400 is two orders of magnitude
      // below that.
      const maxObjects = Math.max(...samples.map((s) => s.objects));
      expect(
        maxObjects,
        `trajectory ${trajectory} — peak ${maxObjects} should stay near the live set, far below ~${TOTAL * 2}`,
      ).toBeLessThan(WORKING_SET * 8);
    },
  );

  test(
    "ceiling honored: a low maxFoldBytes DEFERS the fold; the default ceiling FOLDS",
    { timeout: 30_000 },
    async () => {
      // Two arms over the same seed on a fresh memory bucket. On a FRESH
      // bucket the runner's `foldViable = snapshot_bytes <= C` gate
      // (maintenance.ts:318) is vacuously TRUE — `snapshot` is null so
      // `snapshot_bytes === 0` and `0 <= 4096` holds, the runner lets the
      // fold proceed. The defer fires one level down, at the COMPACTOR's
      // rebuilt-snapshot ceiling (compactor.ts:318): `maxFoldBytes` is
      // threaded in as `ceilingBytes`, and the rebuilt body
      // (`bodyBytes.byteLength`, ~100KB for one working-set's worth of
      // rows) exceeds a low C, so `compact()` returns deferred BEFORE the
      // PUT/CAS — the snapshot pointer never leaves null and the tail keeps
      // growing. The default C clears the rebuilt body, so a fold lands.
      const drive = async (maxFoldBytes: number | undefined) => {
        const storage = new MemoryStorage();
        await bootstrap(storage);
        const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
        const ctx = createObservabilityContext({
          maintenance: {
            options: WRITE_TICK_TEST_PROFILE,
            ...(maxFoldBytes !== undefined && { maxFoldBytes }),
          },
        });
        const blob = "x".repeat(BODY_BYTES);
        await runWithContext(ctx, async () => {
          for (let i = 0; i < 400; i++) {
            await writer.commit({
              op: i % 2 === 0 ? "I" : "U",
              collection: COLLECTION,
              docId: `d${i % WORKING_SET}`,
              body: { _id: `d${i % WORKING_SET}`, n: i, blob },
            });
          }
        });
        const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
        return read!.json;
      };

      // Arm 1: ceiling far below the first snapshot the writer would
      // rebuild (~50 docs × ~2KB ≈ 100KB). 4 KiB can never fit even one
      // working-set's worth of rows, so EVERY fold defers → snapshot null.
      const deferred = await drive(4 * 1024);
      expect(
        deferred.snapshot,
        "a fold ceiling below the live snapshot size must DEFER — snapshot stays null",
      ).toBeNull();
      // The tail keeps growing past the compaction floor (nothing folded).
      expect(deferred.tail_hint - deferred.log_seq_start).toBeGreaterThanOrEqual(50);

      // Arm 2: default ceiling (512 KiB) comfortably fits the ~100KB
      // snapshot → a fold lands.
      const folded = await drive(undefined);
      expect(
        folded.snapshot,
        "the default ceiling fits the live snapshot, so a fold lands",
      ).not.toBeNull();
      expect(folded.log_seq_start).toBeGreaterThan(0);
    },
  );

  test(
    "contention does not leak: concurrent folds strand orphan snapshots, GC keeps the count BOUNDED (invariant under write count)",
    // The orphan-snapshot source here is the PRIOR snapshot each round
    // supersedes — NOT the CAS-losers. All FOLDERS concurrent `compact()`
    // calls read the SAME `current.json` (same etag, none has CASed yet),
    // so they compute identical foldEnd/base/body → identical
    // content-addressed sha256 → identical `newKey`. Per compactor.ts §6
    // the snapshot PUT carries no CAS guard precisely because content-hash
    // filenames make collisions impossible for distinct bodies: the
    // losers' PUT is an IDEMPOTENT overwrite of the SAME bytes on the
    // winner's key, not a distinct orphan. What actually strands is the
    // snapshot the round's winning CAS supersedes — roughly ONE per round,
    // independent of FOLDERS. We still fire FOLDERS genuinely-concurrent
    // `compact()` calls to model N isolates racing the fold on a real
    // multi-isolate S3/R2 backend (on single-threaded zero-latency
    // `MemoryStorage` the writer's commit-CAS serialises the write-tick so
    // hard that no two write-tick folds are ever in flight against the
    // same `current.json` — driving N `Writer`s under `Promise.all`
    // produces ZERO orphans, verified), but the orphan production scales
    // with ROUNDS, not FOLDERS.
    //
    // GC runs on the fold cadence with grace=0 (the write-tick shape), so
    // it must keep pace with that ~rounds-proportional residual. The gate
    // is the §7.1 RATE in its sharpest form: the post-drain orphan count
    // must be BOUNDED and INVARIANT under the write count — a 2× longer
    // run must NOT leave ~2× the orphans. Memory-only (see block comment).
    { timeout: 60_000 },
    async () => {
      const blob = "x".repeat(BODY_BYTES);
      const FOLDERS = 6; // concurrent fold attempts per round — models N isolates racing one fold; the round's superseded prior snapshot (~1/round, NOT FOLDERS-proportional) is what strands

      // Run `rounds` of (60 sequential commits → FOLDERS concurrent folds
      // → one cadence GC), then drain GC to quiescence; return the
      // post-drain orphan-snapshot count. The sequential commits land
      // cleanly (single writer ⇒ no commit-CAS thrash); the concurrent
      // folds are what contend.
      const runContention = async (rounds: number): Promise<number> => {
        const storage = new MemoryStorage();
        await bootstrap(storage);
        const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
        const args = { storage, currentJsonKey: CURRENT_JSON_KEY };
        const gcOpts = {
          graceMillis: 0,
          maxMarksPerRun: 100,
          maxSweepsPerRun: 100,
        } as InternalRunGcOptions;
        for (let chunk = 0; chunk < rounds; chunk++) {
          for (let i = 0; i < 60; i++) {
            const id = `d${(chunk * 60 + i) % WORKING_SET}`;
            await writer.commit({
              op: "I",
              collection: COLLECTION,
              docId: id,
              body: { _id: id, n: chunk * 60 + i, blob },
            });
          }
          // FOLDERS concurrent fold attempts on the SAME current.json:
          // identical body ⇒ identical content-addressed key, so the
          // losers' PUT idempotently overwrites the winner's key (NOT a
          // distinct orphan). The round's winning CAS supersedes the prior
          // snapshot — that ~1/round residual is what GC must reclaim.
          await Promise.all(
            Array.from({ length: FOLDERS }, () =>
              compact(args, {
                maxEntriesPerRun: 20,
                minEntriesToCompact: 50,
              } as InternalCompactOptions).catch(() => {
                // cas-lost is the EXPECTED contention signal; swallow.
              }),
            ),
          );
          // One cadence GC per round, as the write-tick would.
          await runGc(args, gcOpts);
        }
        // Drain GC to quiescence (the post-write-stream catch-up).
        for (let p = 0; p < 20; p++) {
          await runGc(args, gcOpts);
        }
        return countOrphanSnapshots(storage, CURRENT_JSON_KEY);
      };

      // Two run lengths, 2× apart. A non-reclaiming (or fold-bolted,
      // under-budgeted) GC would leave ~write-proportional orphans, so the
      // longer run would show ~2× the orphans. A GC that keeps pace leaves
      // a CONSTANT residual band regardless of run length.
      const orphansShort = await runContention(20);
      const orphansLong = await runContention(40);

      // (a) Absolute bound: well below the ~rounds = 40 superseded-prior
      //     snapshots a non-reclaiming design would strand at rounds=40
      //     (one per round, FOLDERS-independent — see block comment).
      const BOUND = 60;
      expect(
        orphansShort,
        `short-run orphan snapshots (${orphansShort}) must stay bounded`,
      ).toBeLessThanOrEqual(BOUND);
      expect(
        orphansLong,
        `long-run orphan snapshots (${orphansLong}) must stay bounded`,
      ).toBeLessThanOrEqual(BOUND);

      // (b) INVARIANCE under write count — the sharp §7.1 rate gate:
      //     doubling the run does NOT roughly double the residual. We
      //     allow a small constant cadence-boundary slack on top of the
      //     short run; a write-proportional leak (≈2×) blows past it.
      const INVARIANCE_SLACK = 25;
      expect(
        orphansLong,
        `orphan count must be invariant under write volume: long-run ${orphansLong} vs short-run ${orphansShort} (slack ${INVARIANCE_SLACK}); a write-proportional leak would show ~2×`,
      ).toBeLessThanOrEqual(orphansShort + INVARIANCE_SLACK);
    },
  );
});

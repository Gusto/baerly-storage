/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Table<T>`
   declaration); the synthetic seed populates it directly. */

/**
 * Synthetic 5000-entry end-to-end verification gate.
 *
 * The "verifies the cost model" gate:
 * write 5000 entries through `ServerWriter`, run `runScheduledMaintenance`
 * to quiescence, then assert
 *
 *   (a) every `find()` / `all()` / `where()` result is identical before
 *       vs. after compaction (sorted by `_id`),
 *   (b) the bucket object count drops (stale log entries + orphan
 *       content blobs swept by `runGc()`),
 *   (c) `current.json.snapshot !== null` and `log_seq_start` has
 *       advanced to within a small live tail of `next_seq`,
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db, ServerWriter } from "@baerly/server";
import { runScheduledMaintenance } from "@baerly/server/maintenance";
import type {
  InternalMaintenanceOptions,
  InternalRunGcOptions,
} from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";

const APP = "app";
const TENANT = "tenant";
const COLLECTION = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLLECTION}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

interface Ticket extends DocumentData {
  _id: string;
  status: "open" | "closed";
  priority: number;
}

const bootstrap = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "phase5-e2e", claimed_at: "" },
  });
};

const countBucketObjects = async (storage: Storage, prefix: string): Promise<number> => {
  let count = 0;
  for await (const _entry of storage.list(prefix)) {
    count++;
  }
  return count;
};

const sortById = <T extends { _id: string }>(rows: readonly T[]): T[] =>
  [...rows].toSorted((a, b) => {
    if (a._id < b._id) {
      return -1;
    }
    if (a._id > b._id) {
      return 1;
    }
    return 0;
  });

interface Variant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const VARIANTS: readonly Variant[] = [
  {
    label: "memory",
    build: async () => ({ storage: new MemoryStorage() }),
  },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-phase5-e2e-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // Stale tmp dir under a crashed worker shouldn't fail the
            // suite; the OS reaps `/tmp` eventually.
          });
        },
      };
    },
  },
];

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
        // seed even via `commitBatch` (memory ≈ 2s, local-fs ≈ 20s
        // dominated by 10k parallel file PUTs under macOS ulimit).
        // 60s gives 3× headroom on the slower variant.
        { timeout: 60_000 },
        async () => {
          const made = await variant.build();
          cleanup = made.cleanup;
          const { storage } = made;
          await bootstrap(storage);
          const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });

          // ── (1) Seed 5000 entries through the writer. ────────────────
          // Use `commitBatch` rather than 5000 sequential `commit()`
          // calls. Both produce 5000 `LogEntry` rows with deterministic
          // `_id`s — the assertions downstream are about the resulting
          // state, not about the commit pattern. The wall-clock
          // difference matters: each `commit()` reads
          // `[log_seq_start, next_seq)` for integrity validation, so a
          // sequential seed is O(N²) in storage GETs (~12.5M at
          // N=5000). `commitBatch` walks the log once (over an empty
          // range on the first batch), keeping the seed O(N). The
          // memory variant still runs in ~2s; the local-fs variant
          // stays within the ticket's 30s budget instead of blowing
          // past it. The four-adapter `table-api.test.ts` cascade
          // covers single-commit semantics under load.
          const N = 5000;
          const inputs = Array.from({ length: N }, (_, i) => {
            const id = `t-${i.toString().padStart(5, "0")}`;
            const body: Ticket = {
              _id: id,
              status: i % 3 === 0 ? "closed" : "open",
              priority: i % 5,
            };
            return { op: "I" as const, collection: COLLECTION, docId: id, body };
          });
          await writer.commitBatch(inputs);

          // ── (2) Snapshot the read results BEFORE compaction. ─────────
          const db = Db.create({ storage, app: APP, tenant: TENANT });
          const tbl = db.table<Ticket>(COLLECTION);
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
            next_seq: number;
            log_seq_start?: number;
          };
          expect(json.next_seq).toBe(N);
          expect(json.snapshot).not.toBeNull();
          // The compactor folds the entire live tail in one unbounded
          // pass; the writer minted nothing new in between, so
          // log_seq_start should equal next_seq. Allow a small slack so
          // a future change to the compactor's lag-window default
          // doesn't break the gate.
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
          const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });

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
          const tbl = db.table<Ticket>(COLLECTION);
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

/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the seed populates it directly. */

/**
 * main-10 Task 1: reproduce today's SILENT fold stall and its recovery
 * cases on `memory` + `local-fs`.
 *
 * Every test here pins CURRENT behavior and passes on main. The fold gate
 * (`snapshotBytes <= C && snapshotRows + maxFoldEntriesPerPass <= E`, then
 * compact()'s rebuild gate) is evaluated against the STORED
 * `snapshot_bytes` / `snapshot_rows`, which only a landed fold updates. So a
 * stalled collection cannot be un-stalled by deleting or shrinking rows:
 * those land in the tail, which the gate never looks at. Main-10 Task 2
 * (growth-only refusal, executable recovery) flips the "stays stalled" /
 * "silent" assertions below; the host-change and per-pass recoveries are the
 * routes that already work and must keep working.
 *
 * Fixtures are tiny: a custom `MaintenanceProfile` with E=20 rows, a
 * 5-entry pass and a large C, so no test writes more than a few dozen rows.
 * Folds are driven by explicit `runBoundedMaintenance` ticks whose
 * `mean_entry_bytes` is re-stamped (the compactor overwrites it with the
 * real, tiny mean, which would otherwise starve the ratio trigger and
 * confound the stall with a trigger miss).
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  casUpdateCurrentJson,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  type Storage,
} from "@baerly/protocol";
import type { MaintenanceProfile } from "@baerly/server/maintenance";
import {
  BIG_C,
  commit,
  drain,
  E,
  inserts,
  PASS,
  readGets,
  readIds,
  type Signals,
  SMALL,
  state,
  tick,
} from "../fixtures/fold-stall-harness.ts";
import {
  bootstrap as bootstrapCurrentJson,
  CURRENT_JSON_KEY,
  makeVariants,
} from "../fixtures/maintenance-harness.ts";

const VARIANTS = makeVariants("baerly-fold-stall-");

describe("main-10: fold stall (current behavior)", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const c of cleanups) {
          await c();
        }
        cleanups = [];
      });

      const fresh = async (): Promise<Storage> => {
        const made = await variant.build();
        if (made.cleanup) {
          cleanups.push(made.cleanup);
        }
        await bootstrapCurrentJson(made.storage, "fold-stall", MAINTENANCE_MIN_LIVE_BYTES);
        return made.storage;
      };

      /** 16 live rows folded: `snapshotRows + PASS` = 21 > E, so the gate is closed. */
      const stallAtRows = async (): Promise<Storage> => {
        const storage = await fresh();
        await commit(storage, inserts(0, 16));
        await drain(storage, SMALL);
        await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 16, rows: 16 });
        return storage;
      };

      // ── 1. Stall ───────────────────────────────────────────────────
      describe("stall (Task 2 flips: growing writes get CapacityExceeded instead of succeeding)", () => {
        test("rows arm: folds stop, log_seq_start freezes, the tail grows, writes keep succeeding, and only one fold_deferred is emitted", async () => {
          const storage = await stallAtRows();
          const signals: Signals = { records: [] };

          // 10 more inserts: every one is accepted (no refusal), live rows
          // (26) are now past E (20).
          await commit(storage, inserts(16, 26));
          for (let k = 0; k < 4; k++) {
            await tick(storage, SMALL, { signals });
          }

          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 26, rows: 16 });
          await expect(readIds(storage)).resolves.toHaveLength(26);
          // Silent: four deferred ticks, one structured record (rate-limited
          // by MAINTENANCE_WARN_INTERVAL_WRITES via `last_warned_seq`).
          expect(signals.records).toHaveLength(1);
          expect(signals.records[0]).toMatchObject({
            gate: "pre-fold",
            dimension: "rows",
            snapshot_rows: 16,
            ceiling_rows: E,
            max_fold_entries_per_pass: PASS,
            log_seq_start: 16,
          });

          // And it stays stalled as the tail keeps growing.
          await commit(storage, inserts(26, 40));
          await tick(storage, SMALL, { signals });
          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 40, rows: 16 });
        });

        test("bytes arm: stored snapshot_bytes > C closes the gate and the tail grows", async () => {
          const storage = await fresh();
          await commit(storage, inserts(0, 10, "x".repeat(200)));
          await drain(storage, SMALL);
          const folded = await state(storage);
          expect(folded).toMatchObject({ start: 10, rows: 10 });
          expect(folded.bytes).toBeGreaterThan(2000);

          const tight: MaintenanceProfile = { ...SMALL, maxFoldBytes: folded.bytes - 1 };
          const signals: Signals = { records: [] };
          await commit(storage, inserts(10, 15, "x".repeat(200)));
          await tick(storage, tight, { signals });
          await commit(storage, inserts(15, 18, "x".repeat(200)));
          await tick(storage, tight, { signals });

          await expect(state(storage)).resolves.toMatchObject({ start: 10, tail: 18 });
          expect(signals.records).toHaveLength(1);
          expect(signals.records[0]).toMatchObject({
            gate: "pre-fold",
            dimension: "bytes",
            ceiling_bytes: folded.bytes - 1,
          });
        });

        test("rebuild gate (bytes): stored snapshot_bytes passes, the rebuilt snapshot is over C, compact() defers", async () => {
          const storage = await fresh();
          await commit(storage, inserts(0, 10, "x".repeat(200)));
          await drain(storage, SMALL);
          const folded = await state(storage);

          // C leaves 10 bytes of headroom over the STORED figure, so the
          // runner's gate is open; five more 200 B rows blow the rebuilt body.
          const nearC: MaintenanceProfile = { ...SMALL, maxFoldBytes: folded.bytes + 10 };
          const signals: Signals = { records: [] };
          await commit(storage, inserts(10, 15, "x".repeat(200)));
          await tick(storage, nearC, { signals });

          await expect(state(storage)).resolves.toMatchObject({
            start: 10,
            tail: 15,
            bytes: folded.bytes,
          });
          expect(signals.records).toHaveLength(1);
          expect(signals.records[0]).toMatchObject({ gate: "rebuild", dimension: "bytes" });
        });

        test("rebuild gate (rows): an under-reported snapshot_rows passes the pre-fold gate and compact() defers on the rebuilt row count", async () => {
          const storage = await stallAtRows();
          // Simulate stale accounting: stored rows say 0, the snapshot holds 16.
          await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
            ...c,
            snapshot_rows: 0,
          }));
          await commit(storage, inserts(16, 21));
          const signals: Signals = { records: [] };
          await tick(storage, SMALL, { signals });

          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 21 });
          expect(signals.records[0]).toMatchObject({ gate: "rebuild", dimension: "rows" });
        });
      });

      // ── 2. Conservative gate (G2) ──────────────────────────────────
      describe("conservative gate G2 (Task 2 flips: an update/delete fold whose output fits must be allowed)", () => {
        test("an update-only tail whose output (16 rows) fits E is still deferred; a larger E folds it with rows unchanged", async () => {
          const storage = await stallAtRows();
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({ op: "U" as const, i, n: 99 })),
          );
          const signals: Signals = { records: [] };
          await tick(storage, SMALL, { signals });
          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 21, rows: 16 });
          expect(signals.records[0]).toMatchObject({ gate: "pre-fold", dimension: "rows" });

          // Same tail, E = 21: gate opens and the fold lands with 16 rows.
          await tick(storage, { ...SMALL, maxFoldRows: 21 });
          await expect(state(storage)).resolves.toMatchObject({ start: 21, rows: 16 });
        });

        test("a delete-only tail (output 11 rows) is deferred; a larger E folds it and rows shrink", async () => {
          const storage = await stallAtRows();
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({ op: "D" as const, i })),
          );
          const signals: Signals = { records: [] };
          await tick(storage, SMALL, { signals });
          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 21, rows: 16 });
          expect(signals.records).toHaveLength(1);

          await tick(storage, { ...SMALL, maxFoldRows: 21 });
          await expect(state(storage)).resolves.toMatchObject({ start: 21, rows: 11 });
        });
      });

      // ── 3. Recovery attempts ───────────────────────────────────────
      describe("recovery (which routes work today)", () => {
        test("deleting rows after a rows stall does NOT resume the fold: stored snapshot_rows only moves when a fold lands", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(16, 26));
          await tick(storage, SMALL);
          // Delete 20 of the 26 live rows. Live rows (6) are far under E.
          await commit(
            storage,
            Array.from({ length: 20 }, (_, i) => ({ op: "D" as const, i })),
          );
          await expect(readIds(storage)).resolves.toHaveLength(6);
          await expect(drain(storage, SMALL)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 16, tail: 46, rows: 16 });
        });

        test("shrinking updates after a bytes stall do NOT resume the fold", async () => {
          const storage = await fresh();
          await commit(storage, inserts(0, 10, "x".repeat(200)));
          await drain(storage, SMALL);
          const folded = await state(storage);
          const tight: MaintenanceProfile = { ...SMALL, maxFoldBytes: folded.bytes - 1 };
          // Rewrite every row without its pad: live bytes are far under C.
          await commit(
            storage,
            Array.from({ length: 10 }, (_, i) => ({ op: "U" as const, i, n: 1 })),
          );
          await expect(drain(storage, tight)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({
            start: 10,
            tail: 20,
            bytes: folded.bytes,
          });
        });

        test("the prerequisite read costs O(stalled tail) GETs and only grows with writes; a host-change drain resets it", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(16, 26));
          await tick(storage, SMALL);

          const stalled = await readGets(storage);
          await commit(storage, inserts(26, 40));
          await tick(storage, SMALL);
          const grown = await readGets(storage);
          expect(grown - stalled).toBeGreaterThanOrEqual(14);

          // The same bucket under a bigger host drains the whole tail; the
          // same read is then flat.
          await drain(storage, MAINTENANCE_PROFILE_NODE);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 40, rows: 40 });
          await expect(readGets(storage)).resolves.toBeLessThan(stalled);
        });

        test("deletes plus a host change: the drain folds the deletes and rows shrink to the live set", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(16, 26));
          await commit(
            storage,
            Array.from({ length: 20 }, (_, i) => ({ op: "D" as const, i })),
          );
          // CF-paid E with the small 5-entry pass: the 30-entry tail drains in 6 passes.
          const paidish: MaintenanceProfile = {
            ...MAINTENANCE_PROFILE_CF_PAID,
            maxFoldEntriesPerPass: PASS,
          };
          await expect(drain(storage, paidish)).resolves.toBe(6);
          await expect(state(storage)).resolves.toMatchObject({ start: 46, tail: 46, rows: 6 });
        });

        test("an oversized intermediate prefix blocks the shrink behind it; a larger E drains through to the shrunk result", async () => {
          const storage = await fresh();
          await commit(storage, inserts(0, 10));
          await drain(storage, SMALL);
          // 15 inserts peak at 25 rows (> E), then 15 deletes back to 10.
          await commit(storage, inserts(10, 25));
          await commit(
            storage,
            Array.from({ length: 15 }, (_, i) => ({ op: "D" as const, i: 10 + i })),
          );
          await drain(storage, SMALL);
          // Folds land at rows 15 and 20, then rows 20 + PASS > E closes the
          // gate while the 15 shrinking deletes (and 5 inserts) wait behind it.
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 40, rows: 20 });

          // E equal to the peak (25) is not enough: the gate wants peak + PASS
          // of headroom, so the fold lands the 25-row prefix and stops again.
          await drain(storage, { ...SMALL, maxFoldRows: 25 });
          await expect(state(storage)).resolves.toMatchObject({ start: 25, tail: 40, rows: 25 });

          await drain(storage, { ...SMALL, maxFoldRows: 30 });
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 40, rows: 10 });
        });

        test("a smaller per-pass setting reopens the gate only up to E, then stalls again", async () => {
          const storage = await stallAtRows(); // rows 16: 16 + 5 > 20
          await commit(storage, inserts(16, 40));

          const pass4: MaintenanceProfile = { ...SMALL, maxFoldEntriesPerPass: 4 };
          await tick(storage, pass4);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, rows: 20 });

          // rows 20: even a 1-entry pass is over E, so the fold is stuck for good.
          const pass1: MaintenanceProfile = { ...SMALL, maxFoldEntriesPerPass: 1 };
          await expect(drain(storage, pass1)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 40, rows: 20 });
        });

        test("a bytes stall clears when C is raised (profile or BAERLY_MAINTENANCE_MAX_FOLD_BYTES arg) and the tail drains", async () => {
          const storage = await fresh();
          await commit(storage, inserts(0, 10, "x".repeat(200)));
          await drain(storage, SMALL);
          const folded = await state(storage);
          const tight: MaintenanceProfile = { ...SMALL, maxFoldBytes: folded.bytes - 1 };
          await commit(storage, inserts(10, 18, "x".repeat(200)));
          await expect(drain(storage, tight)).resolves.toBe(0);

          // Env-style override, as the adapters thread it.
          await expect(drain(storage, tight, { maxFoldBytes: BIG_C })).resolves.toBe(2);
          await expect(state(storage)).resolves.toMatchObject({ start: 18, tail: 18, rows: 18 });
        });

        test("a rows stall clears under a larger host profile (node), which drains the tail in one pass", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(16, 40));
          await tick(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 16 });

          await expect(drain(storage, MAINTENANCE_PROFILE_NODE)).resolves.toBe(1);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, rows: 40 });
          await expect(readIds(storage)).resolves.toHaveLength(40);
        });

        test("returning to the small host after a larger host folded past E leaves the bucket stalled (stored rows > E)", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(16, 40));
          await drain(storage, MAINTENANCE_PROFILE_NODE);
          await commit(storage, inserts(40, 45));
          await expect(drain(storage, SMALL)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 45, rows: 40 });
        });
      });
    });
  }
});

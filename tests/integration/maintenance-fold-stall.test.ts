/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the seed populates it directly. */

/**
 * main-10 Task 1: reproduce today's SILENT fold stall and its recovery
 * cases on `memory` + `local-fs`.
 *
 * Every test here pins CURRENT behavior. The runner's gate
 * (`snapshotBytes <= C && snapshotRows <= E`) reads the STORED
 * `snapshot_bytes` / `snapshot_rows`, which only a landed fold updates;
 * compact() then folds the longest prefix of the tail that keeps the
 * rebuilt snapshot within E rows, stopping before the first entry that
 * would add a row past E. Update and delete tails therefore fold right up
 * to E, and a delete tail drains in place at E. The stall is an entry that
 * adds a row at E (or stored bytes > C): the fold is a prefix, so deletes
 * and shrinks queued behind that entry cannot drain. Main-10 Task 2
 * (growth-only refusal, executable recovery) flips the "stays stalled" /
 * "silent" assertions below; the host-change recoveries are the routes that
 * already work and must keep working.
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
import type { MaintenanceProfile } from "@baerly/server/_internal/maintenance";
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

      /** `n` live rows folded on SMALL, empty tail. */
      const foldedRows = async (n: number): Promise<Storage> => {
        const storage = await fresh();
        await commit(storage, inserts(0, n));
        await drain(storage, SMALL);
        await expect(state(storage)).resolves.toMatchObject({ start: n, tail: n, rows: n });
        return storage;
      };

      /** E live rows folded, empty tail: the next insert cannot fold. */
      const stallAtRows = () => foldedRows(E);

      // ── 1. Stall ───────────────────────────────────────────────────
      describe("stall (Task 2 flips: growing writes get CapacityExceeded instead of succeeding)", () => {
        test("rows arm: folds stop, log_seq_start freezes, the tail grows, writes keep succeeding, and only one fold_deferred is emitted", async () => {
          const storage = await stallAtRows();
          const signals: Signals = { records: [] };

          // 10 more inserts: every one is accepted (no refusal), live rows
          // (30) are now past E (20).
          await commit(storage, inserts(20, 30));
          for (let k = 0; k < 4; k++) {
            await tick(storage, SMALL, { signals });
          }

          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 30, rows: 20 });
          await expect(readIds(storage)).resolves.toHaveLength(30);
          // Silent: four deferred ticks, one structured record (rate-limited
          // by MAINTENANCE_WARN_INTERVAL_WRITES via `last_warned_seq`).
          expect(signals.records).toHaveLength(1);
          // compact() runs (stored rows = E is admitted) and stops before
          // the first insert, so the deferral comes from the rebuild gate.
          expect(signals.records[0]).toMatchObject({
            gate: "rebuild",
            dimension: "rows",
            snapshot_rows: 20,
            ceiling_rows: E,
            log_seq_start: 20,
          });

          // And it stays stalled as the tail keeps growing.
          await commit(storage, inserts(30, 44));
          await tick(storage, SMALL, { signals });
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 44, rows: 20 });
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
          // Simulate stale accounting: stored rows say 0, the snapshot holds 20.
          await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
            ...c,
            snapshot_rows: 0,
          }));
          await commit(storage, inserts(20, 25));
          const signals: Signals = { records: [] };
          await tick(storage, SMALL, { signals });

          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 25 });
          expect(signals.records[0]).toMatchObject({ gate: "rebuild", dimension: "rows" });
        });
      });

      // ── 2. Row-exact fold (G4) ─────────────────────────────────────
      describe("row-exact fold G4: compact() folds the longest prefix within E", () => {
        test("at 16 rows an update-only full pass folds in one tick, with rows unchanged", async () => {
          const storage = await foldedRows(16);
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({ op: "U" as const, i, n: 99 })),
          );
          const signals: Signals = { records: [] };
          await tick(storage, SMALL, { signals });
          await expect(state(storage)).resolves.toMatchObject({ start: 21, tail: 21, rows: 16 });
          expect(signals.records).toHaveLength(0);
        });

        test("at E - 1 an update-only tail folds in one tick: no per-entry rebuilds near E", async () => {
          const storage = await foldedRows(E - 1);
          await commit(
            storage,
            Array.from({ length: 3 }, (_, i) => ({ op: "U" as const, i, n: 99 })),
          );
          await tick(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({
            start: E + 2,
            tail: E + 2,
            rows: E - 1,
          });
        });

        test("at E a delete-only tail drains in place and rows shrink", async () => {
          const storage = await foldedRows(E);
          await commit(
            storage,
            Array.from({ length: PASS }, (_, i) => ({ op: "D" as const, i })),
          );
          await expect(drain(storage, SMALL)).resolves.toBe(1);
          await expect(state(storage)).resolves.toMatchObject({
            start: E + PASS,
            tail: E + PASS,
            rows: E - PASS,
          });
        });

        test("a mixed pass at E - 1 folds up to the insert that would pass E", async () => {
          const storage = await foldedRows(E - 1);
          // U (rows hold), I (rows reach E), I (would be E + 1: stop), D.
          await commit(storage, [
            { op: "U" as const, i: 0, n: 99 },
            ...inserts(E - 1, E + 1),
            { op: "D" as const, i: 1 },
          ]);
          await tick(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({
            start: E + 1,
            tail: E + 3,
            rows: E,
          });
        });

        test("inserts fold exactly up to E, then stop; a 1-entry pass cannot go further", async () => {
          const storage = await foldedRows(16);
          await commit(storage, inserts(16, 40));

          await tick(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, rows: 20 });

          // rows 20 and an insert at the head of the tail: no pass size helps.
          const pass1: MaintenanceProfile = { ...SMALL, maxFoldEntriesPerPass: 1 };
          await expect(drain(storage, pass1)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 40, rows: 20 });
        });
      });

      // ── 3. Recovery attempts ───────────────────────────────────────
      describe("recovery (which routes work today)", () => {
        test("deleting rows behind an insert stalled at E does NOT resume the fold: the fold is a prefix", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(20, 30));
          await tick(storage, SMALL);
          // Delete 20 of the 30 live rows. Live rows (10) are far under E.
          await commit(
            storage,
            Array.from({ length: 20 }, (_, i) => ({ op: "D" as const, i })),
          );
          await expect(readIds(storage)).resolves.toHaveLength(10);
          await expect(drain(storage, SMALL)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 50, rows: 20 });
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
          await commit(storage, inserts(20, 30));
          await tick(storage, SMALL);

          const stalled = await readGets(storage);
          await commit(storage, inserts(30, 44));
          await tick(storage, SMALL);
          const grown = await readGets(storage);
          expect(grown - stalled).toBeGreaterThanOrEqual(14);

          // The same bucket under a bigger host drains the whole tail; the
          // same read is then flat.
          await drain(storage, MAINTENANCE_PROFILE_NODE);
          await expect(state(storage)).resolves.toMatchObject({ start: 44, tail: 44, rows: 44 });
          await expect(readGets(storage)).resolves.toBeLessThan(stalled);
        });

        test("deletes plus a host change: the drain folds the deletes and rows shrink to the live set", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(20, 30));
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
          await expect(state(storage)).resolves.toMatchObject({ start: 50, tail: 50, rows: 10 });
        });

        test("an oversized intermediate prefix blocks the shrink behind it; E at the peak drains through to the shrunk result", async () => {
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
          // Folds stop at rows = E; the 21st insert heads the tail, so the 15
          // shrinking deletes (and 4 more inserts) wait behind it.
          await expect(state(storage)).resolves.toMatchObject({ start: 20, tail: 40, rows: 20 });

          // E equal to the peak (25) is enough: every prefix stays within it.
          await drain(storage, { ...SMALL, maxFoldRows: 25 });
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 40, rows: 10 });
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
          await commit(storage, inserts(20, 40));
          await tick(storage, SMALL);
          await expect(state(storage)).resolves.toMatchObject({ start: 20 });

          await expect(drain(storage, MAINTENANCE_PROFILE_NODE)).resolves.toBe(1);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, rows: 40 });
          await expect(readIds(storage)).resolves.toHaveLength(40);
        });

        test("returning to the small host after a larger host folded past E leaves the bucket stalled (stored rows > E)", async () => {
          const storage = await stallAtRows();
          await commit(storage, inserts(20, 40));
          await drain(storage, MAINTENANCE_PROFILE_NODE);
          await commit(storage, inserts(40, 45));
          await expect(drain(storage, SMALL)).resolves.toBe(0);
          await expect(state(storage)).resolves.toMatchObject({ start: 40, tail: 45, rows: 40 });
        });
      });
    });
  }
});
